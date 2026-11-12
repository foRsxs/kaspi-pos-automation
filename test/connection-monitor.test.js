import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, mock } from 'node:test';

it('checks idle accounts without sending loss alerts for network failures or other projects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-connection-monitor-'));
  const environment = {
    DATA_DIR: directory,
    PROJECTS_FILE: path.join(directory, 'projects.json'),
    DOTENV_CONFIG_PATH: path.join(directory, 'absent.env'),
    TOKEN_SECRET_KEY: 'd'.repeat(64),
    ADMIN_API_KEY: 'monitor-test-admin-key-0123456789012345',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  fs.writeFileSync(environment.PROJECTS_FILE, '[]');
  const settings = { enabled: false, configured: true };
  const queueCalls = [];
  const requests = [];
  const responses = new Map();
  mock.module(new URL('../src/notificationStore.js', import.meta.url).href, {
    namedExports: {
      getNotificationSettings: () => ({ ...settings }),
      queueConnectionLoss: (...args) => queueCalls.push(args),
      resolveConnectionLoss: () => {},
    },
  });
  mock.module('node-fetch', {
    defaultExport: async (url, options) => {
      assert.equal(new URL(url).pathname, '/v02/history/operations');
      const tokenSN = options.headers['X-Kb-TokenSn'];
      requests.push(tokenSN);
      const response = responses.get(tokenSN);
      if (typeof response === 'function') return response();
      if (response instanceof Error) throw response;
      return response || { ok: true, status: 200, json: async () => ({ StatusCode: 0, Data: {} }) };
    },
  });
  const { createProject, archiveProject } = await import('../src/projectStore.js');
  const { encryptSecret } = await import('../src/crypto.js');
  const { saveMerchantSession, getConnectionSummary } = await import('../src/merchantSession.js');
  const { checkConnectionsOnce, stopConnectionMonitor } = await import('../src/connectionMonitor.js');
  const { db } = await import('../src/database.js');
  t.after(async () => {
    await stopConnectionMonitor();
    db.close();
    mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fileFor = (id) => path.join(directory, 'projects', id, 'merchant-session.json');
  const issue = (id, tokenSN) => {
    saveMerchantSession(id, {
      tokenSN,
      profileId: 42,
      vtokenSecret: encryptSecret(Buffer.alloc(32, 1)),
      orgName: `${id} shop`,
      phone: '7001234567',
    });
  };
  for (const id of ['healthy', 'lost', 'network', 'archived', 'fresh', 'unconnected']) {
    createProject({ id, name: id });
    if (id !== 'unconnected') issue(id, `${id}-token`);
  }
  archiveProject('archived');
  responses.set('lost-token', { ok: true, status: 200, json: async () => ({ StatusCode: -101001 }) });
  responses.set('network-token', new Error('simulated network failure'));

  await t.test('does not query the bank when email notifications are disabled or incomplete', async () => {
    await checkConnectionsOnce();
    settings.enabled = true;
    settings.configured = false;
    await checkConnectionsOnce();
    assert.deepEqual(requests, []);
    assert.deepEqual(queueCalls, []);
  });

  await t.test('checks connected accounts and queues only a confirmed rejection with account context', async () => {
    settings.configured = true;
    await checkConnectionsOnce();
    assert.deepEqual([...requests].sort(), ['fresh-token', 'healthy-token', 'lost-token', 'network-token']);
    assert.equal(getConnectionSummary('healthy').connected, true);
    assert.equal(getConnectionSummary('network').connected, true);
    assert.equal(getConnectionSummary('lost').connected, false);
    assert.equal(queueCalls.length, 1);
    assert.equal(queueCalls[0][0], 'lost');
    assert.equal(queueCalls[0][1], 'lost-token');
    assert.equal(queueCalls[0][2], JSON.parse(fs.readFileSync(fileFor('lost'), 'utf8')).invalidatedAt);
    assert.deepEqual(queueCalls[0][3], { orgName: 'lost shop', phone: '7001234567' });
  });

  await t.test('recovers an existing loss using its original incident time', async () => {
    requests.length = 0;
    const originalLoss = queueCalls[0];
    await checkConnectionsOnce();
    assert.deepEqual([...requests].sort(), ['fresh-token', 'healthy-token', 'network-token']);
    assert.deepEqual(queueCalls.at(-1), originalLoss);
  });

  await t.test('does not mark a replacement session lost when a stale bank request is rejected', async () => {
    issue('healthy', 'healthy-old-token');
    responses.set('healthy-old-token', () => {
      issue('healthy', 'healthy-new-token');
      return { ok: false, status: 401, json: async () => ({}) };
    });
    await checkConnectionsOnce();
    assert.equal(getConnectionSummary('healthy').connected, true);
    assert.equal(JSON.parse(fs.readFileSync(fileFor('healthy'), 'utf8')).tokenSN, 'healthy-new-token');
    assert.equal(queueCalls.filter(([id]) => id === 'healthy').length, 0);
  });

  await t.test('shares an in-flight cycle and stops before starting another account check', async () => {
    requests.length = 0;
    issue('healthy', 'healthy-held-token');
    let finish;
    let started;
    const waiting = new Promise((resolve) => (started = resolve));
    responses.set('healthy-held-token', () => {
      started();
      return new Promise((resolve) => (finish = resolve));
    });
    const first = checkConnectionsOnce();
    const second = checkConnectionsOnce();
    assert.equal(first, second);
    await waiting;
    const stopping = stopConnectionMonitor();
    finish({ ok: true, status: 200, json: async () => ({ StatusCode: 0 }) });
    await Promise.all([first, stopping]);
    assert.equal(requests.filter((token) => token === 'healthy-held-token').length, 1);
    assert.equal(requests.includes('network-token'), false);
  });
});
