import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const file = path.join(DATA_DIR, 'server-secrets.json');
const validKey = (value) => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
const envKey = process.env.TOKEN_SECRET_KEY || null;
if (envKey && !validKey(envKey)) throw new Error('TOKEN_SECRET_KEY должен содержать ровно 64 hex-символа');
const readKey = () => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || !validKey(value.tokenSecretKey))
    throw new Error('Некорректный server-secrets.json; восстановите сохранённый ключ');
  fs.chmodSync(file, 0o600);
  return value.tokenSecretKey.toLowerCase();
};
const existingEncryptedData = () => {
  if (
    [
      'projects.sqlite',
      'payments-state.json',
      'tracked-payments.json',
      'webhook-retries.json',
      'merchant-session.json',
      'last-session.json',
    ].some((name) => fs.existsSync(path.join(DATA_DIR, name)))
  )
    return true;
  const projects = path.join(DATA_DIR, 'projects');
  return (
    fs.existsSync(projects) &&
    fs.readdirSync(projects).some((name) => fs.existsSync(path.join(projects, name, 'merchant-session.json')))
  );
};
let key;
if (fs.existsSync(file)) {
  key = readKey();
  if (envKey && key !== envKey.toLowerCase())
    throw new Error('TOKEN_SECRET_KEY не совпадает с ключом server-secrets.json');
} else if (envKey) {
  key = envKey.toLowerCase();
} else {
  if (existingEncryptedData())
    throw new Error(
      'Найдено существующее хранилище без TOKEN_SECRET_KEY/server-secrets.json. Восстановите прежний ключ; новый ключ не создан.',
    );
  key = crypto.randomBytes(32).toString('hex');
}
export const ENCRYPTION_KEY = Buffer.from(key, 'hex');
export const encryptionKeySource = envKey ? 'env' : 'file';
export const persistMasterKey = () => {
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, tokenSecretKey: key }) + '\n', { flag: 'wx', mode: 0o600 });
    // Persist the generated key before SQLite can commit data encrypted with it.
    for (const target of [file, DATA_DIR]) {
      const descriptor = fs.openSync(target, 'r');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readKey() !== key)
      throw new Error('TOKEN_SECRET_KEY не совпадает с ключом server-secrets.json', { cause: error });
  }
};
// A generated key must exist before SQLite is created. An imported ENV key is
// persisted only after verification against the existing encrypted database.
if (!envKey) persistMasterKey();
