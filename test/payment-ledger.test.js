import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const testEnvKeys = [
  'DATA_DIR',
  'TOKEN_SECRET_KEY',
  'PORT',
  'ADMIN_API_KEY',
  'LEDGER_SHOP_API_KEY',
  'LEDGER_OTHER_API_KEY',
  'PROJECTS_FILE',
];

const saveEnvironment = () => Object.fromEntries(testEnvKeys.map((key) => [key, process.env[key]]));

const restoreEnvironment = (environment) => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const paymentEntry = ({
  projectId,
  paymentId,
  type = 'qr',
  status = 'Wait',
  event = null,
  orderId = null,
  createdAt,
  sessionHeaders,
}) => ({
  paymentId: String(paymentId),
  projectId,
  type,
  status,
  ...(event === undefined ? {} : { event }),
  ...(sessionHeaders ? { sessionHeaders } : {}),
  meta: { amount: 12.34, orderId },
  createdAt,
  retryCount: 0,
});

const statePair = (entry) => [JSON.stringify([entry.projectId, entry.type, entry.paymentId]), entry];

const writeProjectConfig = (file) => {
  fs.writeFileSync(
    file,
    JSON.stringify([
      { id: 'ledger-shop', apiKeyEnv: 'LEDGER_SHOP_API_KEY', webhooks: [] },
      { id: 'ledger-other', apiKeyEnv: 'LEDGER_OTHER_API_KEY', webhooks: [] },
    ]),
  );
};

const runStoreProcess = (dataDir, extraEnvironment = {}) => {
  const childEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    TOKEN_SECRET_KEY: process.env.TOKEN_SECRET_KEY || 'b'.repeat(64),
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'ledger-admin-key-0123456789abcdef',
    PROJECTS_FILE: path.join(path.dirname(dataDir), 'projects.json'),
    ...extraEnvironment,
  };
  const script = `await import('./src/paymentStore.js');`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: 'utf8',
    timeout: 10000,
  });
};

