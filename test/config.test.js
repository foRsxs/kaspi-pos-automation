import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const projectsModule = pathToFileURL(path.resolve('src/projects.js')).href;
const projectStoreModule = pathToFileURL(path.resolve('src/projectStore.js')).href;
const sandboxes = [];
const testEnvKeys = ['CONFIG_TEST_API_KEY_A', 'CONFIG_TEST_API_KEY_B', 'CONFIG_TEST_WEBHOOK_SECRET'];

after(() => {
  for (const directory of sandboxes) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createSandbox = (configuration) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-config-test-'));
  sandboxes.push(directory);

  const projectsFile = path.join(directory, 'projects.json');
  fs.writeFileSync(projectsFile, configuration);

  return { directory, projectsFile };
};

const importProjects = ({ directory, projectsFile, env = {}, scriptBody, tokenSecretKey = 'b'.repeat(64) }) => {
  const childEnv = { ...process.env };
  delete childEnv.ADMIN_API_KEY;
  for (const key of testEnvKeys) delete childEnv[key];

  Object.assign(childEnv, env, { DATA_DIR: path.join(directory, 'data') });
  childEnv.TOKEN_SECRET_KEY = tokenSecretKey;
  delete childEnv.PROJECTS_FILE;
  if (projectsFile) childEnv.PROJECTS_FILE = projectsFile;

  const script =
    scriptBody ||
    `await import(${JSON.stringify(projectsModule)}).catch((error) => {
    console.error(error.name + ': ' + error.message);
    process.exitCode = 1;
  });`;

  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    env: childEnv,
    encoding: 'utf8',
    timeout: 5000,
  });
};

const assertStartupRejected = (result, message) => {
  assert.ifError(result.error);
  assert.equal(result.status, 1, `Expected startup failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, message);
};

test('startup rejects a missing admin API key', () => {
  const sandbox = createSandbox('[]');
  const result = importProjects(sandbox);

  assertStartupRejected(result, /ADMIN_API_KEY должен содержать/);
});

test('startup rejects duplicate project API keys', () => {
  const sandbox = createSandbox(
    JSON.stringify([
      { id: 'shop-a', apiKeyEnv: 'CONFIG_TEST_API_KEY_A' },
      { id: 'shop-b', apiKeyEnv: 'CONFIG_TEST_API_KEY_B' },
    ]),
  );
  const result = importProjects({
    ...sandbox,
    env: {
      ADMIN_API_KEY: 'admin-key-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_A: 'project-key-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_B: 'project-key-012345678901234567890123456789',
    },
  });

  assertStartupRejected(result, /API-ключ проекта shop-b уже используется/);
});

test('startup rejects duplicate project IDs', () => {
  const sandbox = createSandbox(
    JSON.stringify([
      { id: 'shop', apiKeyEnv: 'CONFIG_TEST_API_KEY_A' },
      { id: 'shop', apiKeyEnv: 'CONFIG_TEST_API_KEY_B' },
    ]),
  );
  const result = importProjects({
    ...sandbox,
    env: {
      ADMIN_API_KEY: 'admin-key-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_A: 'project-key-a-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_B: 'project-key-b-012345678901234567890123456789',
    },
  });

  assertStartupRejected(result, /уникальный ID из 1–64/i);

  // A failed first import must leave the same volume usable for a corrected migration.
  fs.writeFileSync(
    sandbox.projectsFile,
    JSON.stringify([
      { id: 'shop-a', apiKeyEnv: 'CONFIG_TEST_API_KEY_A' },
      { id: 'shop-b', apiKeyEnv: 'CONFIG_TEST_API_KEY_B' },
    ]),
  );
  const repaired = importProjects({
    ...sandbox,
    env: {
      ADMIN_API_KEY: 'admin-key-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_A: 'project-key-a-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_B: 'project-key-b-012345678901234567890123456789',
    },
    scriptBody: `const store = await import(${JSON.stringify(projectStoreModule)}); console.log('PROJECTS:' + JSON.stringify(store.listProjects()));`,
  });
  assert.ifError(repaired.error);
  assert.equal(repaired.status, 0, repaired.stderr);
  const projects = JSON.parse(repaired.stdout.split('PROJECTS:').at(-1));
  assert.deepEqual(
    projects.map(({ id }) => id),
    ['shop-a', 'shop-b'],
  );
});

test('startup rejects a missing webhook secret', () => {
  const sandbox = createSandbox(
    JSON.stringify([
      {
        id: 'shop',
        apiKeyEnv: 'CONFIG_TEST_API_KEY_A',
        webhooks: [
          {
            url: 'https://shop.example.com/kaspi-webhook',
            events: ['payment.success'],
            secretEnv: 'CONFIG_TEST_WEBHOOK_SECRET',
          },
        ],
      },
    ]),
  );
  const result = importProjects({
    ...sandbox,
    env: {
      ADMIN_API_KEY: 'admin-key-012345678901234567890123456789',
      CONFIG_TEST_API_KEY_A: 'project-key-a-012345678901234567890123456789',
    },
  });

  assertStartupRejected(result, /Неверная конфигурация webhook проекта shop/);
});

test('startup rejects malformed projects JSON', () => {
  const sandbox = createSandbox('{"projects":');
  const result = importProjects({
    ...sandbox,
    env: { ADMIN_API_KEY: 'admin-key-012345678901234567890123456789' },
  });

  assertStartupRejected(result, /Не удалось прочитать PROJECTS_FILE:/);
});

test('missing legacy project file starts with an empty project catalog', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-config-test-'));
  sandboxes.push(directory);
  const result = importProjects({
    directory,
    env: { ADMIN_API_KEY: 'admin-key-012345678901234567890123456789' },
    scriptBody: `const store = await import(${JSON.stringify(projectStoreModule)}); console.log('PROJECTS:' + JSON.stringify(store.listProjects()));`,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, `Expected empty initial catalog, got stderr:\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout.split('PROJECTS:').at(-1)), []);
});

