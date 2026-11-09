import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverUrl = new URL('../server.js', import.meta.url).href;

const startServerProcess = async (env) => {
  const source = `
    const { server } = await import(${JSON.stringify(serverUrl)});
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    process.stdout.write('API_KEY_TEST_PORT=' + server.address().port + '\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.dirname(fileURLToPath(new URL('../server.js', import.meta.url))),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child server startup timed out. ${errors}`)), 10000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Child server exited with code ${code}. ${errors}`));
    });
    const checkOutput = () => {
      const match = /API_KEY_TEST_PORT=(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', checkOutput);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', checkOutput);
    checkOutput();
  });

  return { child, baseUrl: `http://127.0.0.1:${port}` };
};

const stopServerProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
};

it('reveals only recoverable project API keys to administrators and preserves them across restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-key-reveal-'));
  const projectsFile = path.join(directory, 'projects.json');
  const oldKey = 'legacy-project-api-key-for-reveal-test-0001';
  const changedLegacyKey = 'stale-legacy-env-api-key-for-test-0002';
  fs.writeFileSync(
    projectsFile,
    JSON.stringify([{ id: 'legacy-shop', apiKeyEnv: 'LEGACY_SHOP_API_KEY', webhooks: [] }]),
  );

  const environmentKeys = [
    'DATA_DIR',
    'TOKEN_SECRET_KEY',
    'PORT',
    'ADMIN_API_KEY',
    'PROJECTS_FILE',
    'LEGACY_SHOP_API_KEY',
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATA_DIR: directory,
    TOKEN_SECRET_KEY: 'b'.repeat(64),
    PORT: '0',
    ADMIN_API_KEY: 'admin-key-reveal-test-01234567890123456789',
    PROJECTS_FILE: projectsFile,
    LEGACY_SHOP_API_KEY: oldKey,
  });

  let server;
  let polling;
  let child;
  let childBaseUrl;
  t.after(async () => {
    await stopServerProcess(child);
    if (polling) await polling.stopPolling();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  mock.module('node-fetch', { defaultExport: async () => ({ ok: true, status: 200 }) });
  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  polling = await import('../src/polling.js');
  await polling.stopPolling();

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminKey = process.env.ADMIN_API_KEY;
  const route = '/api/projects/legacy-shop/api-key';
  const projectRoute = '/api/projects/legacy-shop';
  const request = (base, endpoint, { key, method = 'GET', body } = {}) =>
    fetch(`${base}${endpoint}`, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  assert.equal((await request(baseUrl, route)).status, 401, 'the reveal endpoint requires authentication');
  assert.equal((await request(baseUrl, '/api/projects/missing-shop/api-key', { key: adminKey })).status, 404);
  assert.equal(
    (await request(baseUrl, route, { key: oldKey })).status,
    403,
    'a project key must not reveal any project key',
  );

  const revealedResponse = await request(baseUrl, route, { key: adminKey });
  assert.equal(revealedResponse.status, 200);
  assert.match(revealedResponse.headers.get('cache-control') || '', /no-store/i);
  const revealed = await revealedResponse.json();
  assert.equal(revealed.apiKey, oldKey, 'migration must preserve the original configured key for admin reveal');
  assert.equal((await request(baseUrl, '/api/payments', { key: oldKey })).status, 200);

  for (const endpoint of ['/api/projects', projectRoute]) {
    const response = await request(baseUrl, endpoint, { key: adminKey });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes(oldKey), false, `${endpoint} must not contain the plaintext API key`);
    assert.equal(JSON.stringify(body).includes('apiKeyHash'), false, `${endpoint} must not expose its key hash`);
    if (endpoint === projectRoute) assert.equal(body.project.canRevealApiKey, true);
    if (endpoint === '/api/projects') assert.equal(body.projects[0].canRevealApiKey, true);
  }

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path.join(directory, 'projects.sqlite'), { readOnly: true });
  const storedKey = database.prepare('SELECT key_hash, key_encrypted FROM projects WHERE id = ?').get('legacy-shop');
  assert.equal(storedKey.key_hash, crypto.createHash('sha256').update(oldKey).digest('hex'));
  assert.equal(typeof storedKey.key_encrypted, 'string');
  assert.notEqual(storedKey.key_encrypted, oldKey);
  database.close();

  const otherProjectResponse = await request(baseUrl, '/api/projects', {
    key: adminKey,
    method: 'POST',
    body: { id: 'other-shop', name: 'Other shop' },
  });
  assert.equal(otherProjectResponse.status, 201);
  const otherProject = await otherProjectResponse.json();
  const otherKey = otherProject.apiKey;
  assert.equal(typeof otherKey, 'string');
  assert.equal(otherProject.project.canRevealApiKey, true);
  assert.equal(JSON.stringify(otherProject.project).includes(otherKey), false);

  const { encryptSecret } = await import('../src/crypto.js');
  const tamperedDatabase = new DatabaseSync(path.join(directory, 'projects.sqlite'));
  tamperedDatabase
    .prepare('UPDATE projects SET key_encrypted = ? WHERE id = ?')
    .run(encryptSecret(Buffer.from(otherKey, 'ascii')), 'legacy-shop');
  tamperedDatabase.close();

  const tamperedResponse = await request(baseUrl, route, { key: adminKey });
  assert.equal(tamperedResponse.status, 409);
  assert.equal((await tamperedResponse.json()).code, 'API_KEY_NOT_RECOVERABLE');
  assert.equal((await request(baseUrl, '/api/payments', { key: otherKey })).status, 200);

  for (const endpoint of ['/api/projects', projectRoute]) {
    const response = await request(baseUrl, endpoint, { key: adminKey });
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes(storedKey.key_encrypted), false);
    assert.equal(JSON.stringify(body).includes(otherKey), false);
  }

  const rotationResponse = await request(baseUrl, `${projectRoute}/rotate-key`, {
    key: adminKey,
    method: 'POST',
    body: {},
  });
  assert.equal(rotationResponse.status, 200);
  const rotation = await rotationResponse.json();
  const rotatedKey = rotation.apiKey;
  assert.equal(typeof rotatedKey, 'string');
  assert.notEqual(rotatedKey, oldKey);
  assert.equal(rotation.project.canRevealApiKey, true);
  assert.equal((await request(baseUrl, route, { key: adminKey })).status, 200);
  assert.equal((await (await request(baseUrl, route, { key: adminKey })).json()).apiKey, rotatedKey);
  assert.equal((await request(baseUrl, '/api/payments', { key: oldKey })).status, 401);
  assert.equal((await request(baseUrl, '/api/payments', { key: rotatedKey })).status, 200);

  process.env.LEGACY_SHOP_API_KEY = changedLegacyKey;
  ({ child, baseUrl: childBaseUrl } = await startServerProcess({ ...process.env }));
  const afterRestart = await request(childBaseUrl, route, { key: adminKey });
  assert.equal(afterRestart.status, 200);
  assert.equal(
    (await afterRestart.json()).apiKey,
    rotatedKey,
    'a stale legacy environment value must not replace the DB key',
  );
  assert.equal((await request(childBaseUrl, '/api/payments', { key: oldKey })).status, 401);
  assert.equal((await request(childBaseUrl, '/api/payments', { key: changedLegacyKey })).status, 401);
  assert.equal((await request(childBaseUrl, '/api/payments', { key: rotatedKey })).status, 200);

  const archiveResponse = await request(childBaseUrl, projectRoute, { key: adminKey, method: 'DELETE' });
  assert.equal(archiveResponse.status, 200);
  const archived = await archiveResponse.json();
  assert.equal(archived.project.status, 'archived');
  assert.equal(archived.project.canRevealApiKey, false);
  const archivedReveal = await request(childBaseUrl, route, { key: adminKey });
  assert.equal(archivedReveal.status, 409);
  assert.equal(JSON.stringify(await archivedReveal.json()).includes(rotatedKey), false);

  const archivedDatabase = new DatabaseSync(path.join(directory, 'projects.sqlite'), { readOnly: true });
  const archivedKey = archivedDatabase
    .prepare('SELECT key_hash, key_encrypted FROM projects WHERE id = ?')
    .get('legacy-shop');
  assert.equal(archivedKey.key_hash, null);
  assert.equal(archivedKey.key_encrypted, null);
  archivedDatabase.close();
});
