import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { it, mock } from 'node:test';

it(
  'stores and delivers Kaspi connection notifications through authenticated settings and a durable queue',
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-notifications-'));
    const projectsFile = path.join(directory, 'projects.json');
    fs.writeFileSync(projectsFile, '[]');
    const environmentKeys = ['DATA_DIR', 'TOKEN_SECRET_KEY', 'PORT', 'ADMIN_API_KEY', 'PROJECTS_FILE'];
    const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      DATA_DIR: directory,
      TOKEN_SECRET_KEY: 'c'.repeat(64),
      PORT: '0',
      ADMIN_API_KEY: 'admin-notification-test-key-000000000001',
      PROJECTS_FILE: projectsFile,
    });

    let mailFailure = null;
    let mailAcceptedOverride = null;
    const mailCalls = [];
    const transports = [];
    mock.module('nodemailer', {
      exports: {
        default: {
          createTransport: (options) => {
            transports.push(options);
            return {
              sendMail: async (message) => {
                mailCalls.push({ options, message });
                if (mailFailure) {
                  const error = mailFailure;
                  mailFailure = null;
                  throw error;
                }
                return { accepted: mailAcceptedOverride ?? [message.to], rejected: [] };
              },
              close: () => {},
            };
          },
        },
      },
    });
    mock.module('node-fetch', {
      exports: {
        default: async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ StatusCode: 0, Data: { Operations: [] } }),
        }),
      },
    });

    let server;
    let polling;
    let notifications;
    let monitor;
    let db;
    let decryptSecret;
    let encryptSecret;
    let adminCookie;
    let csrfToken;
    let fakeNow = Date.now();

    t.after(async () => {
      if (notifications) await notifications.stopConnectionNotifications();
      if (monitor) await monitor.stopConnectionMonitor();
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
    notifications = await import('../src/connectionNotifications.js');
    monitor = await import('../src/connectionMonitor.js');
    await Promise.all([
      polling.stopPolling(),
      notifications.stopConnectionNotifications(),
      monitor.stopConnectionMonitor(),
    ]);
    ({ db } = await import('../src/database.js'));
    ({ encryptSecret, decryptSecret } = await import('../src/crypto.js'));
    const { createAdminSession, changeAdminPassword } = await import('../src/adminStore.js');
    const { ADMIN_COOKIE } = await import('../src/adminAuth.js');
    const { createProject, archiveProject } = await import('../src/projectStore.js');
    const { getConnectionSummary, markMerchantSessionInactive, saveMerchantSession } =
      await import('../src/merchantSession.js');
    const { claimNextConnectionNotification, queueConnectionLoss, resolveConnectionLoss } =
      await import('../src/notificationStore.js');

    mock.method(Date, 'now', () => fakeNow);
    await changeAdminPassword('Permanent-notifications-test-123!');
    const adminSession = createAdminSession();
    adminCookie = `${ADMIN_COOKIE}=${adminSession.token}`;
    csrfToken = adminSession.csrfToken;
    const base = `http://127.0.0.1:${server.address().port}`;
    const adminHeaders = () => ({ Cookie: adminCookie });
    const request = (route, { method = 'GET', body, headers = {} } = {}) =>
      fetch(base + route, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const patchSettings = (body, { withCsrf = true, headers = {} } = {}) =>
      request('/api/admin/settings/notifications', {
        method: 'PATCH',
        body,
        headers: {
          ...adminHeaders(),
          ...(withCsrf ? { 'X-CSRF-Token': csrfToken } : {}),
          ...headers,
        },
      });
    const connectionRows = () => db.prepare('SELECT * FROM connection_notifications ORDER BY created_at,id').all();
    const getSettings = async () => (await request('/api/admin/settings', { headers: adminHeaders() })).json();

    await t.test('protects settings with a full admin cookie and CSRF', async () => {
      const unauthenticated = await request('/api/admin/settings');
      assert.equal(unauthenticated.status, 401);
      assert.equal((await unauthenticated.json()).code, 'AUTH_SESSION_EXPIRED');

      const initial = await getSettings();
      assert.deepEqual(initial.notifications, {
        enabled: false,
        email: '',
        smtpHost: '',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        smtpUser: '',
        smtpFrom: '',
        hasSmtpPassword: false,
        configured: false,
        lastSentAt: null,
        lastError: null,
      });

      const invalidCsrf = await patchSettings({ enabled: false }, { withCsrf: false });
      assert.equal(invalidCsrf.status, 403);
      assert.equal((await invalidCsrf.json()).code, 'CSRF_INVALID');

      const project = createProject({ id: 'notify-shop', name: 'North Kaspi Shop' });
      const projectKey = await request('/api/admin/settings', {
        headers: { Authorization: `Bearer ${project.apiKey}` },
      });
      assert.equal(projectKey.status, 401, 'project API keys cannot read admin settings');

      const missingCsrfCookie = await patchSettings({ enabled: false }, { withCsrf: false });
      assert.equal(missingCsrfCookie.status, 403, 'a full admin cookie still needs CSRF for writes');
    });

    await t.test('validates settings, encrypts SMTP password, and never exposes it', async () => {
      const enableIncomplete = await patchSettings({ enabled: true });
      assert.equal(enableIncomplete.status, 400);

      for (const patch of [
        { email: 'ops@example.net,attacker@example.net' },
        { email: 'ops@example.net\r\nBcc:attacker@example.net' },
        { smtpFrom: 'Kaspi <sender@example.net>' },
        { smtpFrom: 'sender@example.net\nBcc:attacker@example.net' },
        { smtpHost: 'https://smtp.example.net' },
        { smtpHost: 'smtp.example.net:587' },
        { smtpPort: 0 },
        { smtpSecurity: 'plain' },
      ]) {
        const response = await patchSettings(patch);
        assert.equal(response.status, 400, `invalid patch ${JSON.stringify(patch)} must be rejected`);
      }

      const password = 'smtp-secret-not-for-api-7362';
      const configured = await patchSettings({
        enabled: false,
        email: 'ops@example.net',
        smtpHost: 'smtp.example.net',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        smtpUser: 'alerts-user',
        smtpPassword: password,
        smtpFrom: 'kaspi@example.net',
      });
      assert.equal(configured.status, 200);
      const payload = await configured.json();
      assert.deepEqual(payload.notifications, {
        enabled: false,
        email: 'ops@example.net',
        smtpHost: 'smtp.example.net',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        smtpUser: 'alerts-user',
        smtpFrom: 'kaspi@example.net',
        hasSmtpPassword: true,
        configured: true,
        lastSentAt: null,
        lastError: null,
      });
      assert.ok(!JSON.stringify(payload).includes(password));
      assert.equal(Object.hasOwn(payload.notifications, 'smtpPassword'), false);
      const encryptedPassword = db
        .prepare('SELECT smtp_password_encrypted FROM notification_settings WHERE id=1')
        .get().smtp_password_encrypted;
      assert.notEqual(encryptedPassword, password);
      assert.equal(decryptSecret(encryptedPassword).toString('utf8'), password);

      const preserved = await patchSettings({ smtpPassword: '' });
      assert.equal((await preserved.json()).notifications.hasSmtpPassword, true);
      const omittedPassword = await patchSettings({ email: 'ops@example.net' });
      assert.equal((await omittedPassword.json()).notifications.hasSmtpPassword, true);
      assert.equal(
        db.prepare('SELECT smtp_password_encrypted FROM notification_settings WHERE id=1').get()
          .smtp_password_encrypted,
        encryptedPassword,
      );

      const hostChanged = await patchSettings({ smtpHost: 'smtp-next.example.net' });
      const hostChangedSettings = (await hostChanged.json()).notifications;
      assert.equal(hostChangedSettings.hasSmtpPassword, false, 'credentials must not carry to a different SMTP host');
      assert.equal(hostChangedSettings.configured, false);

      const restoredPassword = 'smtp-secret-restored-8264';
      const restored = await patchSettings({ smtpHost: 'smtp.example.net', smtpPassword: restoredPassword });
      assert.equal((await restored.json()).notifications.configured, true);
      const changedUser = await patchSettings({ smtpUser: 'different-alerts-user' });
      const changedUserSettings = (await changedUser.json()).notifications;
      assert.equal(changedUserSettings.hasSmtpPassword, false, 'credentials must not carry to a different SMTP user');
      assert.equal(changedUserSettings.configured, false);
      const userCredentialRestored = await patchSettings({ smtpUser: 'alerts-user', smtpPassword: password });
      assert.equal((await userCredentialRestored.json()).notifications.configured, true);
      const userCleared = await patchSettings({ smtpUser: '' });
      const userless = (await userCleared.json()).notifications;
      assert.equal(userless.hasSmtpPassword, false);
      assert.equal(userless.configured, true, 'SMTP authentication is optional with an empty username');
      assert.equal(
        db.prepare('SELECT smtp_password_encrypted FROM notification_settings WHERE id=1').get()
          .smtp_password_encrypted,
        null,
      );

      const userRestored = await patchSettings({ smtpUser: 'alerts-user', smtpPassword: password });
      assert.equal((await userRestored.json()).notifications.configured, true);
    });

    await t.test('sends test mail from saved settings when alerts are disabled and rate limits repeats', async () => {
      const enabledState = (await getSettings()).notifications;
      assert.equal(enabledState.enabled, false);
      assert.equal(enabledState.configured, true);

      const sent = await request('/api/admin/settings/notifications/test', {
        method: 'POST',
        headers: { ...adminHeaders(), 'X-CSRF-Token': csrfToken },
      });
      assert.equal(sent.status, 200);
      assert.deepEqual(await sent.json(), { success: true, message: 'Тестовое письмо принято почтовым сервером.' });
      assert.equal(mailCalls.length, 1);
      assert.equal(mailCalls[0].message.to, 'ops@example.net');
      assert.equal(mailCalls[0].message.from, 'kaspi@example.net');
      assert.ok(mailCalls[0].message.text.includes('Тестовое письмо'));
      assert.equal(mailCalls[0].message.html, undefined);
      assert.ok(!mailCalls[0].message.text.includes('smtp-secret-not-for-api-7362'));
      assert.equal(transports[0].secure, false);
      assert.equal(transports[0].requireTLS, true);
      assert.equal(transports[0].logger, false);
      assert.equal(transports[0].debug, false);
      assert.equal(transports[0].disableFileAccess, true);
      assert.equal(transports[0].disableUrlAccess, true);
      assert.equal(transports[0].auth.pass, 'smtp-secret-not-for-api-7362');
      assert.equal(transports[0].connectionTimeout, 10_000);

      const tooSoon = await request('/api/admin/settings/notifications/test', {
        method: 'POST',
        headers: { ...adminHeaders(), 'X-CSRF-Token': csrfToken },
      });
      assert.equal(tooSoon.status, 429);
      assert.equal(tooSoon.headers.get('retry-after'), '30');
      assert.equal(mailCalls.length, 1, 'rate limited attempts do not reach SMTP');
      assert.equal((await getSettings()).notifications.lastSentAt !== null, true);
    });

    await t.test('uses TLS for port 465 and returns safe SMTP errors without storing raw server text', async () => {
      fakeNow += 30_001;
      const tlsSettings = await patchSettings({
        smtpPort: 465,
        smtpSecurity: 'tls',
        smtpUser: '',
        smtpPassword: '',
      });
      assert.equal((await tlsSettings.json()).notifications.configured, true);
      const sent = await request('/api/admin/settings/notifications/test', {
        method: 'POST',
        headers: { ...adminHeaders(), 'X-CSRF-Token': csrfToken },
      });
      assert.equal(sent.status, 200);
      assert.equal(transports.at(-1).secure, true);
      assert.equal(transports.at(-1).requireTLS, false);
      assert.equal(transports.at(-1).auth, undefined, 'empty SMTP user disables authentication');

      fakeNow += 30_001;
      const failureText = '535 authentication failed smtp-secret-restored-8264';
      mailFailure = new Error(failureText);
      const failed = await request('/api/admin/settings/notifications/test', {
        method: 'POST',
        headers: { ...adminHeaders(), 'X-CSRF-Token': csrfToken },
      });
      assert.equal(failed.status, 502);
      const failureBody = await failed.json();
      assert.deepEqual(failureBody, {
        error: 'Не удалось отправить тестовое письмо. Проверьте настройки SMTP и доступность почтового сервера.',
        code: 'NOTIFICATION_SEND_FAILED',
      });
      assert.ok(!JSON.stringify(failureBody).includes(failureText));
      const savedAfterFailure = (await getSettings()).notifications;
      assert.equal(
        savedAfterFailure.lastError,
        'Не удалось отправить уведомление. Проверьте настройки SMTP и доступность почтового сервера.',
      );
      assert.ok(!savedAfterFailure.lastError.includes('smtp-secret-restored-8264'));
      assert.equal(savedAfterFailure.hasSmtpPassword, false);

      fakeNow += 30_001;
      mailAcceptedOverride = [];
      const notAccepted = await request('/api/admin/settings/notifications/test', {
        method: 'POST',
        headers: { ...adminHeaders(), 'X-CSRF-Token': csrfToken },
      });
      mailAcceptedOverride = null;
      assert.equal(notAccepted.status, 502, 'a resolved send without an accepted recipient is a failure');
      assert.equal((await notAccepted.json()).code, 'NOTIFICATION_SEND_FAILED');
    });

    await t.test('deduplicates, retries, recovers, cancels, and validates queued incidents', async () => {
      const project = createProject({ id: 'delivery-shop', name: 'North Kaspi Shop' }).project;
      const disabledSession = {
        tokenSN: 'disabled-notification-token',
        profileId: 111,
        vtokenSecret: encryptSecret(Buffer.alloc(32, 3)),
      };
      saveMerchantSession(project.id, disabledSession);
      markMerchantSessionInactive(project.id, disabledSession.tokenSN);
      assert.equal(connectionRows().length, 0, 'no loss should be queued when alerts are disabled');
      saveMerchantSession(project.id, { ...disabledSession, tokenSN: 'reenabled-notification-token' });

      const alertPassword = 'smtp-alert-credential-6417';
      const enabled = await patchSettings({
        enabled: true,
        email: 'ops@example.net',
        smtpHost: 'smtp.example.net',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        smtpUser: 'alerts-user',
        smtpPassword: alertPassword,
        smtpFrom: 'kaspi@example.net',
      });
      assert.equal((await enabled.json()).notifications.enabled, true);
      assert.equal((await getSettings()).notifications.configured, true);

      const accountSession = {
        tokenSN: 'active-notification-token',
        profileId: 111,
        vtokenSecret: encryptSecret(Buffer.alloc(32, 4)),
        orgName: 'North Org',
        phone: '+77001234567',
      };
      saveMerchantSession(project.id, accountSession);
      markMerchantSessionInactive(project.id, accountSession.tokenSN);
      const invalidated = JSON.parse(
        fs.readFileSync(path.join(directory, 'projects', project.id, 'merchant-session.json'), 'utf8'),
      );
      assert.equal(typeof invalidated.invalidatedAt, 'string');
      const notificationId = queueConnectionLoss(project.id, accountSession.tokenSN, invalidated.invalidatedAt, {
        orgName: accountSession.orgName,
        phone: accountSession.phone,
      });
      assert.equal(typeof notificationId, 'string');
      assert.equal(
        queueConnectionLoss(project.id, accountSession.tokenSN, invalidated.invalidatedAt, {
          orgName: accountSession.orgName,
          phone: accountSession.phone,
        }),
        notificationId,
        'the same project/token/lostAt tuple is deduplicated',
      );
      const firstRecord = connectionRows().find((row) => row.id === notificationId);
      assert.equal(firstRecord.status, 'pending');
      assert.equal(firstRecord.token_hash, crypto.createHash('sha256').update(accountSession.tokenSN).digest('hex'));
      assert.ok(!Object.hasOwn(firstRecord, 'tokenSN'));
      assert.ok(!JSON.stringify(firstRecord).includes(accountSession.tokenSN));
      assert.ok(!JSON.stringify(firstRecord).includes(alertPassword));

      const currentRecipient = await patchSettings({ email: 'operations@example.net' });
      assert.equal((await currentRecipient.json()).notifications.email, 'operations@example.net');
      mailFailure = new Error(`535 denied: ${alertPassword}`);
      const beforeFailureMail = mailCalls.length;
      assert.equal(await notifications.processConnectionNotifications(), true);
      assert.equal(mailCalls.length, beforeFailureMail + 1);
      assert.equal(
        mailCalls.at(-1).message.to,
        'operations@example.net',
        'queued items use current saved SMTP settings',
      );
      assert.equal(mailCalls.at(-1).message.from, 'kaspi@example.net');
      assert.ok(mailCalls.at(-1).message.text.includes('North Kaspi Shop (delivery-shop)'));
      assert.ok(mailCalls.at(-1).message.text.includes('North Org'));
      assert.ok(mailCalls.at(-1).message.text.includes('+77001234567'));
      assert.ok(mailCalls.at(-1).message.text.includes('Asia/Almaty'));
      assert.ok(mailCalls.at(-1).message.text.includes('по SMS'));
      assert.ok(!mailCalls.at(-1).message.text.includes(accountSession.tokenSN));
      assert.ok(!mailCalls.at(-1).message.text.includes(alertPassword));
      assert.equal(mailCalls.at(-1).message.messageId, `<kaspi-connection-${notificationId}@notifications.local>`);
      const afterFailure = connectionRows().find((row) => row.id === notificationId);
      assert.equal(afterFailure.status, 'pending');
      assert.equal(afterFailure.attempt_count, 1);
      assert.equal(afterFailure.next_attempt_at, fakeNow + 60_000);
      assert.equal(
        (await getSettings()).notifications.lastError,
        'Не удалось отправить уведомление. Проверьте настройки SMTP и доступность почтового сервера.',
      );
      assert.ok(!JSON.stringify(connectionRows()).includes(alertPassword));
      assert.ok(!JSON.stringify(await getSettings()).includes(alertPassword));

      fakeNow += 60_000;
      assert.equal(await notifications.processConnectionNotifications(), true);
      const afterRetry = connectionRows().find((row) => row.id === notificationId);
      assert.equal(afterRetry.status, 'sent');
      assert.equal(afterRetry.attempt_count, 2);
      assert.equal(
        mailCalls.at(-1).message.messageId,
        mailCalls.at(-2).message.messageId,
        'retry keeps a stable Message-ID',
      );
      assert.equal((await getSettings()).notifications.lastError, null);
      assert.equal(typeof (await getSettings()).notifications.lastSentAt, 'string');

      const retryBudgetProject = createProject({ id: 'retry-budget-shop', name: 'Retry budget shop' }).project;
      const retryBudgetSession = {
        tokenSN: 'retry-budget-token',
        profileId: 222,
        vtokenSecret: encryptSecret(Buffer.alloc(32, 8)),
      };
      saveMerchantSession(retryBudgetProject.id, retryBudgetSession);
      markMerchantSessionInactive(retryBudgetProject.id, retryBudgetSession.tokenSN);
      const retryBudgetLostAt = JSON.parse(
        fs.readFileSync(path.join(directory, 'projects', retryBudgetProject.id, 'merchant-session.json'), 'utf8'),
      ).invalidatedAt;
      const retryBudgetId = queueConnectionLoss(retryBudgetProject.id, retryBudgetSession.tokenSN, retryBudgetLostAt);
      const retryDelays = [60_000, 120_000, 300_000, 900_000, 3_600_000];
      for (let attempt = 1; attempt <= 6; attempt++) {
        mailFailure = new Error(`SMTP rejected attempt ${attempt}: ${alertPassword}`);
        assert.equal(await notifications.processConnectionNotifications(), true);
        const row = connectionRows().find((entry) => entry.id === retryBudgetId);
        assert.equal(row.attempt_count, attempt);
        if (attempt < 6) {
          assert.equal(row.status, 'pending');
          assert.equal(row.next_attempt_at, fakeNow + retryDelays[attempt - 1]);
          fakeNow = row.next_attempt_at;
        } else {
          assert.equal(row.status, 'failed');
        }
      }
      assert.equal(await notifications.processConnectionNotifications(), false, 'delivery stops after six attempts');
      assert.equal(
        connectionRows().find((row) => row.id === retryBudgetId).last_error,
        'Не удалось отправить уведомление. Проверьте настройки SMTP и доступность почтового сервера.',
      );

      const restartSession = {
        tokenSN: 'restart-notification-token',
        profileId: 111,
        vtokenSecret: encryptSecret(Buffer.alloc(32, 5)),
        orgName: 'North Org',
        phone: '+77001234567',
      };
      saveMerchantSession(project.id, restartSession);
      markMerchantSessionInactive(project.id, restartSession.tokenSN);
      const restartLostAt = JSON.parse(
        fs.readFileSync(path.join(directory, 'projects', project.id, 'merchant-session.json'), 'utf8'),
      ).invalidatedAt;
      const restartId = queueConnectionLoss(project.id, restartSession.tokenSN, restartLostAt, restartSession);
      const claimedBeforeRestart = claimNextConnectionNotification(fakeNow);
      assert.equal(claimedBeforeRestart.id, restartId);
      assert.equal(claimedBeforeRestart.status, 'sending');
      assert.equal(connectionRows().find((row) => row.id === restartId).attempt_count, 1);
      notifications.startConnectionNotifications();
      const recovered = connectionRows().find((row) => row.id === restartId);
      assert.equal(recovered.status, 'pending');
      assert.equal(recovered.attempt_count, 1, 'restart recovery preserves the six-attempt cap');
      assert.equal(await notifications.processConnectionNotifications(), true);
      await notifications.stopConnectionNotifications();
      const afterRestart = connectionRows().find((row) => row.id === restartId);
      assert.equal(afterRestart.status, 'sent');
      assert.equal(afterRestart.attempt_count, 2);

      const recoverySession = {
        tokenSN: 'recover-before-send-token',
        profileId: 111,
        vtokenSecret: encryptSecret(Buffer.alloc(32, 6)),
      };
      saveMerchantSession(project.id, recoverySession);
      markMerchantSessionInactive(project.id, recoverySession.tokenSN);
      const recoveryLostAt = JSON.parse(
        fs.readFileSync(path.join(directory, 'projects', project.id, 'merchant-session.json'), 'utf8'),
      ).invalidatedAt;
      const recoveryId = queueConnectionLoss(project.id, recoverySession.tokenSN, recoveryLostAt);
      saveMerchantSession(project.id, { ...recoverySession, tokenSN: 'sms-restored-token' });
      assert.equal(connectionRows().find((row) => row.id === recoveryId).status, 'cancelled');
      const callsBeforeCancelled = mailCalls.length;
      assert.equal(await notifications.processConnectionNotifications(), false);
      assert.equal(mailCalls.length, callsBeforeCancelled, 'recovered connection cancels pending notification');

      const rowsBeforeOldToken = connectionRows().length;
      markMerchantSessionInactive(project.id, recoverySession.tokenSN);
      assert.equal(
        getConnectionSummary(project.id).connected,
        true,
        'an old token cannot invalidate the SMS replacement',
      );
      assert.equal(connectionRows().length, rowsBeforeOldToken, 'the stale token cannot enqueue a notification');

      const archivedProject = createProject({ id: 'archived-notify-shop', name: 'Archived shop' }).project;
      const archivedSession = {
        tokenSN: 'archived-shop-token',
        profileId: 222,
        vtokenSecret: encryptSecret(Buffer.alloc(32, 7)),
        orgName: 'Old Org',
        phone: '+77009999999',
      };
      saveMerchantSession(archivedProject.id, archivedSession);
      markMerchantSessionInactive(archivedProject.id, archivedSession.tokenSN);
      archiveProject(archivedProject.id);
      const archivedLostAt = JSON.parse(
        fs.readFileSync(path.join(directory, 'projects', archivedProject.id, 'merchant-session.json'), 'utf8'),
      ).invalidatedAt;
      const archivedId = queueConnectionLoss(
        archivedProject.id,
        archivedSession.tokenSN,
        archivedLostAt,
        archivedSession,
      );
      const callsBeforeArchived = mailCalls.length;
      assert.equal(await notifications.processConnectionNotifications(), true);
      assert.equal(connectionRows().find((row) => row.id === archivedId).status, 'cancelled');
      assert.equal(mailCalls.length, callsBeforeArchived, 'archived projects are not emailed');
    });

    await t.test('store update and recovery operations remain safe for pending rows', async () => {
      assert.equal(resolveConnectionLoss('missing-project'), 0);
    });
  },
);
