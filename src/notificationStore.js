import crypto from 'node:crypto';
import { isIP } from 'node:net';
import './encryptionStore.js';
import { db, transaction } from './database.js';
import { decryptSecret, encryptSecret } from './crypto.js';

const RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 900_000, 3_600_000];
const MAX_ATTEMPTS = 6;
const TEST_COOLDOWN_MS = 30_000;
const SAFE_DELIVERY_ERROR =
  'Не удалось отправить уведомление. Проверьте настройки SMTP и доступность почтового сервера.';

export class NotificationStoreError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.name = 'NotificationStoreError';
    this.status = status;
    this.statusCode = status;
    if (code) this.code = code;
  }
}

const storeError = (message, status, code) => new NotificationStoreError(message, status, code);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const hasControlCharacters = (value) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

const cleanText = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  return [...value]
    .map((character) => (hasControlCharacters(character) ? ' ' : character))
    .join('')
    .trim()
    .slice(0, maxLength);
};

db.exec(`
  CREATE TABLE IF NOT EXISTS notification_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    email TEXT NOT NULL DEFAULT '',
    smtp_host TEXT NOT NULL DEFAULT '',
    smtp_port INTEGER NOT NULL DEFAULT 587 CHECK(smtp_port BETWEEN 1 AND 65535),
    smtp_security TEXT NOT NULL DEFAULT 'starttls' CHECK(smtp_security IN ('starttls','tls')),
    smtp_user TEXT NOT NULL DEFAULT '',
    smtp_password_encrypted TEXT,
    smtp_from TEXT NOT NULL DEFAULT '',
    last_sent_at TEXT,
    last_error TEXT,
    test_allowed_at INTEGER
  );
  INSERT OR IGNORE INTO notification_settings(id) VALUES (1);

  CREATE TABLE IF NOT EXISTS connection_notifications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    lost_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','cancelled','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 6),
    next_attempt_at INTEGER NOT NULL,
    org_name TEXT,
    phone TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS connection_notifications_due_idx
    ON connection_notifications(status,next_attempt_at,created_at);
  CREATE INDEX IF NOT EXISTS connection_notifications_project_idx
    ON connection_notifications(project_id,status);
`);

const settingsRow = () => db.prepare('SELECT * FROM notification_settings WHERE id=1').get();
const hasPassword = (row) => typeof row.smtp_password_encrypted === 'string' && row.smtp_password_encrypted.length > 0;

const validAddress = (value) => {
  if (typeof value !== 'string' || value.length > 254 || hasControlCharacters(value) || /[,<>"\\;]/.test(value))
    return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at !== value.indexOf('@') || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) => label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  );
};

