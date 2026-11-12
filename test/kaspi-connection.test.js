import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { it, mock } from 'node:test';

const lostBody = {
  active: false,
  error: 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.',
  code: 'KASPI_SESSION_EXPIRED',
};

const unavailableBody = {
  error: 'Kaspi Pay временно недоступен. Проверьте статус операции перед повтором.',
  code: 'KASPI_UNAVAILABLE',
};

const upstreamBody = {
  error: 'Kaspi Pay вернул некорректный ответ.',
  code: 'KASPI_UPSTREAM_ERROR',
};

const fakeResponse = (status, body, { malformed = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status >= 400 ? 'Upstream error' : 'OK',
  json: async () => {
    if (malformed) throw new SyntaxError('Unexpected token in JSON');
    return body;
  },
  text: async () => (malformed ? '<html>not JSON</html>' : JSON.stringify(body)),
});

it(
  'maps Kaspi session loss consistently across protected routes and polling without cross-project invalidation',
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-connection-'));
    const projectsFile = path.join(directory, 'projects.json');
    const environmentKeys = [
      'DATA_DIR',
      'TOKEN_SECRET_KEY',
      'PORT',
      'ADMIN_API_KEY',
      'ALPHA_API_KEY',
      'BETA_API_KEY',
      'GAMMA_API_KEY',
      'PROJECTS_FILE',
    ];
    const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      DATA_DIR: directory,
      TOKEN_SECRET_KEY: 'b'.repeat(64),
      PORT: '0',
      ADMIN_API_KEY: 'admin-connection-regression-test-key-0001',
      ALPHA_API_KEY: 'alpha-connection-regression-test-key-0001',
      BETA_API_KEY: 'beta-connection-regression-test-key-0001',
      GAMMA_API_KEY: 'gamma-connection-regression-test-key-0001',
      PROJECTS_FILE: projectsFile,
    });
    fs.writeFileSync(
      projectsFile,
      JSON.stringify(
        ['alpha', 'beta', 'gamma'].map((id) => ({
          id,
          apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
          webhooks: [],
        })),
      ),
    );

    const fetchCalls = [];
    const fetchPlans = [];
    mock.module('node-fetch', {
      defaultExport: async (url, options = {}) => {
        fetchCalls.push({ url: String(url), options });
        const plan = fetchPlans.shift();
        if (plan instanceof Error) throw plan;
        if (typeof plan === 'function') return plan(String(url), options);
        return plan || fakeResponse(200, { StatusCode: 0, Data: { Status: 'Wait' } });
      },
    });

    let server;
    let polling;
    let db;
    let saveMerchantSession;
    let getConnectionSummary;
    let markMerchantSessionInactive;
    let encryptSecret;
    let trackPayment;
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
    ({ db } = await import('../src/database.js'));
    ({ saveMerchantSession, getConnectionSummary, markMerchantSessionInactive } =
      await import('../src/merchantSession.js'));
    ({ encryptSecret } = await import('../src/crypto.js'));
    ({ trackPayment } = polling);

    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, { key, method = 'GET', body, projectId, headers = {} } = {}) =>
      fetch(base + route, {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key === process.env.ADMIN_API_KEY && projectId ? { 'X-Project-ID': projectId } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const apiKey = (projectId) => process.env[`${projectId.toUpperCase()}_API_KEY`];
    const issueSession = (projectId, tokenSN) => {
      const session = {
        tokenSN,
        profileId: projectId === 'alpha' ? 101 : projectId === 'beta' ? 202 : 303,
        vtokenSecret: encryptSecret(Buffer.alloc(32, projectId.charCodeAt(0))),
        orgName: `${projectId} test shop`,
        phone: '+77000000000',
      };
      saveMerchantSession(projectId, session);
      return session;
    };
    const sessionFile = (projectId) => path.join(directory, 'projects', projectId, 'merchant-session.json');
    const assertLostResponse = async (response, label) => {
      assert.equal(response.status, 401, `${label} should return HTTP 401`);
      assert.deepEqual(await response.json(), lostBody, `${label} should return the shared session-loss body`);
    };
    const countPayments = () => db.prepare('SELECT count(*) AS n FROM payments').get().n;

    await t.test('returns the expected admin-cookie auth failure when no cookie exists', async () => {
      const response = await request('/api/session/check', { projectId: 'alpha' });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: 'Войдите в админку или укажите Bearer API-ключ',
        code: 'AUTH_SESSION_EXPIRED',
      });
    });

    await t.test('normalizes missing, corrupt, and locally invalidated sessions before reaching the bank', async () => {
      const callsBefore = fetchCalls.length;
      await assertLostResponse(
        await request('/api/qr/status?qrOperationId=9901', { key: apiKey('gamma') }),
        'missing local session',
      );

      issueSession('gamma', 'gamma-corrupt-token');
      fs.writeFileSync(sessionFile('gamma'), '{broken json');
      await assertLostResponse(
        await request('/api/invoice/client-info?phoneNumber=7001234567', { key: apiKey('gamma') }),
        'corrupt local session',
      );

      issueSession('gamma', 'gamma-invalidated-token');
      const invalidated = JSON.parse(fs.readFileSync(sessionFile('gamma'), 'utf8'));
      fs.writeFileSync(
        sessionFile('gamma'),
        JSON.stringify({ ...invalidated, invalidatedAt: new Date().toISOString() }),
      );
      await assertLostResponse(
        await request('/api/history/operations', {
          key: process.env.ADMIN_API_KEY,
          projectId: 'gamma',
          method: 'POST',
          body: { endDate: '2026-11-11' },
        }),
        'locally invalidated session',
      );
      assert.equal(fetchCalls.length, callsBefore, 'local session failures must not call Kaspi');
    });

    await t.test('converts non-JSON HTTP 401/403 from every protected bank route to the shared response', async () => {
      const alphaSeed = issueSession('alpha', 'alpha-route-seed');
      issueSession('beta', 'beta-isolation-token');
      trackPayment(
        4101,
        'invoice',
        {
          projectId: 'alpha',
          tokenSN: alphaSeed.tokenSN,
          profileId: alphaSeed.profileId,
          vtokenSecret: alphaSeed.vtokenSecret,
        },
        { amount: 10 },
        'alpha',
      );
      trackPayment(
        4102,
        'qr',
        {
          projectId: 'alpha',
          tokenSN: alphaSeed.tokenSN,
          profileId: alphaSeed.profileId,
          vtokenSecret: alphaSeed.vtokenSecret,
        },
        { amount: 10 },
        'alpha',
      );

      const routes = [
        { route: '/api/invoice/client-info?phoneNumber=7001234567' },
        {
          route: '/api/invoice/create',
          method: 'POST',
          body: { amount: 10, phoneNumber: '7001234567', orderId: 'rejected-invoice' },
          rejectedPaymentId: 'rejected-invoice',
        },
        { route: '/api/invoice/details?operationId=4101' },
        { route: '/api/invoice/cancel', method: 'POST', body: { operationId: 4101 } },
        { route: '/api/invoice/history', method: 'POST', body: {}, admin: true },
        {
          route: '/api/qr/create',
          method: 'POST',
          body: { amount: 10, orderId: 'rejected-qr' },
          rejectedPaymentId: 'rejected-qr',
        },
        { route: '/api/qr/status?qrOperationId=4102' },
        { route: '/api/history/operations', method: 'POST', body: { endDate: '2026-11-11' }, admin: true },
        { route: '/api/history/details', method: 'POST', body: { id: 4101 }, admin: true },
        { route: '/api/refund/create', method: 'POST', body: { qrOperationId: 4102, returnAmount: 1 } },
        { route: '/api/session/check', admin: true },
      ];
      const initialPaymentCount = countPayments();

      for (const [index, routeCase] of routes.entries()) {
        const tokenSN = `alpha-route-token-${index}`;
        issueSession('alpha', tokenSN);
        fetchPlans.push(fakeResponse(index % 2 === 0 ? 401 : 403, undefined, { malformed: true }));
        const before = fetchCalls.length;
        const response = await request(routeCase.route, {
          key: routeCase.admin ? process.env.ADMIN_API_KEY : apiKey('alpha'),
          projectId: routeCase.admin ? 'alpha' : undefined,
          method: routeCase.method || 'GET',
          body: routeCase.body,
        });
        await assertLostResponse(response, routeCase.route);
        assert.equal(fetchCalls.length, before + 1, `${routeCase.route} should issue one mocked bank request`);
        assert.equal(fetchCalls.at(-1).options.headers['X-Kb-TokenSn'], tokenSN);
        const storedSession = JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8'));
        assert.equal(storedSession.tokenSN, tokenSN);
        assert.equal(typeof storedSession.invalidatedAt, 'string');
        assert.equal(getConnectionSummary('beta').connected, true, 'alpha failure must not invalidate beta');
        if (routeCase.rejectedPaymentId) {
          assert.equal(
            db
              .prepare('SELECT 1 FROM payments WHERE project_id=? AND order_id=?')
              .get('alpha', routeCase.rejectedPaymentId),
            undefined,
            'a declined invoice/QR creation must not be persisted as a payment',
          );
        }
        assert.equal(countPayments(), initialPaymentCount, 'failed operations must not add payment rows');
      }

      const session = issueSession('beta', 'beta-isolation-token');
      fetchPlans.push(fakeResponse(200, { StatusCode: 0, Data: { Status: 'Wait' } }));
      const betaResponse = await request('/api/invoice/client-info?phoneNumber=7001234567', { key: apiKey('beta') });
      assert.equal(betaResponse.status, 200);
      assert.deepEqual(await betaResponse.json(), { StatusCode: 0, Data: { Status: 'Wait' } });
      assert.equal(fetchCalls.at(-1).options.headers['X-Kb-TokenSn'], session.tokenSN);
      assert.equal(getConnectionSummary('beta').connected, true);

      for (const [tokenSN, statusCode] of [
        ['alpha-code-number', -101001],
        ['alpha-code-string', '-101001'],
      ]) {
        issueSession('alpha', tokenSN);
        fetchPlans.push(fakeResponse(200, { StatusCode: statusCode, Message: 'Session expired' }));
        await assertLostResponse(
          await request('/api/qr/status?qrOperationId=4102', { key: apiKey('alpha') }),
          `StatusCode ${statusCode}`,
        );
        assert.equal(JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8')).tokenSN, tokenSN);
        assert.equal(typeof JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8')).invalidatedAt, 'string');
        assert.equal(getConnectionSummary('beta').connected, true);
      }
    });

    await t.test('does not invalidate a replacement session when an older in-flight response expires', async () => {
      issueSession('alpha', 'alpha-stale-token');
      let notifyStarted;
      let finishResponse;
      const started = new Promise((resolve) => {
        notifyStarted = resolve;
      });
      fetchPlans.push((_url, options) => {
        notifyStarted(options);
        return new Promise((resolve) => {
          finishResponse = resolve;
        });
      });

      const pendingRequest = request('/api/session/check', {
        key: process.env.ADMIN_API_KEY,
        projectId: 'alpha',
      });
      const oldRequestOptions = await started;
      assert.equal(oldRequestOptions.headers['X-Kb-TokenSn'], 'alpha-stale-token');
      issueSession('alpha', 'alpha-current-token');
      finishResponse(fakeResponse(401, undefined, { malformed: true }));
      await assertLostResponse(await pendingRequest, 'stale session response');
      assert.equal(getConnectionSummary('alpha').connected, true, 'the replacement token must remain active');
      assert.equal(JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8')).tokenSN, 'alpha-current-token');
    });

    await t.test('a successful old-token check cannot replace or reactivate the current session', async () => {
      const runDelayedCheck = async (tokenSN, prepareReplacement) => {
        issueSession('alpha', tokenSN);
        let notifyStarted;
        let finishResponse;
        const started = new Promise((resolve) => {
          notifyStarted = resolve;
        });
        fetchPlans.push((_url, options) => {
          notifyStarted(options);
          return new Promise((resolve) => {
            finishResponse = resolve;
          });
        });

        const pendingRequest = request('/api/session/check', {
          key: process.env.ADMIN_API_KEY,
          projectId: 'alpha',
        });
        const oldRequestOptions = await started;
        assert.equal(oldRequestOptions.headers['X-Kb-TokenSn'], tokenSN);
        const beforeResponse = await prepareReplacement();
        finishResponse(fakeResponse(200, { StatusCode: '0', Data: { Operations: [] } }));
        const response = await pendingRequest;
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: 'Подключение к Kaspi Pay изменилось. Повторите проверку.',
          code: 'KASPI_SESSION_CHANGED',
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8')), beforeResponse);
      };

      await runDelayedCheck('alpha-old-success-token', async () => {
        issueSession('alpha', 'alpha-new-success-token');
        return JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8'));
      });
      assert.equal(getConnectionSummary('alpha').connected, true, 'the replacement token must remain active');
      assert.equal(JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8')).tokenSN, 'alpha-new-success-token');

      await runDelayedCheck('alpha-invalidated-success-token', async () => {
        const current = JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8'));
        markMerchantSessionInactive('alpha', current.tokenSN);
        return JSON.parse(fs.readFileSync(sessionFile('alpha'), 'utf8'));
      });
      assert.equal(getConnectionSummary('alpha').connected, false, 'success must not reactivate an invalidated token');
    });

    await t.test('classifies network/upstream failures and preserves normal business responses', async () => {
      issueSession('alpha', 'alpha-availability-token');

      fetchPlans.push(new Error('simulated connection reset'));
      let response = await request('/api/invoice/client-info?phoneNumber=7001234567', { key: apiKey('alpha') });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), unavailableBody);
      assert.equal(getConnectionSummary('alpha').connected, true, 'network failure must not invalidate the session');

      fetchPlans.push(fakeResponse(503, { Message: 'Bank outage' }));
      response = await request('/api/qr/status?qrOperationId=4102', { key: apiKey('alpha') });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), unavailableBody);
      assert.equal(getConnectionSummary('alpha').connected, true, 'bank 5xx must not invalidate the session');

      fetchPlans.push(fakeResponse(404, { Message: 'Missing operation' }));
      response = await request('/api/invoice/client-info?phoneNumber=7001234567', { key: apiKey('alpha') });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), upstreamBody);
      assert.equal(getConnectionSummary('alpha').connected, true);

      fetchPlans.push(fakeResponse(200, undefined, { malformed: true }));
      response = await request('/api/history/operations', {
        key: process.env.ADMIN_API_KEY,
        projectId: 'alpha',
        method: 'POST',
        body: { endDate: '2026-11-11' },
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), upstreamBody);
      assert.equal(getConnectionSummary('alpha').connected, true);

      const businessError = { StatusCode: 1234, Message: 'Operation cannot be refunded' };
      fetchPlans.push(fakeResponse(200, businessError));
      response = await request('/api/qr/status?qrOperationId=4102', { key: apiKey('alpha') });
      assert.equal(response.status, 200, 'HTTP 200 business errors remain a successful bank response');
      assert.deepEqual(await response.json(), businessError);
      assert.equal(getConnectionSummary('alpha').connected, true);

      fetchPlans.push(fakeResponse(200, { StatusCode: 55, Message: 'Connection is not valid' }));
      response = await request('/api/session/check', {
        key: process.env.ADMIN_API_KEY,
        projectId: 'alpha',
      });
      assert.equal(response.status, 502, 'session check accepts only StatusCode 0 or a missing code');
      assert.deepEqual(await response.json(), { error: 'Connection is not valid', code: 'KASPI_UPSTREAM_ERROR' });
      assert.equal(getConnectionSummary('alpha').connected, true, 'a business error is not a session rejection');

      for (const [index, statusCode] of [null, '', ' ', false].entries()) {
        issueSession('alpha', `alpha-invalid-code-${index}`);
        fetchPlans.push(fakeResponse(200, { StatusCode: statusCode, Message: 'Invalid status code' }));
        response = await request('/api/session/check', {
          key: process.env.ADMIN_API_KEY,
          projectId: 'alpha',
        });
        assert.equal(response.status, 502, `StatusCode ${JSON.stringify(statusCode)} is not a success code`);
        assert.deepEqual(await response.json(), {
          error: 'Invalid status code',
          code: 'KASPI_UPSTREAM_ERROR',
        });
        assert.equal(getConnectionSummary('alpha').connected, true);
      }

      for (const [index, statusCode] of [0, '0'].entries()) {
        issueSession('alpha', `alpha-valid-code-${index}`);
        fetchPlans.push(fakeResponse(200, { StatusCode: statusCode }));
        response = await request('/api/session/check', {
          key: process.env.ADMIN_API_KEY,
          projectId: 'alpha',
        });
        assert.equal(response.status, 200, `StatusCode ${JSON.stringify(statusCode)} is a success code`);
      }

      fetchPlans.push(fakeResponse(200, { Data: { Operations: [] } }));
      response = await request('/api/session/check', {
        key: process.env.ADMIN_API_KEY,
        projectId: 'alpha',
      });
      assert.equal(response.status, 200, 'a session check without StatusCode is successful');
      assert.deepEqual(await response.json(), {
        active: true,
        profileId: 101,
        orgName: 'alpha test shop',
        phone: '+77000000000',
      });
    });

    await t.test(
      'polling closes lost-session payments immediately but retries network errors through attempt eleven',
      async () => {
        db.prepare('DELETE FROM payments WHERE event IS NULL').run();
        const alphaSession = issueSession('alpha', 'alpha-poll-401');
        trackPayment(
          9001,
          'qr',
          {
            projectId: 'alpha',
            tokenSN: alphaSession.tokenSN,
            profileId: alphaSession.profileId,
            vtokenSecret: alphaSession.vtokenSecret,
          },
          { amount: 10 },
          'alpha',
        );
        fetchPlans.push(fakeResponse(401, undefined, { malformed: true }));
        await polling.pollOnce();
        let payment = db
          .prepare(
            'SELECT status,event,retry_count,session_encrypted FROM payments WHERE project_id=? AND payment_id=?',
          )
          .get('alpha', '9001');
        assert.equal(payment.status, 'SessionExpired');
        assert.equal(payment.event, 'payment.lost');
        assert.equal(payment.retry_count, 0);
        assert.equal(payment.session_encrypted, null);
        assert.equal(getConnectionSummary('alpha').connected, false);

        const betaSession = issueSession('beta', 'beta-poll-403');
        trackPayment(
          9002,
          'invoice',
          {
            projectId: 'beta',
            tokenSN: betaSession.tokenSN,
            profileId: betaSession.profileId,
            vtokenSecret: betaSession.vtokenSecret,
          },
          { amount: 10 },
          'beta',
        );
        fetchPlans.push(fakeResponse(403, undefined, { malformed: true }));
        await polling.pollOnce();
        payment = db
          .prepare('SELECT status,event,retry_count FROM payments WHERE project_id=? AND payment_id=?')
          .get('beta', '9002');
        assert.equal(payment.status, 'SessionExpired');
        assert.equal(payment.event, 'payment.lost');
        assert.equal(payment.retry_count, 0);
        assert.equal(getConnectionSummary('beta').connected, false);

        const gammaExpiredSession = issueSession('gamma', 'gamma-poll-code');
        trackPayment(
          9003,
          'qr',
          {
            projectId: 'gamma',
            tokenSN: gammaExpiredSession.tokenSN,
            profileId: gammaExpiredSession.profileId,
            vtokenSecret: gammaExpiredSession.vtokenSecret,
          },
          { amount: 10 },
          'gamma',
        );
        fetchPlans.push(fakeResponse(200, { StatusCode: '-101001' }));
        await polling.pollOnce();
        payment = db
          .prepare('SELECT status,event,retry_count FROM payments WHERE project_id=? AND payment_id=?')
          .get('gamma', '9003');
        assert.equal(payment.status, 'SessionExpired');
        assert.equal(payment.event, 'payment.lost');
        assert.equal(payment.retry_count, 0);
        assert.equal(getConnectionSummary('gamma').connected, false);

        const gammaSession = issueSession('gamma', 'gamma-network-token');
        trackPayment(
          9004,
          'invoice',
          {
            projectId: 'gamma',
            tokenSN: gammaSession.tokenSN,
            profileId: gammaSession.profileId,
            vtokenSecret: gammaSession.vtokenSecret,
          },
          { amount: 10 },
          'gamma',
        );
        for (let attempt = 1; attempt <= 10; attempt++) {
          fetchPlans.push(new Error('simulated network outage'));
          await polling.pollOnce();
          payment = db
            .prepare(
              'SELECT status,event,retry_count,session_encrypted FROM payments WHERE project_id=? AND payment_id=?',
            )
            .get('gamma', '9004');
          assert.equal(payment.event, null, `network failure ${attempt} stays pending`);
          assert.equal(payment.retry_count, attempt);
          assert.ok(payment.session_encrypted);
          assert.equal(getConnectionSummary('gamma').connected, true);
        }
        fetchPlans.push(new Error('simulated network outage'));
        await polling.pollOnce();
        payment = db
          .prepare(
            'SELECT status,event,retry_count,session_encrypted FROM payments WHERE project_id=? AND payment_id=?',
          )
          .get('gamma', '9004');
        assert.equal(payment.status, 'PollingFailed');
        assert.equal(payment.event, 'payment.lost');
        assert.equal(payment.retry_count, 10);
        assert.equal(payment.session_encrypted, null);
        assert.equal(getConnectionSummary('gamma').connected, true, 'poll exhaustion must not invalidate a session');
      },
    );
  },
);
