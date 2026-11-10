import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';

const environmentKeys = [
  'DATA_DIR',
  'TOKEN_SECRET_KEY',
  'PORT',
  'ADMIN_API_KEY',
  'JOURNAL_SHOP_API_KEY',
  'JOURNAL_OTHER_API_KEY',
  'JOURNAL_SHOP_WEBHOOK_SECRET',
  'JOURNAL_OTHER_WEBHOOK_SECRET',
  'PROJECTS_FILE',
];

const saveEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

const restoreEnvironment = (environment) => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const childEnvironment = (dataDir, projectsFile) => ({
  ...process.env,
  DATA_DIR: dataDir,
  TOKEN_SECRET_KEY: 'c'.repeat(64),
  ADMIN_API_KEY: 'journal-migration-admin-key-0123456789',
  PROJECTS_FILE: projectsFile,
});

const runStoreProcess = (dataDir, projectsFile, script) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: childEnvironment(dataDir, projectsFile),
    encoding: 'utf8',
    timeout: 15000,
  });

const readMarker = (result, marker) => {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find((value) => value.startsWith(marker));
  assert.ok(line, `child process output must contain ${marker}: ${result.stdout}`);
  return JSON.parse(line.slice(marker.length));
};

test('webhook delivery journal persists attempts, isolates admin queries, and retries with the same signed ID', async (t) => {
  const previousEnvironment = saveEnvironment();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-webhook-journal-'));
  const dataDir = path.join(directory, 'data');
  const projectsFile = path.join(directory, 'projects.json');
  fs.mkdirSync(dataDir);

  const hookSecret = 'journal-shop-webhook-secret-1234567890';
  const otherHookSecret = 'journal-other-webhook-secret-1234567890';
  const shopKey = 'journal-shop-api-key-0123456789abcdef';
  const otherKey = 'journal-other-api-key-0123456789abcdef';
  const adminKey = 'journal-admin-api-key-0123456789abcdef';
  const responseStatuses = [];
  const received = [];
  const webhookServer = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const status = responseStatuses.shift() ?? 200;
      const deliveryId = request.headers['x-webhook-id'];
      const deliveryStatus = db?.prepare('SELECT status FROM webhook_deliveries WHERE id=?').get(deliveryId)?.status;
      received.push({ headers: request.headers, body, status, deliveryStatus });
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end('private-receiver-response-must-not-be-journaled');
    });
  });
  webhookServer.listen(0, '127.0.0.1');
  await once(webhookServer, 'listening');
  const hookUrl = `http://127.0.0.1:${webhookServer.address().port}/hook`;
  fs.writeFileSync(
    projectsFile,
    JSON.stringify([
      {
        id: 'journal-shop',
        apiKeyEnv: 'JOURNAL_SHOP_API_KEY',
        webhooks: [
          {
            url: hookUrl,
            events: ['payment.success'],
            secretEnv: 'JOURNAL_SHOP_WEBHOOK_SECRET',
          },
        ],
      },
      {
        id: 'journal-other',
        apiKeyEnv: 'JOURNAL_OTHER_API_KEY',
        webhooks: [
          {
            url: hookUrl,
            events: ['payment.success'],
            secretEnv: 'JOURNAL_OTHER_WEBHOOK_SECRET',
          },
        ],
      },
    ]),
  );
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    TOKEN_SECRET_KEY: 'a'.repeat(64),
    PORT: '0',
    ADMIN_API_KEY: adminKey,
    JOURNAL_SHOP_API_KEY: shopKey,
    JOURNAL_OTHER_API_KEY: otherKey,
    JOURNAL_SHOP_WEBHOOK_SECRET: hookSecret,
    JOURNAL_OTHER_WEBHOOK_SECRET: otherHookSecret,
    PROJECTS_FILE: projectsFile,
  });

  let polling;
  let server;
  let db;
  t.after(async () => {
    if (polling) await polling.stopPolling();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (webhookServer.listening) await new Promise((resolve) => webhookServer.close(resolve));
    mock.restoreAll();
    restoreEnvironment(previousEnvironment);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  mock.module('node-fetch', {
    exports: {
      default: async (url, options) => {
        if (String(url).startsWith(hookUrl)) {
          const payload = JSON.parse(options.body);
          if (payload.paymentId === '92201') throw new Error('synthetic network failure '.repeat(100));
          return fetch(url, options);
        }
        assert.match(
          String(url),
          /kaspi-qr\/status\?qrOperationId=/,
          'only the fake Kaspi status endpoint is expected',
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({ StatusCode: 0, Data: { Status: 'Processed', Amount: 15.5 } }),
        };
      },
    },
  });

  const { encryptSecret } = await import('../src/crypto.js');
  const { createAdminSession } = await import('../src/adminStore.js');
  const { insertDelivery } = await import('../src/webhookDeliveryStore.js');
  polling = await import('../src/polling.js');
  const { logger } = await import('../src/logger.js');
  mock.method(logger, 'error', () => {});
  const database = await import('../src/database.js');
  db = database.db;
  const serverModule = await import('../server.js');
  server = serverModule.server;
  if (!server.listening) await once(server, 'listening');
  await polling.stopPolling();

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', key = adminKey, projectId = 'journal-shop', body, cookie, csrf } = {}) => {
    const headers = {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(projectId ? { 'X-Project-ID': projectId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };
    return fetch(baseUrl + route, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };

  assert.equal((await request('/api/webhook-deliveries', { key: null, projectId: null })).status, 401);
  assert.equal((await request('/api/webhook-deliveries', { key: shopKey })).status, 403);
  assert.equal((await request('/api/webhook-deliveries', { projectId: null })).status, 400);
  assert.equal((await request('/api/webhook-deliveries', { projectId: 'missing-project' })).status, 404);
  assert.equal((await request('/api/webhook-deliveries/unknown-delivery')).status, 404);

  const sessionHeaders = {
    projectId: 'journal-shop',
    tokenSN: 'private-session-token-sn',
    profileId: 777,
    vtokenSecret: encryptSecret(Buffer.alloc(32, 7)),
  };
  for (const [paymentId, orderId] of [
    ['91201', 'journal-order-1'],
    ['91202', 'journal-order-2'],
    ['91203', 'journal-order-3'],
  ]) {
    assert.equal(
      polling.trackPayment(paymentId, 'qr', sessionHeaders, { amount: 15.5, orderId }, 'journal-shop'),
      true,
    );
  }
  assert.equal(
    polling.trackPayment(
      '92201',
      'qr',
      { ...sessionHeaders, projectId: 'journal-other' },
      { amount: 2, orderId: 'other-order' },
      'journal-other',
    ),
    true,
  );

  responseStatuses.push(500, 200, 200);
  await polling.pollOnce();
  assert.equal(received.length, 3, 'the shop deliveries reach the local HTTP receiver');
  assert.ok(received.every(({ deliveryStatus }) => deliveryStatus === 'sending'));

  const firstPageResponse = await request('/api/webhook-deliveries?page=1&pageSize=2');
  assert.equal(firstPageResponse.status, 200);
  assert.match(firstPageResponse.headers.get('cache-control') || '', /no-store/);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.page, 1);
  assert.equal(firstPage.pageSize, 2);
  assert.equal(firstPage.deliveries.length, 2);
  assert.equal(firstPage.summary.total, 3);
  assert.equal(firstPage.summary.retrying, 1);
  assert.equal(firstPage.summary.delivered, 2);
  const secondPage = await (await request('/api/webhook-deliveries?page=2&pageSize=2')).json();
  assert.equal(secondPage.total, 3);
  assert.equal(secondPage.deliveries.length, 1);
  assert.equal(
    new Set([...firstPage.deliveries, ...secondPage.deliveries].map(({ id }) => id)).size,
    3,
    'pages do not overlap',
  );

  const byPaymentPrefix = await (await request('/api/webhook-deliveries?search=9120')).json();
  assert.equal(byPaymentPrefix.total, 3);
  const byOrderPrefix = await (await request('/api/webhook-deliveries?search=journal-order-2')).json();
  assert.equal(byOrderPrefix.total, 1);
  assert.equal(byOrderPrefix.deliveries[0].orderId, 'journal-order-2');
  const retrying = await (await request('/api/webhook-deliveries?status=retrying')).json();
  assert.equal(retrying.total, 1);
  const otherProject = await (await request('/api/webhook-deliveries', { projectId: 'journal-other' })).json();
  assert.equal(otherProject.total, 1);
  assert.equal(otherProject.deliveries[0].projectId, 'journal-other');
  const otherDetail = await (
    await request(`/api/webhook-deliveries/${otherProject.deliveries[0].id}`, { projectId: 'journal-other' })
  ).json();
  assert.equal(otherDetail.delivery.status, 'retrying');
  assert.ok(otherDetail.delivery.lastError.length <= 1000);
  assert.match(otherDetail.delivery.lastError, /synthetic network failure/);
  assert.equal((await request('/api/webhook-deliveries', { key: shopKey, projectId: 'journal-other' })).status, 403);
  for (const query of ['?page=0', '?pageSize=101', '?status=unknown']) {
    assert.equal((await request(`/api/webhook-deliveries${query}`)).status, 400, `${query} is invalid`);
  }

  const target = byPaymentPrefix.deliveries.find(({ paymentId }) => paymentId === '91201');
  assert.ok(target);
  const expectedDeliveryFields = [
    'id',
    'projectId',
    'paymentId',
    'type',
    'orderId',
    'event',
    'url',
    'status',
    'attempts',
    'httpStatus',
    'lastError',
    'createdAt',
    'updatedAt',
    'nextAttemptAt',
    'deliveredAt',
    'canRetry',
    'retryDisabledReason',
  ];
  assert.deepEqual(Object.keys(target).sort(), expectedDeliveryFields.sort());
  const firstDetail = await (await request(`/api/webhook-deliveries/${target.id}`)).json();
  assert.equal(firstDetail.delivery.id, target.id);
  assert.equal(firstDetail.attempts.length, 1);
  assert.deepEqual(
    Object.keys(firstDetail.attempts[0]).sort(),
    ['number', 'startedAt', 'finishedAt', 'httpStatus', 'error', 'durationMs', 'outcome'].sort(),
  );
  assert.equal(firstDetail.attempts[0].httpStatus, 500);
  assert.equal((await request(`/api/webhook-deliveries/${target.id}`, { projectId: 'journal-other' })).status, 404);

  const publicJournal = JSON.stringify({
    firstPage,
    secondPage,
    byPaymentPrefix,
    byOrderPrefix,
    retrying,
    firstDetail,
    otherDetail,
  });
  for (const privateValue of [
    hookSecret,
    otherHookSecret,
    shopKey,
    otherKey,
    adminKey,
    'private-session-token-sn',
    'private-receiver-response-must-not-be-journaled',
  ]) {
    assert.ok(!publicJournal.includes(privateValue), `journal response must not expose ${privateValue}`);
  }

  for (const call of received) {
    const body = JSON.parse(call.body);
    const secret = body.projectId === 'journal-shop' ? hookSecret : otherHookSecret;
    assert.equal(
      call.headers['x-webhook-signature'],
      `sha256=${crypto.createHmac('sha256', secret).update(call.body).digest('hex')}`,
    );
  }

  const deliveryColumns = new Set(
    db
      .prepare('PRAGMA table_info(webhook_deliveries)')
      .all()
      .map(({ name }) => name),
  );
  const dueColumn = deliveryColumns.has('execute_after') ? 'execute_after' : 'next_attempt_at';
  assert.ok(deliveryColumns.has(dueColumn));
  const setDueNow = (id) =>
    db.prepare(`UPDATE webhook_deliveries SET ${dueColumn}=? WHERE id=?`).run(Date.now() - 1, id);
  const hookRecord = db
    .prepare('SELECT id,project_id,url,events_json,secret_encrypted FROM webhooks WHERE project_id=?')
    .get('journal-shop');
  db.prepare('DELETE FROM webhooks WHERE id=?').run(hookRecord.id);
  assert.equal(
    (await request(`/api/webhook-deliveries/${target.id}/retry`, { method: 'POST', body: {} })).status,
    409,
    'manual retry is rejected when the configured hook no longer matches',
  );
  db.prepare('INSERT INTO webhooks(id,project_id,url,events_json,secret_encrypted) VALUES (?,?,?,?,?)').run(
    hookRecord.id,
    hookRecord.project_id,
    hookRecord.url,
    hookRecord.events_json,
    hookRecord.secret_encrypted,
  );

  for (const expectedAttempt of [2, 3]) {
    responseStatuses.push(500);
    setDueNow(target.id);
    await polling.pollOnce();
    const detail = await (await request(`/api/webhook-deliveries/${target.id}`)).json();
    assert.equal(detail.delivery.status, expectedAttempt === 3 ? 'failed' : 'retrying');
    assert.equal(detail.attempts.length, expectedAttempt);
  }
  const failedDetail = await (await request(`/api/webhook-deliveries/${target.id}`)).json();
  assert.equal(failedDetail.delivery.status, 'failed');
  assert.equal(failedDetail.delivery.attempts, 3);
  assert.deepEqual(
    failedDetail.attempts.map(({ httpStatus }) => httpStatus),
    [500, 500, 500],
  );
  assert.equal((await request(`/api/webhook-deliveries/${target.id}`, { projectId: 'journal-other' })).status, 404);

  db.prepare('UPDATE server_admin SET must_change_password=0 WHERE id=1').run();
  const adminSession = createAdminSession();
  const cookie = `kaspi_admin_session=${adminSession.token}`;
  assert.equal(
    (
      await request(`/api/webhook-deliveries/${target.id}/retry`, {
        method: 'POST',
        key: null,
        cookie,
        body: {},
      })
    ).status,
    403,
    'cookie-authenticated retry requires its CSRF token',
  );
  responseStatuses.push(200);
  const retryResponse = await request(`/api/webhook-deliveries/${target.id}/retry`, {
    method: 'POST',
    key: null,
    cookie,
    csrf: adminSession.csrfToken,
    body: {},
  });
  assert.equal(retryResponse.status, 202);
  const retryBody = await retryResponse.json();
  assert.equal(retryBody.delivery.id, target.id);
  assert.equal(retryBody.delivery.status, 'queued');
  assert.equal(retryBody.delivery.attempts, 3, 'retry resets the current cycle and preserves cumulative attempts');
  assert.equal(
    (await request(`/api/webhook-deliveries/${target.id}/retry`, { method: 'POST', body: {} })).status,
    409,
    'a nonterminal delivery cannot be queued twice',
  );

  const callsBeforeManualRetry = received.length;
  await polling.pollOnce();
  assert.equal(received.length, callsBeforeManualRetry + 1);
  const finalDetail = await (await request(`/api/webhook-deliveries/${target.id}`)).json();
  assert.equal(finalDetail.delivery.status, 'delivered');
  assert.equal(finalDetail.delivery.attempts, 4);
  assert.equal(finalDetail.attempts.length, 4);
  assert.equal(finalDetail.attempts.at(-1).outcome, 'delivered');
  assert.ok(finalDetail.delivery.deliveredAt);
  const sameDeliveryCalls = received.filter(({ headers }) => headers['x-webhook-id'] === target.id);
  assert.equal(sameDeliveryCalls.length, 4);
  assert.ok(sameDeliveryCalls.every(({ headers }) => headers['x-webhook-id'] === target.id));
  for (const call of sameDeliveryCalls) {
    assert.equal(
      call.headers['x-webhook-signature'],
      `sha256=${crypto.createHmac('sha256', hookSecret).update(call.body).digest('hex')}`,
      'autoretries and manual retry keep the same ID and a valid HMAC over the same payload',
    );
    assert.equal(call.body, sameDeliveryCalls[0].body);
  }
  await polling.pollOnce();
  assert.equal(received.length, callsBeforeManualRetry + 1, 'delivered entries remain durable and are not resent');

  const cancelledId = 'delivery-with-removed-hook';
  insertDelivery({
    id: cancelledId,
    projectId: 'journal-shop',
    hookId: '00000000-0000-4000-8000-000000000001',
    url: hookUrl,
    payload: {
      event: 'payment.success',
      projectId: 'journal-shop',
      paymentId: '91300',
      type: 'qr',
      orderId: 'deleted-hook-order',
      timestamp: new Date().toISOString(),
    },
    attempt: 1,
    executeAfter: Date.now(),
  });
  await polling.pollOnce();
  const cancelledDetail = await (await request(`/api/webhook-deliveries/${cancelledId}`)).json();
  assert.equal(cancelledDetail.delivery.status, 'cancelled');
  assert.equal(cancelledDetail.attempts.length, 0);
  assert.equal(
    (await request(`/api/webhook-deliveries/${cancelledId}/retry`, { method: 'POST', body: {} })).status,
    409,
  );
});

test('webhook journal migration retains the old SQLite queue and recovers an interrupted send', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-webhook-migration-'));
  const dataDir = path.join(directory, 'data');
  const projectsFile = path.join(directory, 'projects.json');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(projectsFile, '[]');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const id = 'legacy-delivery-123';
  const executeAfter = 1700000000123;
  const payload = {
    event: 'payment.success',
    projectId: 'legacy-owner',
    paymentId: '65123',
    type: 'qr',
    orderId: 'legacy-order-65123',
    status: 'Processed',
    timestamp: '2023-11-14T22:13:20.123Z',
  };
  const legacyDatabase = new DatabaseSync(path.join(dataDir, 'projects.sqlite'));
  legacyDatabase.exec(`CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, hook_id TEXT, url TEXT NOT NULL,
    payload_json TEXT NOT NULL, attempt INTEGER NOT NULL, execute_after INTEGER NOT NULL
  )`);
  legacyDatabase
    .prepare(
      'INSERT INTO webhook_deliveries(id,project_id,hook_id,url,payload_json,attempt,execute_after) VALUES (?,?,?,?,?,?,?)',
    )
    .run(id, 'legacy-owner', 'legacy-hook', 'https://legacy.example/webhook', JSON.stringify(payload), 2, executeAfter);
  legacyDatabase.close();

  const migrated = runStoreProcess(
    dataDir,
    projectsFile,
    `await import('./src/paymentStore.js');
      const { db } = await import('./src/database.js');
      const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get('${id}');
      console.log('MIGRATED:' + JSON.stringify(row));`,
  );
  const migratedRow = readMarker(migrated, 'MIGRATED:');
  assert.equal(migratedRow.id, id);
  assert.equal(migratedRow.project_id, 'legacy-owner');
  assert.equal(migratedRow.hook_id, 'legacy-hook');
  assert.equal(migratedRow.url, 'https://legacy.example/webhook');
  assert.equal(migratedRow.payload_json, JSON.stringify(payload));
  assert.equal(migratedRow.execute_after, executeAfter);
  assert.equal(migratedRow.attempt, 2);
  assert.equal(migratedRow.attempt_count, 1, 'legacy next-attempt index estimates one completed HTTP attempt');
  assert.equal(migratedRow.status, 'retrying');
  assert.ok(Number.isSafeInteger(migratedRow.created_at) && migratedRow.created_at > 0);

  const simulateSending = runStoreProcess(
    dataDir,
    projectsFile,
    `await import('./src/paymentStore.js');
      const { db } = await import('./src/database.js');
      const row = db.prepare('SELECT attempt,attempt_count FROM webhook_deliveries WHERE id=?').get('${id}');
      const number = row.attempt_count + 1;
      db.prepare("UPDATE webhook_deliveries SET status='sending',attempt_count=? WHERE id=?").run(number,'${id}');
      db.prepare("INSERT INTO webhook_delivery_attempts(delivery_id,number,started_at,outcome) VALUES (?,?,?,'sending')")
        .run('${id}',number,Date.now());
      console.log('SENDING:' + number);`,
  );
  assert.ifError(simulateSending.error);
  assert.equal(simulateSending.status, 0, simulateSending.stderr);

  const recovered = runStoreProcess(
    dataDir,
    projectsFile,
    `await import('./src/paymentStore.js');
      const { db } = await import('./src/database.js');
      const row = db.prepare('SELECT status,attempt,attempt_count FROM webhook_deliveries WHERE id=?').get('${id}');
      const attempts = db.prepare('SELECT number,finished_at,error,outcome FROM webhook_delivery_attempts WHERE delivery_id=?').all('${id}');
      console.log('RECOVERED:' + JSON.stringify({ row, attempts }));`,
  );
  const recovery = readMarker(recovered, 'RECOVERED:');
  assert.equal(recovery.row.status, 'retrying');
  assert.equal(recovery.row.attempt, 3);
  assert.equal(recovery.row.attempt_count, 2);
  assert.equal(recovery.attempts.length, 1);
  assert.equal(recovery.attempts[0].number, 2);
  assert.ok(recovery.attempts[0].finished_at);
  assert.match(recovery.attempts[0].error, /прервана перезапуском/i);
  assert.equal(recovery.attempts[0].outcome, 'interrupted');

  const claimThirdAttempt = runStoreProcess(
    dataDir,
    projectsFile,
    `await import('./src/paymentStore.js');
      const { claimDelivery } = await import('./src/webhookDeliveryStore.js');
      const { db } = await import('./src/database.js');
      const claimed = claimDelivery('${id}');
      const row = db.prepare('SELECT status,attempt,attempt_count FROM webhook_deliveries WHERE id=?').get('${id}');
      console.log('THIRD_ATTEMPT:' + JSON.stringify({ claimed, row }));`,
  );
  const thirdAttempt = readMarker(claimThirdAttempt, 'THIRD_ATTEMPT:');
  assert.equal(thirdAttempt.claimed.number, 3);
  assert.equal(thirdAttempt.row.status, 'sending');
  assert.equal(thirdAttempt.row.attempt, 3);
  assert.equal(thirdAttempt.row.attempt_count, 3);

  const thirdAttemptRecovery = runStoreProcess(
    dataDir,
    projectsFile,
    `await import('./src/paymentStore.js');
      const { db } = await import('./src/database.js');
      const row = db.prepare('SELECT status,attempt,attempt_count FROM webhook_deliveries WHERE id=?').get('${id}');
      const attempts = db.prepare('SELECT number,finished_at,error,outcome FROM webhook_delivery_attempts WHERE delivery_id=? ORDER BY number').all('${id}');
      console.log('THIRD_RECOVERY:' + JSON.stringify({ row, attempts }));`,
  );
  const lastRecovery = readMarker(thirdAttemptRecovery, 'THIRD_RECOVERY:');
  assert.equal(lastRecovery.row.status, 'failed');
  assert.equal(lastRecovery.row.attempt, 3);
  assert.equal(lastRecovery.row.attempt_count, 3);
  assert.equal(lastRecovery.attempts.length, 2);
  assert.equal(lastRecovery.attempts.at(-1).number, 3);
  assert.ok(lastRecovery.attempts.at(-1).finished_at);
  assert.equal(lastRecovery.attempts.at(-1).outcome, 'interrupted');

  const stableRestart = runStoreProcess(
    dataDir,
    projectsFile,
    `await import('./src/paymentStore.js');
      const { db } = await import('./src/database.js');
      const { dueDeliveries } = await import('./src/webhookDeliveryStore.js');
      const row = db.prepare('SELECT status,attempt_count FROM webhook_deliveries WHERE id=?').get('${id}');
      const pending = [...dueDeliveries(Date.now())].map(({ id: deliveryId }) => deliveryId);
      console.log('STABLE_RESTART:' + JSON.stringify({ row, pending }));`,
  );
  const stable = readMarker(stableRestart, 'STABLE_RESTART:');
  assert.equal(stable.row.status, 'failed');
  assert.equal(stable.row.attempt_count, 3);
  assert.deepEqual(stable.pending, []);
});