const validHost = (value) => {
  if (typeof value !== 'string' || value.length > 253) return false;
  if (isIP(value)) return true;
  if (
    /\s/.test(value) ||
    value.includes('/') ||
    value.includes(':') ||
    value.includes('@') ||
    value.includes('?') ||
    value.includes('#')
  )
    return false;
  if (/^[0-9.]+$/.test(value)) {
    const parts = value.split('.');
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  const labels = value.replace(/\.$/, '').split('.');
  return (
    labels.length >= 1 &&
    labels.every(
      (label) => label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  );
};

const configured = (row) =>
  validAddress(row.email) &&
  validHost(row.smtp_host) &&
  Number.isInteger(row.smtp_port) &&
  row.smtp_port >= 1 &&
  row.smtp_port <= 65535 &&
  ['starttls', 'tls'].includes(row.smtp_security) &&
  (row.smtp_port !== 465 || row.smtp_security === 'tls') &&
  validAddress(row.smtp_from) &&
  (!row.smtp_user || hasPassword(row));

const publicSettings = (row) => ({
  enabled: Boolean(row.enabled),
  email: row.email,
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpSecurity: row.smtp_security,
  smtpUser: row.smtp_user,
  smtpFrom: row.smtp_from,
  hasSmtpPassword: hasPassword(row),
  configured: configured(row),
  lastSentAt: row.last_sent_at,
  lastError: row.last_error,
});

export const getNotificationSettings = () => publicSettings(settingsRow());

// This credential-bearing view is only for the SMTP worker. Never use it in API responses.
export const getNotificationDeliverySettings = () => {
  const row = settingsRow();
  return {
    ...publicSettings(row),
    smtpPassword: hasPassword(row) ? decryptSecret(row.smtp_password_encrypted).toString('utf8') : '',
  };
};

const readPatchString = (input, key, previous, maxLength = 254) => {
  if (!Object.hasOwn(input, key)) return previous;
  const value = input[key];
  if (typeof value !== 'string' || value.length > maxLength || hasControlCharacters(value)) {
    throw storeError(`Поле ${key} имеет недопустимое значение`);
  }
  return value.trim();
};

export const updateNotificationSettings = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw storeError('Переданы некорректные настройки уведомлений');
  const allowedFields = new Set([
    'enabled',
    'email',
    'smtpHost',
    'smtpPort',
    'smtpSecurity',
    'smtpUser',
    'smtpPassword',
    'smtpFrom',
  ]);
  if (Object.keys(input).some((key) => !allowedFields.has(key)))
    throw storeError('Передано неизвестное поле настройки');

  const current = settingsRow();
  const next = {
    enabled: current.enabled,
    email: readPatchString(input, 'email', current.email),
    smtpHost: readPatchString(input, 'smtpHost', current.smtp_host),
    smtpPort: current.smtp_port,
    smtpSecurity: readPatchString(input, 'smtpSecurity', current.smtp_security),
    smtpUser: readPatchString(input, 'smtpUser', current.smtp_user, 256),
    smtpFrom: readPatchString(input, 'smtpFrom', current.smtp_from),
  };
  if (Object.hasOwn(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw storeError('Поле enabled должно быть true или false');
    next.enabled = input.enabled;
  }
  if (Object.hasOwn(input, 'smtpPort')) {
    if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535)
      throw storeError('Порт SMTP должен быть целым числом от 1 до 65535');
    next.smtpPort = input.smtpPort;
  }
  if (!['starttls', 'tls'].includes(next.smtpSecurity)) throw storeError('Выберите STARTTLS или TLS');
  if (next.email && !validAddress(next.email)) throw storeError('Укажите один корректный адрес получателя');
  if (next.smtpFrom && !validAddress(next.smtpFrom)) throw storeError('Укажите один корректный адрес отправителя');
  if (next.smtpHost && !validHost(next.smtpHost)) throw storeError('Укажите SMTP host без URL и порта');

  let suppliedPassword;
  if (Object.hasOwn(input, 'smtpPassword')) {
    if (
      typeof input.smtpPassword !== 'string' ||
      input.smtpPassword.length > 2048 ||
      hasControlCharacters(input.smtpPassword)
    ) {
      throw storeError('Поле smtpPassword имеет недопустимое значение');
    }
    suppliedPassword = input.smtpPassword;
  }
  const smtpIdentityChanged = next.smtpHost !== current.smtp_host || next.smtpUser !== current.smtp_user;
  let passwordEncrypted = current.smtp_password_encrypted;
  if (next.smtpUser === '' || (smtpIdentityChanged && !suppliedPassword?.trim())) passwordEncrypted = null;
  else if (suppliedPassword?.trim()) passwordEncrypted = encryptSecret(Buffer.from(suppliedPassword, 'utf8'));

  const preview = {
    ...current,
    enabled: Number(next.enabled),
    email: next.email,
    smtp_host: next.smtpHost,
    smtp_port: next.smtpPort,
    smtp_security: next.smtpSecurity,
    smtp_user: next.smtpUser,
    smtp_password_encrypted: passwordEncrypted,
    smtp_from: next.smtpFrom,
  };
  if (next.enabled && !configured(preview))
    throw storeError('Для включения уведомлений заполните корректные email и SMTP настройки');

  transaction(() => {
    db.prepare(
      `UPDATE notification_settings SET enabled=?,email=?,smtp_host=?,smtp_port=?,smtp_security=?,smtp_user=?,
        smtp_password_encrypted=?,smtp_from=? WHERE id=1`,
    ).run(
      Number(next.enabled),
      next.email,
      next.smtpHost,
      next.smtpPort,
      next.smtpSecurity,
      next.smtpUser,
      passwordEncrypted,
      next.smtpFrom,
    );
    if (!next.enabled) {
      db.prepare("UPDATE connection_notifications SET status='cancelled' WHERE status='pending'").run();
    }
  });
  return getNotificationSettings();
};

export const queueConnectionLoss = (projectId, tokenSN, lostAt, account = {}) => {
  if (
    typeof projectId !== 'string' ||
    !projectId ||
    typeof tokenSN !== 'string' ||
    !tokenSN ||
    typeof lostAt !== 'string' ||
    !lostAt
  ) {
    throw storeError('Некорректные данные инцидента подключения');
  }
  const settings = settingsRow();
  if (!settings.enabled || !configured(settings)) return null;
  const id = sha256(JSON.stringify([projectId, tokenSN, lostAt]));
  const tokenHash = sha256(tokenSN);
  transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO connection_notifications
        (id,project_id,token_hash,lost_at,status,attempt_count,next_attempt_at,org_name,phone,created_at)
       VALUES (?,?,?,?,'pending',0,?,?,?,?)`,
    ).run(
      id,
      projectId,
      tokenHash,
      lostAt,
      Date.now(),
      cleanText(account.orgName, 160),
      cleanText(account.phone, 80),
      nowIso(),
    );
  });
  return id;
};

export const resolveConnectionLoss = (projectId) =>
  transaction(
    () =>
      db
        .prepare("UPDATE connection_notifications SET status='cancelled' WHERE project_id=? AND status='pending'")
        .run(projectId).changes,
  );

export const reserveNotificationTest = () => {
  const result = transaction(() => {
    const row = settingsRow();
    const now = Date.now();
    if (row.test_allowed_at && row.test_allowed_at > now) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.test_allowed_at - now) / 1000)) };
    }
    db.prepare('UPDATE notification_settings SET test_allowed_at=? WHERE id=1').run(now + TEST_COOLDOWN_MS);
    return { allowed: true, retryAfter: 0 };
  });
  if (!result.allowed) {
    const error = storeError(
      'Тестовое письмо можно отправить не чаще одного раза в 30 секунд',
      429,
      'NOTIFICATION_RATE_LIMITED',
    );
    error.retryAfter = result.retryAfter;
    throw error;
  }
};

export const recordNotificationSuccess = (sentAt = nowIso()) =>
  db.prepare('UPDATE notification_settings SET last_sent_at=?,last_error=NULL WHERE id=1').run(sentAt);

export const recordNotificationError = () =>
  db.prepare('UPDATE notification_settings SET last_error=? WHERE id=1').run(SAFE_DELIVERY_ERROR);

export const claimNextConnectionNotification = (now = Date.now()) =>
  transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM connection_notifications
         WHERE status='pending' AND next_attempt_at<=? AND attempt_count<?
         ORDER BY next_attempt_at,created_at,id LIMIT 1`,
      )
      .get(now, MAX_ATTEMPTS);
    if (!row) return null;
    const changed = db
      .prepare(
        "UPDATE connection_notifications SET status='sending',attempt_count=attempt_count+1 WHERE id=? AND status='pending'",
      )
      .run(row.id);
    if (!changed.changes) return null;
    return { ...row, status: 'sending', attempt_count: row.attempt_count + 1 };
  });