test('payments API migrates the canonical ledger and filters with isolated pagination', async (t) => {
  const previousEnvironment = saveEnvironment();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-payment-ledger-'));
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(dataDir);
  const projectsFile = path.join(directory, 'projects.json');
  writeProjectConfig(projectsFile);

  Object.assign(process.env, {
    DATA_DIR: dataDir,
    TOKEN_SECRET_KEY: 'c'.repeat(64),
    PORT: '0',
    ADMIN_API_KEY: 'ledger-admin-key-0123456789abcdef',
    LEDGER_SHOP_API_KEY: 'ledger-shop-api-key-0123456789abcdef',
    LEDGER_OTHER_API_KEY: 'ledger-other-api-key-0123456789abcdef',
    PROJECTS_FILE: projectsFile,
  });

  const { encryptSecret, decryptSecret } = await import('../src/crypto.js');
  const credentialValue = 'private-session-credential-value';
  const encryptedCredential = encryptSecret(Buffer.from(credentialValue));
  const pendingSession = {
    projectId: 'ledger-shop',
    tokenSN: 'private-token-sn',
    profileId: 123,
    vtokenSecret: encryptedCredential,
  };
  const entries = [
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20001',
      status: 'Wait',
      orderId: 'pending-order',
      createdAt: 1001,
      sessionHeaders: pendingSession,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20001',
      type: 'invoice',
      status: 'Processed',
      event: 'payment.success',
      orderId: 'paid-same-id',
      createdAt: 1002,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20002',
      status: 'CancelledByUser',
      event: 'payment.failed',
      orderId: 'failed-order',
      createdAt: 1003,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20003',
      type: 'invoice',
      status: 'Expired',
      event: 'payment.expired',
      orderId: 'expired-order',
      createdAt: 1004,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20004',
      status: 'SessionExpired',
      event: 'payment.lost',
      orderId: 'lost-order',
      createdAt: 1005,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20005',
      status: 'UnknownBankStatus',
      event: 'payment.manual-review',
      orderId: 'review-order',
      createdAt: 1006,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20006',
      orderId: 'Percent%_Order',
      createdAt: 1007,
      sessionHeaders: pendingSession,
    }),
    paymentEntry({
      projectId: 'ledger-shop',
      paymentId: '20007',
      orderId: 'another-pending-order',
      createdAt: 1008,
      sessionHeaders: pendingSession,
    }),
    paymentEntry({
      projectId: 'ledger-other',
      paymentId: '20001',
      status: 'Wait',
      orderId: 'other-project-order',
      createdAt: 1009,
      sessionHeaders: {
        ...pendingSession,
        projectId: 'ledger-other',
        tokenSN: 'other-private-token-sn',
      },
    }),
  ];
  for (let index = 0; index < 112; index++) {
    entries.push(
      paymentEntry({
        projectId: 'ledger-shop',
        paymentId: String(20100 + index),
        status: 'Processed',
        event: 'payment.success',
        orderId: `bulk-order-${index}`,
        createdAt: 2000 + index,
      }),
    );
  }

  const delivery = {
    id: 'legacy-delivery-1',
    projectId: 'ledger-shop',
    hookId: null,
    url: 'https://delivery.example/hook',
    payload: { event: 'payment.success', projectId: 'ledger-shop', paymentId: '20001' },
    attempt: 1,
    executeAfter: Date.now() + 60000,
  };
  const originalState = JSON.stringify({ payments: entries.map(statePair), deliveries: [delivery] }, null, 2);
  const stateFile = path.join(dataDir, 'payments-state.json');
  fs.writeFileSync(stateFile, originalState);

  let server;
  let polling;
  let database;
  t.after(async () => {
    if (polling) await polling.stopPolling();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    database?.close();
    restoreEnvironment(previousEnvironment);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  polling = await import('../src/polling.js');
  await polling.stopPolling();
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, key, headers = {}) =>
    fetch(base + route, {
      headers: { Authorization: `Bearer ${key}`, ...headers },
    });
  const shopKey = process.env.LEDGER_SHOP_API_KEY;
  const otherKey = process.env.LEDGER_OTHER_API_KEY;
  const adminKey = process.env.ADMIN_API_KEY;

  const defaultResponse = await request('/api/payments', shopKey);
  assert.equal(defaultResponse.status, 200);
  assert.match(defaultResponse.headers.get('cache-control'), /no-store/);
  const defaultPage = await defaultResponse.json();
  assert.deepEqual(Object.keys(defaultPage).sort(), ['payments', 'total', 'page', 'pageSize', 'summary'].sort());
  assert.equal(defaultPage.total, 120);
  assert.equal(defaultPage.page, 1);
  assert.equal(defaultPage.pageSize, 50);
  assert.equal(defaultPage.payments.length, 50);
  assert.deepEqual(defaultPage.summary, {
    total: 120,
    pending: 3,
    paid: 113,
    failed: 1,
    expired: 1,
    review: 2,
  });
  assert.ok(defaultPage.payments.every((payment) => payment.result));
  assert.ok(!JSON.stringify(defaultPage).includes('private-token-sn'));
  assert.ok(!JSON.stringify(defaultPage).includes(credentialValue));
  assert.ok(!JSON.stringify(defaultPage).includes(encryptedCredential));

  const pageTwo = await (await request('/api/payments?page=2&pageSize=50', shopKey)).json();
  const pageThree = await (await request('/api/payments?page=3&pageSize=50', shopKey)).json();
  assert.equal(pageTwo.payments.length, 50);
  assert.equal(pageThree.payments.length, 20);
  assert.equal(pageTwo.total, 120);
  assert.deepEqual(pageTwo.summary, defaultPage.summary);
  const paginatedKeys = [...defaultPage.payments, ...pageTwo.payments, ...pageThree.payments].map(
    ({ paymentId, type }) => `${paymentId}:${type}`,
  );
  assert.equal(new Set(paginatedKeys).size, 120, 'pages must not overlap and the composite key must be preserved');

  const pending = await (await request('/api/payments?status=pending', shopKey)).json();
  assert.equal(pending.total, 3);
  assert.ok(pending.payments.every(({ result }) => result === 'pending'));
  assert.deepEqual(pending.summary, defaultPage.summary, 'summary counts ignore the active result filter');
  const review = await (await request('/api/payments?status=review', shopKey)).json();
  assert.equal(review.total, 2);
  assert.deepEqual(
    review.payments.map(({ result }) => result),
    ['review', 'review'],
  );

  const duplicateOperationId = await (await request('/api/payments?search=20001', shopKey)).json();
  assert.equal(duplicateOperationId.total, 2, 'the payment key includes both project and payment type');
  assert.deepEqual(duplicateOperationId.payments.map(({ type }) => type).sort(), ['invoice', 'qr']);
  const escapedSearch = await (await request('/api/payments?search=percent%25_', shopKey)).json();
  assert.equal(escapedSearch.total, 1, 'percent and underscore are searched literally');
  assert.equal(escapedSearch.payments[0].paymentId, '20006');
  assert.equal(escapedSearch.payments[0].orderId, 'Percent%_Order');

  const otherProject = await (await request('/api/payments', otherKey)).json();
  assert.equal(otherProject.total, 1);
  assert.equal(otherProject.payments[0].orderId, 'other-project-order');
  const adminLedger = await (await request('/api/payments', adminKey, { 'X-Project-ID': 'ledger-shop' })).json();
  assert.equal(adminLedger.total, 120);
  assert.equal((await request('/api/payments', adminKey)).status, 400);
  assert.equal((await request('/api/payments', shopKey, { 'X-Project-ID': 'ledger-other' })).status, 403);

  for (const query of ['?page=0', '?page=1.5', '?pageSize=0', '?pageSize=101', '?status=unknown']) {
    assert.equal((await request(`/api/payments${query}`, shopKey)).status, 400, `${query} must be rejected`);
  }

  assert.equal(fs.readFileSync(stateFile, 'utf8'), originalState, 'migration leaves the source JSON untouched');
  database = new DatabaseSync(path.join(dataDir, 'projects.sqlite'));
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM store_meta WHERE key = 'legacy_payments_v1'").get().count,
    1,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM payments').get().count, 121);
  assert.equal(database.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count, 1);
  const pendingRow = database
    .prepare(
      "SELECT session_encrypted FROM payments WHERE project_id = 'ledger-shop' AND type = 'qr' AND payment_id = '20001'",
    )
    .get();
  assert.ok(pendingRow.session_encrypted);
  const restoredSession = JSON.parse(decryptSecret(pendingRow.session_encrypted).toString('utf8'));
  assert.equal(restoredSession.tokenSN, 'private-token-sn');

  const restart = runStoreProcess(dataDir);
  assert.ifError(restart.error);
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(database.prepare('SELECT count(*) AS count FROM payments').get().count, 121);
  assert.equal(database.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count, 1);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), originalState);
});

