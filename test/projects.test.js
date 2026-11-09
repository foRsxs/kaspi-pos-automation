import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';

const computeXSignInput = ({ url, options }) => {
  const headers = options.headers;
  const lines = headers['X-SH']
    .split(',')
    .map((name) => (name === 'url' ? `url:${url.toLowerCase()}` : `${name.toLowerCase()}:${headers[name] || ''}`));
  if (options.body) lines.push(options.body);
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest();
};

it('isolates project payments and persists signed webhook retries and completed ownership', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-projects-'));
  Object.assign(process.env, {
    DATA_DIR: directory,
    TOKEN_SECRET_KEY: 'a'.repeat(64),
    PORT: '0',
    ADMIN_API_KEY: 'admin'.repeat(10),
    SHOP_API_KEY: 'shop'.repeat(10),
    BOOKING_API_KEY: 'booking'.repeat(10),
    SHOP_WEBHOOK_SECRET: 'secret-shop'.repeat(4),
    BOOKING_WEBHOOK_SECRET: 'secret-booking'.repeat(4),
    PROJECTS_FILE: path.join(directory, 'projects.json'),
  });
  fs.writeFileSync(
    process.env.PROJECTS_FILE,
    JSON.stringify(
      ['shop', 'booking'].map((id) => ({
        id,
        apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
        webhooks: [
          {
            url: `https://${id}.example/hook`,
            events: ['payment.success', 'payment.failed', 'payment.expired', 'payment.lost'],
            secretEnv: `${id.toUpperCase()}_WEBHOOK_SECRET`,
          },
        ],
      })),
    ),
  );
  let operation = 100;
  let bankStatus = 'Wait';
  let hookStatus = 500;
  let now = Date.now();
  mock.method(Date, 'now', () => now);
  const deliveries = [];
  const bankRequests = [];
  mock.module('node-fetch', {
    defaultExport: async (url, options) => {
      if (url.endsWith('.example/hook')) {
        deliveries.push({ url, options });
        return { ok: hookStatus === 200, status: hookStatus };
      }
      bankRequests.push({ url, options });
      const Data = url.includes('/create')
        ? { QrOperationId: ++operation, QrToken: 'https://qr.kaspi.kz/test', Amount: 1.01 }
        : { Status: bankStatus };
      return { ok: true, status: 200, json: async () => ({ StatusCode: 0, Data }) };
    },
  });
  const { encryptSecret } = await import('../src/crypto.js');
  const { saveMerchantSession } = await import('../src/merchantSession.js');
  const { getIdentity } = await import('../src/identity.js');
  const polling = await import('../src/polling.js');
  const { server } = await import('../server.js');
  if (!server.listening) await once(server, 'listening');
  await polling.stopPolling();
  const { db } = await import('../src/database.js');
  const readLedger = () => ({
    payments: db.prepare('SELECT * FROM payments').all(),
    deliveries: db.prepare('SELECT * FROM webhook_deliveries').all(),
  });

  t.after(async () => {
    await polling.stopPolling();
    await new Promise((resolve) => server.close(resolve));
    mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, key, body, extra = {}) =>
    fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const shopKey = process.env.SHOP_API_KEY;
  const bookingKey = process.env.BOOKING_API_KEY;
  const adminKey = process.env.ADMIN_API_KEY;
  const bankCount = () => bankRequests.length;
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/payments')).status, 401);
  assert.equal((await request('/api/payments', 'invalid')).status, 401);
  assert.deepEqual((await (await request('/api/projects', adminKey)).json()).projects.map(({ id }) => id).sort(), [
    'booking',
    'shop',
  ]);
  assert.equal((await request('/api/projects', shopKey)).status, 403);
  for (const route of ['/api/auth/init', '/api/history/operations', '/api/invoice/history']) {
    assert.equal((await request(route, shopKey, {})).status, 403);
  }
  assert.equal((await request('/api/session/check', shopKey)).status, 403);
  assert.equal((await request('/api/qr/create', shopKey, { amount: 10 })).status, 401);
  assert.equal((await request('/api/qr/create', adminKey, { amount: 10 })).status, 400);
  assert.equal((await request('/api/qr/create', adminKey, { amount: 10 }, { 'X-Project-ID': 'unknown' })).status, 404);
  assert.equal((await request('/api/qr/create', shopKey, { amount: 10 }, { 'X-Project-ID': 'booking' })).status, 403);
  assert.equal(bankCount(), 0, 'unauthorized requests must not reach Kaspi');
  const shopSession = {
    tokenSN: 'shop-token',
    profileId: 42,
    vtokenSecret: encryptSecret(Buffer.alloc(32, 1)),
  };
  const bookingSession = {
    tokenSN: 'booking-token',
    profileId: 84,
    vtokenSecret: encryptSecret(Buffer.alloc(32, 2)),
  };
  saveMerchantSession('shop', shopSession);
  saveMerchantSession('booking', bookingSession);
  const shopIdentity = getIdentity('shop');
  const bookingIdentity = getIdentity('booking');
  assert.equal(shopIdentity.directory, path.join(directory, 'projects', 'shop'));
  assert.equal(bookingIdentity.directory, path.join(directory, 'projects', 'booking'));
  assert.notEqual(shopIdentity.device.deviceId, bookingIdentity.device.deviceId);
  assert.notDeepEqual(
    shopIdentity.keyPair.publicKey.export({ type: 'spki', format: 'der' }),
    bookingIdentity.keyPair.publicKey.export({ type: 'spki', format: 'der' }),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(shopIdentity.directory, 'merchant-session.json'))).tokenSN,
    'shop-token',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(bookingIdentity.directory, 'merchant-session.json'))).tokenSN,
    'booking-token',
  );
  for (const amount of [-1, 'invalid', 0, '0.004']) {
    assert.equal((await request('/api/qr/create', shopKey, { amount })).status, 400);
    assert.equal((await request('/api/invoice/create', shopKey, { amount, phoneNumber: '7001234567' })).status, 400);
  }
  const created = await (
    await request(
      '/api/qr/create',
      shopKey,
      { amount: '1.005', orderId: 'shop-order-1', projectId: 'booking' },
      { 'X-Token-SN': 'forged', 'X-Profile-ID': '999', 'X-Vtoken-Secret': 'forged' },
    )
  ).json();
  assert.equal(created.Data.QrOperationId, 101);
  assert.equal(JSON.parse(bankRequests.at(-1).options.body).PaymentAmount, 1.01);
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'shop-token');
  assert.equal(bankRequests.at(-1).options.headers['X-PI'], '42');
  assert.equal(bankRequests.at(-1).options.headers['X-Device-ID'], shopIdentity.device.deviceId);
  assert.equal(
    crypto.verify(
      'SHA256',
      computeXSignInput(bankRequests.at(-1)),
      shopIdentity.keyPair.publicKey,
      Buffer.from(bankRequests.at(-1).options.headers['X-Sign'], 'base64'),
    ),
    true,
    'shop creation request must use the shop ECDSA identity',
  );
  assert.equal(created.Data.QrOriginalToken, 'https://qr.kaspi.kz/test');
  assert.equal((await request('/api/qr/status?qrOperationId=101', shopKey)).status, 200);
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'shop-token');
  const beforeForbidden = bankCount();
  assert.equal((await request('/api/qr/status?qrOperationId=101', bookingKey)).status, 404);
  assert.equal((await request('/api/refund/create', bookingKey, { qrOperationId: 101, returnAmount: 1 })).status, 404);
  assert.equal((await request('/api/qr/status?qrOperationId=101%26other=1', shopKey)).status, 400);
  assert.equal(bankCount(), beforeForbidden);
  assert.equal((await request('/api/qr/status?qrOperationId=101', adminKey)).status, 400);
  assert.equal(
    (await request('/api/qr/status?qrOperationId=101', adminKey, undefined, { 'X-Project-ID': 'booking' })).status,
    200,
  );
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'booking-token');
  assert.equal(
    (await request('/api/qr/status?qrOperationId=101', adminKey, undefined, { 'X-Project-ID': 'shop' })).status,
    200,
  );
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'shop-token');
  const shopPayments = await (await request('/api/payments', shopKey)).json();
  assert.equal(shopPayments.payments[0].orderId, 'shop-order-1');
  assert.ok(!JSON.stringify(shopPayments).includes('shop-token'));
  assert.deepEqual((await (await request('/api/payments', bookingKey)).json()).payments, []);

  const invoice = await (
    await request('/api/invoice/create', bookingKey, { amount: 10, phoneNumber: '7001234567', orderId: 'booking-1' })
  ).json();
  assert.equal(invoice.Data.QrOperationId, 102);
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'booking-token');
  assert.equal(bankRequests.at(-1).options.headers['X-PI'], '84');
  assert.equal(bankRequests.at(-1).options.headers['X-Device-ID'], bookingIdentity.device.deviceId);
  assert.equal(
    crypto.verify(
      'SHA256',
      computeXSignInput(bankRequests.at(-1)),
      bookingIdentity.keyPair.publicKey,
      Buffer.from(bankRequests.at(-1).options.headers['X-Sign'], 'base64'),
    ),
    true,
    'booking creation request must use the booking ECDSA identity',
  );
  assert.equal(
    (
      await request(
        '/api/invoice/create',
        bookingKey,
        { amount: 2, phoneNumber: '7001234567' },
        { 'X-Project-ID': 'shop' },
      )
    ).status,
    403,
  );
  assert.equal((await request('/api/invoice/details?operationId=102', shopKey)).status, 404);
  assert.equal((await request('/api/invoice/cancel', shopKey, { operationId: 102 })).status, 404);
  assert.equal((await request('/api/invoice/details?operationId=102', bookingKey)).status, 200);
  assert.equal((await request('/api/invoice/cancel', bookingKey, { operationId: 102 })).status, 200);
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'booking-token');

  const tracked = polling.getTrackedPayments();
  assert.equal(tracked['["shop","qr","101"]'].sessionHeaders.projectId, 'shop');
  assert.equal(tracked['["booking","invoice","102"]'].sessionHeaders.projectId, 'booking');

  bankStatus = 'NewUndocumentedBankStatus';
  const pollStart = bankRequests.length;
  await polling.pollOnce();
  assert.equal(deliveries.length, 0, 'unknown bank status must not trigger false failure');
  assert.equal(Object.keys(polling.getTrackedPayments()).length, 2);
  const polledShop = bankRequests
    .slice(pollStart)
    .find(({ options }) => options.headers['X-Kb-TokenSn'] === 'shop-token');
  const polledBooking = bankRequests
    .slice(pollStart)
    .find(({ options }) => options.headers['X-Kb-TokenSn'] === 'booking-token');
  assert.ok(polledShop, 'poller must check the shop payment with the shop token');
  assert.ok(polledBooking, 'poller must check the booking payment with the booking token');
  assert.equal(polledShop.options.headers['X-Device-ID'], shopIdentity.device.deviceId);
  assert.equal(polledBooking.options.headers['X-Device-ID'], bookingIdentity.device.deviceId);
  assert.equal(
    crypto.verify(
      'SHA256',
      computeXSignInput(polledShop),
      shopIdentity.keyPair.publicKey,
      Buffer.from(polledShop.options.headers['X-Sign'], 'base64'),
    ),
    true,
    'shop polling request must use the shop ECDSA identity',
  );
  assert.equal(
    crypto.verify(
      'SHA256',
      computeXSignInput(polledBooking),
      bookingIdentity.keyPair.publicKey,
      Buffer.from(polledBooking.options.headers['X-Sign'], 'base64'),
    ),
    true,
    'booking polling request must use the booking ECDSA identity',
  );
  assert.notEqual(polledShop.options.headers['X-Sign'], polledBooking.options.headers['X-Sign']);
  bankStatus = 'Processed';
  await polling.pollOnce();
  assert.equal(deliveries.length, 2);
  for (const { url, options } of deliveries) {
    const payload = JSON.parse(options.body);
    assert.equal(url, `https://${payload.projectId}.example/hook`);
    assert.equal(payload.event, 'payment.success');
    assert.equal(
      options.headers['X-Webhook-Signature'],
      'sha256=' +
        crypto
          .createHmac('sha256', process.env[`${payload.projectId.toUpperCase()}_WEBHOOK_SECRET`])
          .update(options.body)
          .digest('hex'),
    );
  }
  let persisted = readLedger();
  assert.equal(persisted.deliveries.length, 2, 'HTTP 500 queues retries');
  assert.ok(
    persisted.payments.every((row) => row.session_encrypted === null),
    'finished entries must discard credentials',
  );
  assert.ok(!JSON.stringify(persisted).includes(process.env.SHOP_WEBHOOK_SECRET));
  assert.equal(persisted.payments.length, 2, 'final payments retain ownership');
  assert.equal(Object.keys(polling.getTrackedPayments()).length, 0);
  assert.equal(
    (await request('/api/refund/create', shopKey, { qrOperationId: 101, returnAmount: '0.505' })).status,
    200,
  );
  assert.equal(JSON.parse(bankRequests.at(-1).options.body).ReturnAmount, 0.51);
  assert.equal(bankRequests.at(-1).options.headers['X-Kb-TokenSn'], 'shop-token');
  assert.equal((await request('/api/refund/create', bookingKey, { qrOperationId: 101, returnAmount: 1 })).status, 404);

  const restarted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const p = await import('./src/polling.js'); console.log('RESTORED:' + JSON.stringify(p.listPayments('shop'))); await p.stopPolling();",
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.ok(restarted.stdout.includes('shop-order-1'), 'completed ownership survives process restart');
  assert.equal(readLedger().deliveries.length, 2, 'outbox survives process restart');
  now += 5001;
  hookStatus = 200;
  await polling.pollOnce();
  assert.equal(deliveries.length, 4);
  assert.equal(deliveries[0].options.headers['X-Webhook-ID'], deliveries[2].options.headers['X-Webhook-ID']);
  persisted = readLedger();
  assert.equal(persisted.deliveries.length, 0);
  await polling.pollOnce();
  assert.equal(deliveries.length, 4, 'completed deliveries must not be emitted again');

  const expired = { amount: 10, expireDate: new Date(now - 1000).toISOString() };
  polling.trackPayment(201, 'qr', { ...shopSession, projectId: 'shop' }, expired, 'shop');
  bankStatus = 'Processed';
  await polling.pollOnce();
  assert.equal(JSON.parse(deliveries.at(-1).options.body).event, 'payment.success', 'paid wins over local TTL');
  polling.trackPayment(202, 'qr', { ...shopSession, projectId: 'shop' }, expired, 'shop');
  bankStatus = 'Wait';
  await polling.pollOnce();
  assert.equal(JSON.parse(deliveries.at(-1).options.body).event, 'payment.expired');
  const beforeRepeatedExpiry = deliveries.length;
  await polling.pollOnce();
  assert.equal(deliveries.length, beforeRepeatedExpiry, 'expiry event is emitted only once');

  polling.trackPayment(203, 'qr', { ...bookingSession, projectId: 'booking' }, { amount: 10 }, 'booking');
  bankStatus = 'Processed';
  hookStatus = 500;
  const beforeExhaustion = deliveries.length;
  await polling.pollOnce();
  now += 5001;
  await polling.pollOnce();
  now += 30001;
  await polling.pollOnce();
  assert.equal(deliveries.length, beforeExhaustion + 3);
  assert.equal(readLedger().deliveries.length, 0, 'retry limit is enforced');

  db.exec(
    "CREATE TRIGGER fail_payment_insert BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
  );
  const diskFailure = await request('/api/qr/create', shopKey, { amount: 5 });
  db.exec('DROP TRIGGER fail_payment_insert');
  assert.equal(diskFailure.status, 202, 'a bank-created operation must not look like a failed creation');
  const uncertain = await diskFailure.json();
  assert.equal(uncertain.tracking.persisted, false);
  assert.equal(uncertain.Data.QrOperationId, 103);
  await polling.pollOnce();
  assert.ok(polling.ownsPayment('shop', 'qr', 103), 'failed initial writes are retried after storage recovers');
  polling.trackPayment(401, 'qr', { ...shopSession, projectId: 'shop' }, { amount: 10 }, 'shop');
  polling.trackPayment(402, 'qr', { ...shopSession, projectId: 'shop' }, { amount: 10 }, 'shop');
  db.prepare(
    "UPDATE payments SET session_encrypted='corrupt-session' WHERE project_id='shop' AND payment_id='401'",
  ).run();
  await polling.pollOnce();
  assert.equal(
    db.prepare("SELECT retry_count FROM payments WHERE project_id='shop' AND payment_id='401'").get().retry_count,
    1,
  );
  assert.equal(
    db.prepare("SELECT event FROM payments WHERE project_id='shop' AND payment_id='402'").get().event,
    'payment.success',
    'one unreadable session must not block other pending payments',
  );
});