export const markConnectionNotificationSent = (id, sentAt = nowIso()) =>
  transaction(() => {
    const changed = db
      .prepare(
        "UPDATE connection_notifications SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND status='sending'",
      )
      .run(sentAt, id);
    if (changed.changes)
      db.prepare('UPDATE notification_settings SET last_sent_at=?,last_error=NULL WHERE id=1').run(sentAt);
    return Boolean(changed.changes);
  });

export const retryConnectionNotification = (id, attemptCount, now = Date.now()) => {
  const terminal = attemptCount >= MAX_ATTEMPTS;
  const retryDelay = RETRY_DELAYS_MS[Math.max(0, attemptCount - 1)] ?? RETRY_DELAYS_MS.at(-1);
  return (
    db
      .prepare(
        `UPDATE connection_notifications SET status=?,next_attempt_at=?,last_error=?
       WHERE id=? AND status='sending'`,
      )
      .run(terminal ? 'failed' : 'pending', now + (terminal ? 0 : retryDelay), SAFE_DELIVERY_ERROR, id).changes > 0
  );
};

export const cancelConnectionNotification = (id) =>
  db
    .prepare("UPDATE connection_notifications SET status='cancelled' WHERE id=? AND status IN ('pending','sending')")
    .run(id).changes > 0;

// A process can die after the SMTP server accepted the message but before SQLite recorded success.
// Retry with the same Message-ID so recipients can deduplicate the rare at-least-once resend.
export const recoverSendingConnectionNotifications = (now = Date.now()) =>
  db
    .prepare(
      `UPDATE connection_notifications
       SET status=CASE WHEN attempt_count>=? THEN 'failed' ELSE 'pending' END,
         next_attempt_at=?,last_error=CASE WHEN attempt_count>=? THEN ? ELSE last_error END
       WHERE status='sending'`,
    )
    .run(MAX_ATTEMPTS, now, MAX_ATTEMPTS, SAFE_DELIVERY_ERROR).changes;
