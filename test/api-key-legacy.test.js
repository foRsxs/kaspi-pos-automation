import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { it } from 'node:test';

it('adds nullable key encryption for hash-only SQLite projects without recovering a key from legacy env', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-key-legacy-'));
  const legacyKey = 'legacy-hash-only-api-key-for-test-0001';
  const projectsFile = path.join(directory, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');

  const environmentKeys = [
    'DATA_DIR',
    'TOKEN_SECRET_KEY',
    'PORT',
    'ADMIN_API_KEY',
    'PROJECTS_FILE',
    'HASH_ONLY_API_KEY',
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATA_DIR: directory,
    TOKEN_SECRET_KEY: 'c'.repeat(64),
    PORT: '0',
    ADMIN_API_KEY: 'admin-legacy-key-test-01234567890123456789',
    PROJECTS_FILE: projectsFile,
    HASH_ONLY_API_KEY: legacyKey,
  });

  const { DatabaseSync } = await import('node:sqlite');
  const databasePath = path.join(directory, 'projects.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT NOT NULL COLLATE NOCASE PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
      key_hash TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL COLLATE NOCASE REFERENCES projects(id) ON DELETE RESTRICT,
      url TEXT NOT NULL,
      events_json TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL
    );
    CREATE INDEX webhooks_project_id_idx ON webhooks(project_id);
    INSERT INTO store_meta (key, value) VALUES ('legacy_projects_v1', 'already-imported');
  `);
  database
    .prepare('INSERT INTO projects (id, name, status, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      'hash-only',
      'Hash only project',
      'active',
      crypto.createHash('sha256').update(legacyKey).digest('hex'),
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    );
  database.close();

  let server;
  let polling;
  t.after(async () => {
    if (polling) await polling.stopPolling();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  polling = await import('../src/polling.js');
  await polling.stopPolling();

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminKey = process.env.ADMIN_API_KEY;
  const request = (route, { key, method = 'GET', body } = {}) =>
    fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  assert.equal(
    (await request('/api/payments', { key: legacyKey })).status,
    200,
    'the saved hash must keep authenticating',
  );
  const revealResponse = await request('/api/projects/hash-only/api-key', { key: adminKey });
  assert.equal(revealResponse.status, 409);
  assert.equal((await revealResponse.json()).code, 'API_KEY_NOT_RECOVERABLE');

  const projectResponse = await request('/api/projects/hash-only', { key: adminKey });
  assert.equal(projectResponse.status, 200);
  assert.equal((await projectResponse.json()).project.canRevealApiKey, false);

  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const columns = migratedDatabase.prepare('PRAGMA table_info(projects)').all();
  const encryptedColumn = columns.find((column) => column.name === 'key_encrypted');
  assert.ok(encryptedColumn, 'startup must add key_encrypted to the existing schema');
  assert.equal(encryptedColumn.notnull, 0, 'old rows need a nullable encrypted key column');
  const oldProject = migratedDatabase
    .prepare('SELECT key_hash, key_encrypted FROM projects WHERE id = ?')
    .get('hash-only');
  assert.equal(oldProject.key_hash, crypto.createHash('sha256').update(legacyKey).digest('hex'));
  assert.equal(oldProject.key_encrypted, null, 'a matching legacy env variable must not backfill an old row');
  migratedDatabase.close();

  const rotationResponse = await request('/api/projects/hash-only/rotate-key', {
    key: adminKey,
    method: 'POST',
    body: {},
  });
  assert.equal(rotationResponse.status, 200);
  const rotatedKey = (await rotationResponse.json()).apiKey;
  assert.equal(typeof rotatedKey, 'string');
  assert.notEqual(rotatedKey, legacyKey);
  assert.equal((await request('/api/payments', { key: legacyKey })).status, 401);
  assert.equal((await request('/api/payments', { key: rotatedKey })).status, 200);
  assert.equal(
    (await (await request('/api/projects/hash-only/api-key', { key: adminKey })).json()).apiKey,
    rotatedKey,
    'an explicit rotation makes the replacement key revealable',
  );
});
