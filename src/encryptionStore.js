import { db, transaction } from './database.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { persistMasterKey } from './serverSecrets.js';

const marker = 'encryption_key_check_v1';
const expected = Buffer.from('kaspi-project-store-encryption-check-v1', 'utf8');
const verifyKey = () => {
  const stored = db.prepare('SELECT value FROM store_meta WHERE key=?').get(marker);
  try {
    if (stored) {
      if (!decryptSecret(stored.value).equals(expected)) throw new Error('mismatch');
      return;
    }
    for (const [table, column] of [
      ['webhooks', 'secret_encrypted'],
      ['projects', 'key_encrypted'],
      ['payments', 'session_encrypted'],
      ['server_admin', 'api_key_encrypted'],
      ['notification_settings', 'smtp_password_encrypted'],
    ]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((field) => field.name === column)) continue;
      for (const row of db.prepare(`SELECT ${column} AS encrypted FROM ${table} WHERE ${column} IS NOT NULL`).iterate())
        decryptSecret(row.encrypted);
    }
  } catch {
    throw new Error('TOKEN_SECRET_KEY не совпадает с ключом, которым зашифрованы данные projects.sqlite');
  }
  db.prepare('INSERT INTO store_meta(key,value) VALUES (?,?)').run(marker, encryptSecret(expected));
};
transaction(verifyKey);
persistMasterKey();
