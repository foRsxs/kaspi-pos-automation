import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { it, mock } from 'node:test';

it('manages projects and webhooks immediately while preserving archived payment ownership', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-admin-'));
  const projectsFile = path.join(directory, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  const environmentKeys = ['DATA_DIR', 'TOKEN_SECRET_KEY', 'PORT', 'ADMIN_API_KEY', 'PROJECTS_FILE'];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATA_DIR: directory,
    TOKEN_SECRET_KEY: 'a'.repeat(64),
    PORT: '0',
    ADMIN_API_KEY: 'admin-project-crud-test-key-0123456789',
    PROJECTS_FILE: projectsFile,
  });

  const bankRequests = [];
  const webhookDeliveries = [];
  let bankStatus = 'Wait';
  let now = Date.now();
  mock.method(Date, 'now', () => now);
  mock.module('node-fetch', {
    defaultExport: async (url, options = {}) => {
      if (String(url).startsWith('https://hooks.example/')) {
        webhookDeliveries.push({ url: String(url), options });
        return { ok: false, status: 500 };
      }
      bankRequests.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ StatusCode: 0, Data: { Status: bankStatus } }),
      };
    },
  });

  let server;
  let polling;
  t.after(async () => {
    if (polling) await polling.stopPolling();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    mock.restoreAll();
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
  const { db } = await import('../src/database.js');

  const { encryptSecret } = await import('../src/crypto.js');

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { key, method = 'GET', body, headers: extraHeaders = {} } = {}) =>
    fetch(base + route, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const adminKey = process.env.ADMIN_API_KEY;
  const projectId = 'north-shop';
  const projectPath = `/api/projects/${projectId}`;

  assert.equal((await request('/api/projects')).status, 401);
  const createdResponse = await request('/api/projects', {
    key: adminKey,
    method: 'POST',
    body: { id: projectId, name: 'North shop' },
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.project.id, projectId);
  assert.equal(created.project.name, 'North shop');
  assert.equal(created.project.status, 'active');
  assert.equal(typeof created.project.createdAt, 'string');
  assert.equal(typeof created.project.updatedAt, 'string');
  assert.equal(typeof created.project.connection.connected, 'boolean');
  assert.ok(Array.isArray(created.project.webhooks));
  assert.equal(typeof created.apiKey, 'string');
  assert.ok(created.apiKey.length >= 32);
  const originalKey = created.apiKey;

  const listResponse = await request('/api/projects', { key: adminKey });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.deepEqual(
    listed.projects.map(({ id }) => id),
    [projectId],
  );
  assert.ok(!JSON.stringify(listed).includes(originalKey));
  assert.ok(!JSON.stringify(listed).includes('apiKeyHash'));
  assert.ok(!JSON.stringify(listed).includes('merchant-session'));
  assert.equal((await request('/api/payments', { key: originalKey })).status, 200);

  for (const [route, method, body] of [
    ['/api/projects', 'GET', undefined],
    ['/api/projects', 'POST', { name: 'Forbidden project' }],
    [projectPath, 'PATCH', { name: 'Forbidden rename' }],
    [`${projectPath}/rotate-key`, 'POST', {}],
    [projectPath, 'DELETE', undefined],
  ]) {
    assert.equal(
      (await request(route, { key: originalKey, method, body })).status,
      403,
      `project API key must not access ${method} ${route}`,
    );
  }

  const webhookUrl = 'https://hooks.example/updated';
  const hookPatchResponse = await request(projectPath, {
    key: adminKey,
    method: 'PATCH',
    body: {
      name: 'North shop updated',
      webhooks: [{ url: 'https://hooks.example/initial', events: ['payment.success'] }],
    },
  });
  assert.equal(hookPatchResponse.status, 200);
  const hookPatch = await hookPatchResponse.json();
  const hook = hookPatch.project.webhooks[0];
  assert.equal(hookPatch.project.name, 'North shop updated');
  assert.equal(typeof hook.id, 'string');
  assert.equal(hook.hasSecret, true);
  assert.ok(!Object.hasOwn(hook, 'secret'));
  assert.deepEqual(hook.events, ['payment.success']);
  assert.equal(hookPatch.webhookSecrets.length, 1);
  assert.equal(hookPatch.webhookSecrets[0].id, hook.id);
  const generatedWebhookSecret = hookPatch.webhookSecrets[0].secret;
  assert.equal(typeof generatedWebhookSecret, 'string');
  assert.ok(generatedWebhookSecret.length >= 32);
  assert.ok(!JSON.stringify(hookPatch.project).includes(generatedWebhookSecret));

  const updatedHookResponse = await request(projectPath, {
    key: adminKey,
    method: 'PATCH',
    body: {
      webhooks: [{ id: hook.id, url: webhookUrl, events: ['payment.success'] }],
    },
  });
  assert.equal(updatedHookResponse.status, 200);
  const updatedHook = await updatedHookResponse.json();
  assert.equal(updatedHook.project.webhooks[0].url, webhookUrl);
  assert.equal(updatedHook.project.webhooks[0].hasSecret, true);
  assert.deepEqual(
    updatedHook.webhookSecrets,
    [],
    'omitting a saved secret must preserve it without returning it again',
  );
  assert.equal((await request('/api/payments', { key: originalKey })).status, 200);

  const otherProjectResponse = await request('/api/projects', {
    key: adminKey,
    method: 'POST',
    body: { id: 'south-shop', name: 'South shop' },
  });
  assert.equal(otherProjectResponse.status, 201);
  const otherWebhook = await (
    await request('/api/projects/south-shop', {
      key: adminKey,
      method: 'PATCH',
      body: {
        webhooks: [
          {
            url: 'https://hooks.example/south',
            events: ['payment.success'],
            secret: 'south-project-webhook-secret-for-test-0001',
          },
        ],
      },
    })
  ).json();
  const rollbackResponse = await request(projectPath, {
    key: adminKey,
    method: 'PATCH',
    body: {
      name: 'This name must roll back',
      status: 'disabled',
      webhooks: [
        { id: hook.id, url: webhookUrl, events: ['payment.success'] },
        {
          id: otherWebhook.project.webhooks[0].id,
          url: 'https://hooks.example/stolen',
          events: ['payment.success'],
        },
      ],
    },
  });
  assert.equal(rollbackResponse.status, 409, 'a webhook owned by another project must reject the whole update');
  const afterRollback = await (await request(projectPath, { key: adminKey })).json();
  assert.equal(afterRollback.project.name, 'North shop updated');
  assert.equal(afterRollback.project.status, 'active');
  assert.deepEqual(
    afterRollback.project.webhooks.map(({ id, url }) => ({ id, url })),
    [{ id: hook.id, url: webhookUrl }],
  );
  assert.equal((await request('/api/payments', { key: originalKey })).status, 200);

  polling.trackPayment(
    771,
    'qr',
    {
      projectId,
      tokenSN: 'north-shop-token',
      profileId: 17,
      vtokenSecret: encryptSecret(Buffer.alloc(32, 7)),
    },
    { amount: 12.34, orderId: 'north-order-1' },
    projectId,
  );
  bankStatus = 'Processed';
  await polling.pollOnce();
  assert.equal(bankRequests.length, 1);
  assert.equal(webhookDeliveries.length, 1);
  assert.equal(webhookDeliveries[0].url, webhookUrl, 'a webhook URL edit must affect delivery without a restart');
  const deliveredBody = webhookDeliveries[0].options.body;
  assert.equal(
    webhookDeliveries[0].options.headers['X-Webhook-Signature'],
    `sha256=${crypto.createHmac('sha256', generatedWebhookSecret).update(deliveredBody).digest('hex')}`,
    'an omitted webhook secret on update must keep the existing signing secret',
  );
  assert.equal(JSON.parse(deliveredBody).projectId, projectId);

  const sameUrlSecrets = ['first-webhook-secret-for-identity-0001', 'second-webhook-secret-for-identity-0002'];
  const sameUrlPatch = await request(projectPath, {
    key: adminKey,
    method: 'PATCH',
    body: {
      webhooks: sameUrlSecrets.map((secret) => ({ url: webhookUrl, events: ['payment.success'], secret })),
    },
  });
  assert.equal(sameUrlPatch.status, 200);
  assert.deepEqual((await sameUrlPatch.json()).webhookSecrets, []);
  polling.trackPayment(
    772,
    'qr',
    {
      projectId,
      tokenSN: 'north-shop-token-2',
      profileId: 17,
      vtokenSecret: encryptSecret(Buffer.alloc(32, 8)),
    },
    { amount: 23.45, orderId: 'north-order-2' },
    projectId,
  );
  await polling.pollOnce();
  assert.equal(bankRequests.length, 2);
  assert.equal(webhookDeliveries.length, 3);
  const signatures = webhookDeliveries.slice(1).map(({ options }) => options.headers['X-Webhook-Signature']);
  const expectedSignatures = sameUrlSecrets.map((secret, index) => {
    const body = webhookDeliveries[index + 1].options.body;
    return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  });
  assert.equal(new Set(signatures).size, 2, 'same-URL hooks with different secrets need independent signatures');
  assert.deepEqual([...signatures].sort(), [...expectedSignatures].sort());

  const { saveMerchantSession } = await import('../src/merchantSession.js');
  saveMerchantSession(projectId, {
    tokenSN: 'north-shop-live-token',
    profileId: 17,
    vtokenSecret: encryptSecret(Buffer.alloc(32, 9)),
  });

  const rotatedResponse = await request(`${projectPath}/rotate-key`, {
    key: adminKey,
    method: 'POST',
    body: {},
  });
  assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json();
  assert.equal(rotated.project.id, projectId);
  assert.equal(typeof rotated.apiKey, 'string');
  assert.notEqual(rotated.apiKey, originalKey);
  assert.equal((await request('/api/payments', { key: originalKey })).status, 401);
  assert.equal((await request('/api/payments', { key: rotated.apiKey })).status, 200);

  const disabledResponse = await request(projectPath, {
    key: adminKey,
    method: 'PATCH',
    body: { status: 'disabled' },
  });
  assert.equal(disabledResponse.status, 200);
  assert.equal((await request('/api/payments', { key: rotated.apiKey })).status, 401);
  const disabled = await disabledResponse.json();
  assert.equal(disabled.project.status, 'disabled');
  const bankRequestsBeforeDisabledAdminCreate = bankRequests.length;
  for (const route of ['/api/qr/create', '/api/invoice/create']) {
    const disabledCreate = await request(route, {
      key: adminKey,
      method: 'POST',
      body: route === '/api/qr/create' ? { amount: 10 } : { amount: 10, phoneNumber: '7001234567' },
      headers: { 'X-Project-ID': projectId },
    });
    assert.equal(disabledCreate.status, 403, `administrator must not create through disabled project: ${route}`);
  }
  assert.equal(
    bankRequests.length,
    bankRequestsBeforeDisabledAdminCreate,
    'disabled project must be blocked before Kaspi',
  );

  const reenabledResponse = await request(projectPath, {
    key: adminKey,
    method: 'PATCH',
    body: { status: 'active' },
  });
  assert.equal(reenabledResponse.status, 200);
  assert.equal((await request('/api/payments', { key: rotated.apiKey })).status, 200);

  const archivedResponse = await request(projectPath, { key: adminKey, method: 'DELETE' });
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.equal(archived.project.status, 'archived');
  assert.equal((await request('/api/payments', { key: rotated.apiKey })).status, 401);
  const ledgerResponse = await request('/api/payments', { key: adminKey, headers: { 'X-Project-ID': projectId } });
  assert.equal(ledgerResponse.status, 200, 'administrator can read archived payment records without bank login');
  assert.match(ledgerResponse.headers.get('cache-control'), /no-store/);
  const ledger = await ledgerResponse.json();
  assert.ok(ledger.payments.some((payment) => payment.paymentId === '771'));
  assert.ok(ledger.payments.every((payment) => !Object.hasOwn(payment, 'sessionHeaders')));
  assert.equal((await request('/api/payments', { key: adminKey })).status, 400);
  assert.deepEqual(
    (await (await request('/api/projects', { key: adminKey })).json()).projects.map(({ id }) => id),
    ['south-shop'],
  );
  const allProjects = await (await request('/api/projects?includeArchived=true', { key: adminKey })).json();
  assert.deepEqual(
    allProjects.projects.map(({ id, status }) => ({ id, status })),
    [
      { id: projectId, status: 'archived' },
      { id: 'south-shop', status: 'active' },
    ],
  );

  const duplicateId = await request('/api/projects', {
    key: adminKey,
    method: 'POST',
    body: { id: projectId, name: 'Reused ID' },
  });
  assert.equal(duplicateId.status, 409, 'an archived project ID must remain reserved');
  const persisted = {
    payments: db.prepare('SELECT project_id,payment_id FROM payments').all(),
    deliveries: db.prepare('SELECT project_id,payload_json FROM webhook_deliveries').all(),
  };
  assert.ok(
    persisted.payments.some((entry) => entry.project_id === projectId && entry.payment_id === '771'),
    'archiving must retain completed ledger entries under their original owner',
  );
  assert.ok(
    persisted.deliveries.some(
      (entry) => entry.project_id === projectId && JSON.parse(entry.payload_json).projectId === projectId,
    ),
    'archiving must retain pending webhook retries under their original owner',
  );
  assert.equal(webhookDeliveries.length, 3, 'archiving must not emit retries a second time');

  now += 6000;
  await polling.pollOnce();
  assert.equal(webhookDeliveries.length, 5, 'archived projects must continue their already queued webhook retries');
  const archivedRetrySignatures = webhookDeliveries
    .slice(-2)
    .map(({ options }) => options.headers['X-Webhook-Signature']);
  const archivedExpectedSignatures = sameUrlSecrets.map((secret, index) => {
    const body = webhookDeliveries.at(-2 + index).options.body;
    return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  });
  assert.deepEqual([...archivedRetrySignatures].sort(), [...archivedExpectedSignatures].sort());
  assert.equal(db.prepare('SELECT count(*) AS n FROM webhook_deliveries').get().n, 2);
});