test('legacy fallback migration preserves admin ownership and rolls back interrupted imports', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-payment-migration-'));
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(dataDir);
  const projectsFile = path.join(directory, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  const environment = {
    DATA_DIR: dataDir,
    TOKEN_SECRET_KEY: 'd'.repeat(64),
    ADMIN_API_KEY: 'ledger-admin-key-0123456789abcdef',
    PROJECTS_FILE: projectsFile,
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const trackedFile = path.join(dataDir, 'tracked-payments.json');
  const retriesFile = path.join(dataDir, 'webhook-retries.json');
  const tracked = {
    70001: {
      paymentId: '70001',
      type: 'qr',
      status: 'QrTokenCreated',
      sessionHeaders: { tokenSN: 'legacy-admin-token', profileId: 1, vtokenSecret: 'already-encrypted' },
      meta: { amount: 1.25, orderId: 'legacy-admin-order' },
      createdAt: 77,
      retryCount: 0,
    },
  };
  const retries = [
    {
      hook: { url: 'https://legacy.example/hook' },
      payload: { event: 'payment.success', paymentId: '70001' },
      attempt: 2,
      executeAfter: Date.now() + 60000,
    },
  ];
  const originalTracked = JSON.stringify(tracked);
  const originalRetries = JSON.stringify(retries);
  fs.writeFileSync(trackedFile, originalTracked);
  fs.writeFileSync(retriesFile, originalRetries);

  const firstImport = runStoreProcess(dataDir, environment);
  assert.ifError(firstImport.error);
  assert.equal(firstImport.status, 0, firstImport.stderr);
  assert.equal(fs.readFileSync(trackedFile, 'utf8'), originalTracked);
  assert.equal(fs.readFileSync(retriesFile, 'utf8'), originalRetries);

  const database = new DatabaseSync(path.join(dataDir, 'projects.sqlite'));
  assert.deepEqual(
    database
      .prepare('SELECT project_id, payment_id FROM payments')
      .all()
      .map(({ project_id, payment_id }) => ({ project_id, payment_id })),
    [{ project_id: '__admin__', payment_id: '70001' }],
  );
  assert.deepEqual(
    database
      .prepare('SELECT project_id, attempt FROM webhook_deliveries')
      .all()
      .map(({ project_id, attempt }) => ({ project_id, attempt })),
    [{ project_id: '__admin__', attempt: 2 }],
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM store_meta WHERE key = 'legacy_payments_v1'").get().count,
    1,
  );

  const restart = runStoreProcess(dataDir, environment);
  assert.ifError(restart.error);
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(database.prepare('SELECT count(*) AS count FROM payments').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count, 1);
  database.close();

  const interruptedDir = path.join(directory, 'interrupted-data');
  fs.mkdirSync(interruptedDir);
  const validDuplicate = paymentEntry({
    projectId: '__admin__',
    paymentId: '80001',
    status: 'Processed',
    event: 'payment.success',
    orderId: 'duplicate-key',
    createdAt: 88,
  });
  const interruptedState = {
    payments: [statePair(validDuplicate), statePair(validDuplicate)],
    deliveries: [],
  };
  const interruptedFile = path.join(interruptedDir, 'payments-state.json');
  fs.writeFileSync(interruptedFile, JSON.stringify(interruptedState));
  const interrupted = runStoreProcess(interruptedDir, { ...environment, DATA_DIR: interruptedDir });
  assert.ifError(interrupted.error);
  assert.notEqual(interrupted.status, 0, 'duplicate composite keys must abort the transaction');

  const interruptedDb = new DatabaseSync(path.join(interruptedDir, 'projects.sqlite'));
  assert.equal(interruptedDb.prepare('SELECT count(*) AS count FROM payments').get().count, 0);
  assert.equal(
    interruptedDb.prepare("SELECT count(*) AS count FROM store_meta WHERE key = 'legacy_payments_v1'").get().count,
    0,
  );
  interruptedDb.close();

  fs.writeFileSync(interruptedFile, JSON.stringify({ payments: [statePair(validDuplicate)], deliveries: [] }));
  const recovered = runStoreProcess(interruptedDir, { ...environment, DATA_DIR: interruptedDir });
  assert.ifError(recovered.error);
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredDb = new DatabaseSync(path.join(interruptedDir, 'projects.sqlite'));
  assert.equal(recoveredDb.prepare('SELECT count(*) AS count FROM payments').get().count, 1);
  assert.equal(
    recoveredDb.prepare("SELECT count(*) AS count FROM store_meta WHERE key = 'legacy_payments_v1'").get().count,
    1,
  );
  recoveredDb.close();
});

test('payment finalization atomically rolls back credentials and outbox on delivery failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-payment-finalize-'));
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(dataDir);
  const projectsFile = path.join(directory, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');

  const script = `
    import assert from 'node:assert/strict';
    const { storePayment, finishStoredPayment } = await import('./src/paymentStore.js');
    const { db } = await import('./src/database.js');

    const entry = {
      projectId: 'atomic-shop',
      paymentId: '91001',
      type: 'qr',
      status: 'Wait',
      event: null,
      sessionHeaders: {
        projectId: 'atomic-shop',
        tokenSN: 'atomic-private-token',
        profileId: 45,
        vtokenSecret: 'encrypted-upstream-token',
      },
      meta: { amount: 9.99, orderId: 'atomic-order' },
      createdAt: 100,
      retryCount: 0,
    };
    storePayment(entry);
    const before = db.prepare('SELECT status,event,session_encrypted,amount_json,meta_json FROM payments WHERE project_id=? AND type=? AND payment_id=?')
      .get(entry.projectId, entry.type, entry.paymentId);
    assert.equal(before.event, null);
    assert.ok(before.session_encrypted);

    const delivery = {
      id: 'atomic-outbox-1',
      projectId: entry.projectId,
      hookId: 'atomic-hook-1',
      url: 'https://atomic.example/hook',
      payload: { event: 'payment.success', projectId: entry.projectId, paymentId: entry.paymentId },
      attempt: 1,
      executeAfter: 200,
    };
    entry.meta.amount = 290;
    db.exec(\`CREATE TRIGGER fail_atomic_delivery BEFORE INSERT ON webhook_deliveries
      BEGIN SELECT RAISE(ABORT, 'intentional delivery failure'); END;\`);
    assert.throws(
      () => finishStoredPayment(entry, 'payment.success', 'Processed', [delivery]),
      /intentional delivery failure/,
    );

    const afterFailure = db.prepare('SELECT status,event,session_encrypted,amount_json,meta_json FROM payments WHERE project_id=? AND type=? AND payment_id=?')
      .get(entry.projectId, entry.type, entry.paymentId);
    assert.equal(afterFailure.status, 'Wait');
    assert.equal(afterFailure.event, null);
    assert.equal(afterFailure.session_encrypted, before.session_encrypted);
    assert.equal(afterFailure.amount_json, before.amount_json);
    assert.equal(afterFailure.meta_json, before.meta_json);
    assert.equal(db.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count, 0);

    db.exec('DROP TRIGGER fail_atomic_delivery');
    finishStoredPayment(entry, 'payment.success', 'Processed', [delivery]);
    const afterSuccess = db.prepare('SELECT status,event,session_encrypted,amount_json,meta_json FROM payments WHERE project_id=? AND type=? AND payment_id=?')
      .get(entry.projectId, entry.type, entry.paymentId);
    assert.equal(afterSuccess.status, 'Processed');
    assert.equal(afterSuccess.event, 'payment.success');
    assert.equal(afterSuccess.session_encrypted, null);
    assert.equal(JSON.parse(afterSuccess.amount_json), 290);
    assert.equal(JSON.parse(afterSuccess.meta_json).amount, 290);
    assert.equal(db.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count, 1);

    finishStoredPayment(entry, 'payment.success', 'Processed', [{ ...delivery, id: 'atomic-outbox-duplicate' }]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count, 1);
    console.log('ATOMIC:' + JSON.stringify({
      rollback: { status: afterFailure.status, event: afterFailure.event, hadSession: Boolean(afterFailure.session_encrypted) },
      success: { status: afterSuccess.status, event: afterSuccess.event, session: afterSuccess.session_encrypted },
      deliveries: db.prepare('SELECT count(*) AS count FROM webhook_deliveries').get().count,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      TOKEN_SECRET_KEY: 'f'.repeat(64),
      ADMIN_API_KEY: 'ledger-admin-key-0123456789abcdef',
      PROJECTS_FILE: projectsFile,
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  try {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const atomic = JSON.parse(result.stdout.split('ATOMIC:').at(-1));
    assert.deepEqual(atomic.rollback, { status: 'Wait', event: null, hadSession: true });
    assert.deepEqual(atomic.success, { status: 'Processed', event: 'payment.success', session: null });
    assert.equal(atomic.deliveries, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