test('legacy project configuration is imported only on the first database initialization', () => {
  const sandbox = createSandbox(
    JSON.stringify([{ id: 'legacy-shop', apiKeyEnv: 'CONFIG_TEST_API_KEY_A', webhooks: [] }]),
  );
  const env = {
    ADMIN_API_KEY: 'admin-key-012345678901234567890123456789',
    CONFIG_TEST_API_KEY_A: 'project-key-a-012345678901234567890123456789',
  };
  const firstImport = importProjects({
    ...sandbox,
    env,
    scriptBody: `const store = await import(${JSON.stringify(projectStoreModule)}); console.log('PROJECTS:' + JSON.stringify(store.listProjects()));`,
  });
  assert.ifError(firstImport.error);
  assert.equal(firstImport.status, 0, firstImport.stderr);
  assert.deepEqual(
    JSON.parse(firstImport.stdout.split('PROJECTS:').at(-1)).map(({ id }) => id),
    ['legacy-shop'],
  );
  assert.equal(fs.existsSync(path.join(sandbox.directory, 'data', 'projects.sqlite')), true);

  fs.writeFileSync(sandbox.projectsFile, '{ invalid after first import');
  const restarted = importProjects({
    ...sandbox,
    env: { ADMIN_API_KEY: env.ADMIN_API_KEY },
    scriptBody: `const store = await import(${JSON.stringify(projectStoreModule)}); console.log('PROJECTS:' + JSON.stringify(store.listProjects()));`,
  });
  assert.ifError(restarted.error);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(
    JSON.parse(restarted.stdout.split('PROJECTS:').at(-1)).map(({ id }) => id),
    ['legacy-shop'],
  );
});

test('restart rejects a different master key for the existing project database', () => {
  const sandbox = createSandbox(
    JSON.stringify([{ id: 'encrypted-shop', apiKeyEnv: 'CONFIG_TEST_API_KEY_A', webhooks: [] }]),
  );
  const env = {
    ADMIN_API_KEY: 'admin-key-012345678901234567890123456789',
    CONFIG_TEST_API_KEY_A: 'project-key-a-012345678901234567890123456789',
  };
  const initial = importProjects({ ...sandbox, env, tokenSecretKey: 'b'.repeat(64) });
  assert.ifError(initial.error);
  assert.equal(initial.status, 0, initial.stderr);

  const restarted = importProjects({
    ...sandbox,
    env: { ADMIN_API_KEY: env.ADMIN_API_KEY },
    tokenSecretKey: 'c'.repeat(64),
  });
  assertStartupRejected(restarted, /TOKEN_SECRET_KEY не совпадает с ключом/);
});

test('restart rejects an admin key that collides with a stored project key', () => {
  const sandbox = createSandbox(
    JSON.stringify([{ id: 'collision-shop', apiKeyEnv: 'CONFIG_TEST_API_KEY_A', webhooks: [] }]),
  );
  const adminKey = 'admin-key-012345678901234567890123456789';
  const projectKey = 'project-key-a-012345678901234567890123456789';
  const initial = importProjects({
    ...sandbox,
    env: { ADMIN_API_KEY: adminKey, CONFIG_TEST_API_KEY_A: projectKey },
  });
  assert.ifError(initial.error);
  assert.equal(initial.status, 0, initial.stderr);

  const collision = importProjects({
    ...sandbox,
    env: { ADMIN_API_KEY: projectKey },
  });
  assertStartupRejected(collision, /ADMIN_API_KEY совпадает с API-ключом проекта/);

  const restoredAdmin = importProjects({
    ...sandbox,
    env: { ADMIN_API_KEY: adminKey, CONFIG_TEST_API_KEY_A: projectKey },
    scriptBody: `const projects = await import(${JSON.stringify(projectsModule)}); const authenticate = (key) => { const req = { get: () => 'Bearer ' + key }; let principal; projects.authenticateProject(req, { status(code) { throw new Error('unexpected status ' + code); }, json(body) { throw new Error(JSON.stringify(body)); } }, () => { principal = { id: req.project.id, isAdmin: req.project.isAdmin }; }); return principal; }; console.log('PRINCIPALS:' + JSON.stringify([authenticate(process.env.ADMIN_API_KEY), authenticate(process.env.CONFIG_TEST_API_KEY_A)]));`,
  });
  assert.ifError(restoredAdmin.error);
  assert.equal(restoredAdmin.status, 0, restoredAdmin.stderr);
  const principals = JSON.parse(restoredAdmin.stdout.split('PRINCIPALS:').at(-1));
  assert.deepEqual(principals, [
    { id: '__admin__', isAdmin: true },
    { id: 'collision-shop', isAdmin: false },
  ]);
});
