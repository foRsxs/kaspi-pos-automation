import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './paths.js';
import './serverSecrets.js';

export const DATABASE_FILE = path.join(DATA_DIR, 'projects.sqlite');
const oldUmask = process.umask(0o077);
let connection;
try {
  connection = new DatabaseSync(DATABASE_FILE);
} finally {
  process.umask(oldUmask);
}
export const db = connection;
fs.chmodSync(DATABASE_FILE, 0o600);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
db.exec('CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
for (const sidecar of [`${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`]) {
  if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
}

export const transaction = (callback, { readOnly = false } = {}) => {
  db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
