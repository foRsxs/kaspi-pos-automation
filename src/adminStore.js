import crypto from 'node:crypto';
import './encryptionStore.js';
import { db, transaction } from './database.js';
import { encryptSecret, decryptSecret } from './crypto.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const validApiKey = (value) => typeof value === 'string' && /^[\x21-\x7e]{32,256}$/.test(value);
const adminError = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const hashPassword = async (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  return `scrypt-v1:${salt}:${hash.toString('hex')}`;
};
db.exec(`
  CREATE TABLE IF NOT EXISTS server_admin (
    id INTEGER PRIMARY KEY CHECK(id=1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL,
    temporary_password_encrypted TEXT,
    api_key_hash TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    api_key_managed INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS admin_auth_limits (
    client TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
const adminRow = () => db.prepare('SELECT * FROM server_admin WHERE id=1').get();
const assertUniqueApiKey = (value) => {
  if (!validApiKey(value))
    throw adminError('ADMIN_API_KEY должен содержать 32–256 печатных ASCII-символов без пробелов');
  if (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get() &&
    db.prepare('SELECT 1 FROM projects WHERE key_hash=?').get(sha256(value))
  ) {
    throw adminError('ADMIN_API_KEY совпадает с API-ключом проекта. Задайте отдельный ключ администратора', 409);
  }
};
const envKey = process.env.ADMIN_API_KEY || null;
const initial = adminRow();
if (!initial) {
  const apiKey = envKey || crypto.randomBytes(32).toString('base64url');
  assertUniqueApiKey(apiKey);
  const password = crypto.randomBytes(18).toString('base64url');
  const hash = await hashPassword(password);
  transaction(() => {
    if (adminRow()) return;
    db.prepare(
      `INSERT INTO server_admin(id,username,password_hash,must_change_password,temporary_password_encrypted,api_key_hash,api_key_encrypted,api_key_managed)
      VALUES (1,'admin',?,1,?,?,?,?)`,
    ).run(
      hash,
      encryptSecret(Buffer.from(password)),
      sha256(apiKey),
      encryptSecret(Buffer.from(apiKey)),
      envKey ? 0 : 1,
    );
  });
} else if (!initial.api_key_managed && envKey) {
  // Preserve ENV compatibility until the owner explicitly takes key management
  // over in the UI. Once rotated there, stale ENV can never resurrect an old key.
  assertUniqueApiKey(envKey);
  if (sha256(envKey) !== initial.api_key_hash) {
    db.prepare('UPDATE server_admin SET api_key_hash=?,api_key_encrypted=? WHERE id=1').run(
      sha256(envKey),
      encryptSecret(Buffer.from(envKey)),
    );
  }
}

export const getAdminApiKeyHashHex = () => adminRow().api_key_hash;
export const isAdminApiKey = (key) =>
  validApiKey(key) &&
  crypto.timingSafeEqual(Buffer.from(sha256(key), 'hex'), Buffer.from(getAdminApiKeyHashHex(), 'hex'));
export const adminProfile = () => {
  const row = adminRow();
  return { username: row.username, mustChangePassword: Boolean(row.must_change_password) };
};
export const verifyAdminPassword = async (password) => {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) return false;
  const stored = adminRow().password_hash;
  const [version, salt] = stored.split(':');
  if (version !== 'scrypt-v1') throw new Error('Неподдерживаемый формат пароля администратора');
  const digest = await hashPassword(password, salt);
  return stored === adminRow().password_hash && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(stored));
};
export const changeAdminPassword = async (password) => {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw adminError('Новый пароль должен содержать от 12 до 128 символов');
  if (await verifyAdminPassword(password)) throw adminError('Новый пароль должен отличаться от текущего');
  const hash = await hashPassword(password);
  transaction(() => {
    db.prepare(
      'UPDATE server_admin SET password_hash=?,must_change_password=0,temporary_password_encrypted=NULL WHERE id=1',
    ).run(hash);
    db.prepare('DELETE FROM admin_sessions').run();
  });
};
export const resetAdminPassword = async () => {
  const password = crypto.randomBytes(18).toString('base64url');
  const hash = await hashPassword(password);
  transaction(() => {
    db.prepare(
      'UPDATE server_admin SET password_hash=?,must_change_password=1,temporary_password_encrypted=? WHERE id=1',
    ).run(hash, encryptSecret(Buffer.from(password)));
    db.prepare('DELETE FROM admin_sessions').run();
    db.prepare('DELETE FROM admin_auth_limits').run();
  });
  return password;
};
export const logInitialAdminPassword = () => {
  const row = adminRow();
  if (!row.must_change_password) return;
  const password = decryptSecret(row.temporary_password_encrypted).toString('utf8');
  console.warn(`[ADMIN SETUP] Логин: admin. Временный пароль: ${password}`);
  console.warn('[ADMIN SETUP] Войдите в админку и задайте постоянный пароль. После смены временный пароль удаляется.');
};
export const revealAdminApiKey = () => {
  const row = adminRow();
  const apiKey = decryptSecret(row.api_key_encrypted).toString('utf8');
  if (!isAdminApiKey(apiKey)) throw new Error('Сохранённый административный API-ключ повреждён');
  return apiKey;
};
export const rotateAdminApiKey = (requestedKey) => {
  const apiKey =
    requestedKey === undefined || requestedKey === '' ? crypto.randomBytes(32).toString('base64url') : requestedKey;
  assertUniqueApiKey(apiKey);
  if (isAdminApiKey(apiKey)) throw adminError('Новый API-ключ должен отличаться от текущего');
  db.prepare('UPDATE server_admin SET api_key_hash=?,api_key_encrypted=?,api_key_managed=1 WHERE id=1').run(
    sha256(apiKey),
    encryptSecret(Buffer.from(apiKey)),
  );
  return apiKey;
};

const SESSION_TTL = 12 * 60 * 60 * 1000;
export const createAdminSession = () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL;
  transaction(() => {
    db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO admin_sessions(token_hash,csrf_token,expires_at) VALUES (?,?,?)').run(
      sha256(token),
      csrfToken,
      expiresAt,
    );
    db.prepare(
      'DELETE FROM admin_sessions WHERE token_hash NOT IN (SELECT token_hash FROM admin_sessions ORDER BY expires_at DESC,rowid DESC LIMIT 10)',
    ).run();
  });
  return { token, csrfToken, expiresAt };
};
export const getAdminSession = (token) => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db
    .prepare('SELECT token_hash,csrf_token,expires_at FROM admin_sessions WHERE token_hash=? AND expires_at>?')
    .get(sha256(token), Date.now());
  return row
    ? { ...adminProfile(), csrfToken: row.csrf_token, tokenHash: row.token_hash, expiresAt: row.expires_at }
    : null;
};
export const removeAdminSession = (tokenHash) =>
  db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(tokenHash);
export const checkPasswordRateLimit = (client) => {
  const id = sha256(client || 'local');
  const now = Date.now();
  db.prepare('DELETE FROM admin_auth_limits WHERE expires_at<=?').run(now);
  const current = db.prepare('SELECT attempts,expires_at FROM admin_auth_limits WHERE client=?').get(id);
  if (current?.attempts >= 5)
    throw Object.assign(adminError('Слишком много попыток. Повторите через 15 минут.', 429), {
      retryAfter: Math.max(1, Math.ceil((current.expires_at - now) / 1000)),
    });
  db.prepare(
    `INSERT INTO admin_auth_limits(client,attempts,expires_at) VALUES (?,1,?)
    ON CONFLICT(client) DO UPDATE SET attempts=attempts+1`,
  ).run(id, now + 15 * 60 * 1000);
};
export const clearPasswordRateLimit = (client) =>
  db.prepare('DELETE FROM admin_auth_limits WHERE client=?').run(sha256(client || 'local'));
