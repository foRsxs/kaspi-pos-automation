import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { it, mock } from 'node:test';

const verifyXSignInput = ({ url, options }) => {
  const headers = options.headers;
  const lines = headers['X-SH']
    .split(',')
    .map((name) => (name === 'url' ? `url:${url.toLowerCase()}` : `${name.toLowerCase()}:${headers[name] || ''}`));
  if (options.body) lines.push(options.body);
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest();
};

const readProjectFiles = (directory, projectId) => {
  const projectDirectory = path.join(directory, 'projects', projectId);
  return Object.fromEntries(
    ['device.json', 'keypair.json', 'ecdh-keypair.json', 'merchant-session.json'].map((name) => [
      name,
      fs.readFileSync(path.join(projectDirectory, name)),
    ]),
  );
};

it(
  'isolates auth process IDs, ECDH and sessions per Kaspi project through reauthentication',
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-auth-'));
    const projectsFile = path.join(directory, 'projects.json');
    const environmentKeys = [
      'DATA_DIR',
      'TOKEN_SECRET_KEY',
      'PORT',
      'ADMIN_API_KEY',
      'ALPHA_API_KEY',
      'BETA_API_KEY',
      'PROJECTS_FILE',
    ];
    const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      DATA_DIR: directory,
      TOKEN_SECRET_KEY: 'f'.repeat(64),
      PORT: '0',
      ADMIN_API_KEY: 'admin-auth-test-key-01234567890123456789',
      ALPHA_API_KEY: 'alpha-project-test-key-01234567890123456789',
      BETA_API_KEY: 'beta-project-test-key-01234567890123456789',
      PROJECTS_FILE: projectsFile,
    });
    fs.writeFileSync(
      projectsFile,
      JSON.stringify([
        { id: 'alpha', apiKeyEnv: 'ALPHA_API_KEY', webhooks: [] },
        { id: 'beta', apiKeyEnv: 'BETA_API_KEY', webhooks: [] },
      ]),
    );

    let server;
    let polling;
    let getIdentity;
    const identities = new Map();
    const projectByInstallId = new Map();
    const projectByDeviceId = new Map();
    const projectByPkTag = new Map();
    const projectByToken = new Map();
    const authRequests = [];
    const finishRequests = [];
    const serverSecrets = new Map();
    const finishWaiters = [];
    const nextSessionNumber = new Map();
    let holdFirstFinishPair = true;

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

    const response = (body, cookies = []) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { raw: () => ({ 'set-cookie': cookies }) },
      json: async () => body,
    });

    const projectFromCookie = (cookie = '') => {
      const deviceId = /(?:^|;\s*)deviceId=([^;]+)/.exec(cookie)?.[1];
      return projectByDeviceId.get(deviceId);
    };

    const upstreamFetch = async (requestUrl, options = {}) => {
      const url = new URL(String(requestUrl));
      const body = options.body ? JSON.parse(options.body) : {};

      if (url.hostname === 'entrance-pay.kaspi.kz' && url.pathname.endsWith('/entrance/step')) {
        if (body.Data?.auth === '2') {
          const projectId = projectByInstallId.get(body.Data.installId);
          assert.ok(projectId, 'init must use the selected project install ID');
          assert.equal(body.Data.deviceId, identities.get(projectId).device.deviceId);
          authRequests.push({ kind: 'init', projectId, body, cookie: options.headers.Cookie });
          return response({ meta: { pId: 'shared-process-id' }, view: { code: 'EnterPhoneNumber' } }, [
            `user_token=init-${projectId}; Path=/; HttpOnly`,
          ]);
        }

        const projectId = projectFromCookie(options.headers.Cookie);
        assert.ok(projectId, 'auth steps must use the selected project device cookie');
        if (body.meta?.sn === 'EnterPhoneNumber') {
          authRequests.push({ kind: 'send-phone', projectId, body, cookie: options.headers.Cookie });
          return response({ data: { desc: `SMS sent to ${projectId}` }, view: { code: 'EnterOtp' } }, [
            `user_token=otp-${projectId}-${body.data.phoneNumber}; Path=/; HttpOnly`,
          ]);
        }

        if (body.meta?.sn === 'ViewEnterOtp') {
          authRequests.push({ kind: 'verify-otp', projectId, body, cookie: options.headers.Cookie });
          return response({ data: { type: 'kpDeviceRegistration' }, view: { code: 'KPMobileCall' } });
        }

        throw new Error(`Unexpected entrance step: ${JSON.stringify(body)}`);
      }

      if (url.hostname === 'entrance-pay.kaspi.kz' && url.pathname.endsWith('/kpentrance/finish')) {
        const projectId = projectByPkTag.get(options.headers['X-PkTag']);
        assert.ok(projectId, 'finish must use the selected project signing identity');
        const identity = identities.get(projectId);
        const finishBody = body;
        const signatureInput = verifyXSignInput({ url: url.href, options });
        assert.equal(options.headers['X-PkTag'], identity.device.pkTag);
        assert.equal(finishBody.guard.pinHash, identity.device.pinHash);
        assert.equal(
          crypto.verify(
            'SHA256',
            signatureInput,
            identity.keyPair.publicKey,
            Buffer.from(options.headers['X-Sign'], 'base64'),
          ),
          true,
          `${projectId} finish request must use its ECDSA identity`,
        );
        const signedData = JSON.parse(Buffer.from(finishBody.signed.data, 'base64').toString('utf8'));
        assert.equal(signedData.installId, identity.device.installId);
        assert.equal(
          crypto.verify(
            'SHA256',
            Buffer.from(finishBody.signed.data, 'utf8'),
            identity.keyPair.publicKey,
            Buffer.from(finishBody.signed.sign, 'base64'),
          ),
          true,
          `${projectId} signed payload must use its ECDSA identity`,
        );

        const serverKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const serverX509 = serverKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        const clientPublicKey = crypto.createPublicKey({
          key: Buffer.from(finishBody.guard.x509, 'base64'),
          format: 'der',
          type: 'spki',
        });
        const sharedSecret = crypto.diffieHellman({ privateKey: serverKeyPair.privateKey, publicKey: clientPublicKey });
        const sessionNumber = (nextSessionNumber.get(projectId) || 0) + 1;
        nextSessionNumber.set(projectId, sessionNumber);
        const tokenSN = `${projectId}-token-${sessionNumber}`;
        serverSecrets.set(tokenSN, { projectId, sharedSecret });
        projectByToken.set(tokenSN, projectId);
        const result = response({ success: true, data: { tokenSN, x509: serverX509 } });
        finishRequests.push({ projectId, finishBody, tokenSN });

        if (!holdFirstFinishPair) return result;
        return new Promise((resolve) => {
          finishWaiters.push(() => resolve(result));
          if (finishWaiters.length === 2) {
            holdFirstFinishPair = false;
            for (const release of finishWaiters.splice(0)) release();
          }
        });
      }

      if (url.hostname === 'mtoken.kaspi.kz' && url.pathname.endsWith('/org-context-otp')) {
        const tokenSN = options.headers['X-Kb-TokenSn'];
        const projectId = projectByToken.get(tokenSN);
        assert.ok(projectId, 'org context request must use the token returned for its project');
        const identity = identities.get(projectId);
        assert.equal(options.headers['X-Install-ID'], identity.device.installId);
        assert.equal(options.headers['X-PkTag'], identity.device.pkTag);
        return response({
          Data: {
            Current: {
              ProfileId: projectId === 'alpha' ? 101 : 202,
              OrganizationId: projectId === 'alpha' ? 1001 : 2002,
              OrganizationName: `${projectId} merchant`,
              OrganizationIdn: `${projectId}-idn`,
            },
            UserId: `${projectId}-user`,
            PhoneNumber: projectId === 'alpha' ? '7000000001' : '7000000002',
            Organizations: [{ id: projectId, name: `${projectId} merchant` }],
          },
        });
      }

      throw new Error(`Unexpected upstream URL: ${url.href}`);
    };

    mock.module('node-fetch', { exports: { default: upstreamFetch } });

    ({ getIdentity } = await import('../src/identity.js'));
    for (const projectId of ['alpha', 'beta']) {
      const identity = getIdentity(projectId);
      identities.set(projectId, identity);
      projectByInstallId.set(identity.device.installId, projectId);
      projectByDeviceId.set(identity.device.deviceId, projectId);
      projectByPkTag.set(identity.device.pkTag, projectId);
    }
    polling = await import('../src/polling.js');
    ({ server } = await import('../server.js'));
    if (!server.listening) await once(server, 'listening');
    await polling.stopPolling();

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const adminKey = process.env.ADMIN_API_KEY;
    const request = (projectId, route, body) =>
      fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'X-Project-ID': projectId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const init = async (projectId) => {
      const result = await request(projectId, '/api/auth/init', {});
      assert.equal(result.status, 200);
      return result.json();
    };
    const sendPhone = (projectId, processId, phoneNumber) =>
      request(projectId, '/api/auth/send-phone', { processId, phoneNumber });
    const verifyOtp = (projectId, processId) =>
      request(projectId, '/api/auth/verify-otp', { processId, otp: '123456' });

    const alphaInit = await init('alpha');
    assert.equal(alphaInit.processId, 'shared-process-id');
    const sendsBeforeWrongProject = authRequests.filter((entry) => entry.kind === 'send-phone').length;
    const wrongProjectSend = await sendPhone('beta', alphaInit.processId, '7000000002');
    assert.equal(wrongProjectSend.status, 400, 'a process ID must not cross project boundaries');
    assert.equal(authRequests.filter((entry) => entry.kind === 'send-phone').length, sendsBeforeWrongProject);

    const betaInit = await init('beta');
    assert.equal(betaInit.processId, alphaInit.processId, 'mocked Kaspi returns the same process ID for both projects');

    const [alphaSent, betaSent] = await Promise.all([
      sendPhone('alpha', alphaInit.processId, '7000000001'),
      sendPhone('beta', betaInit.processId, '7000000002'),
    ]);
    assert.equal(alphaSent.status, 200);
    assert.equal(betaSent.status, 200);
    assert.equal((await alphaSent.json()).success, true);
    assert.equal((await betaSent.json()).success, true);

    const alphaPhoneRequest = authRequests.find((entry) => entry.kind === 'send-phone' && entry.projectId === 'alpha');
    const betaPhoneRequest = authRequests.find((entry) => entry.kind === 'send-phone' && entry.projectId === 'beta');
    assert.match(alphaPhoneRequest.cookie, new RegExp(`deviceId=${identities.get('alpha').device.deviceId}`));
    assert.match(betaPhoneRequest.cookie, new RegExp(`deviceId=${identities.get('beta').device.deviceId}`));
    assert.match(alphaPhoneRequest.cookie, /user_token=init-alpha(?:;|$)/);
    assert.match(betaPhoneRequest.cookie, /user_token=init-beta(?:;|$)/);
    assert.notEqual(identities.get('alpha').device.deviceId, identities.get('beta').device.deviceId);
    assert.notDeepEqual(
      identities.get('alpha').keyPair.publicKey.export({ type: 'spki', format: 'der' }),
      identities.get('beta').keyPair.publicKey.export({ type: 'spki', format: 'der' }),
    );

    const [alphaOtp, betaOtp] = await Promise.all([
      verifyOtp('alpha', alphaInit.processId),
      verifyOtp('beta', betaInit.processId),
    ]);
    assert.equal(alphaOtp.status, 200);
    assert.equal(betaOtp.status, 200);
    const [alphaResult, betaResult] = await Promise.all([alphaOtp.json(), betaOtp.json()]);
    assert.equal(alphaResult.success, true);
    assert.equal(betaResult.success, true);
    assert.equal(finishWaiters.length, 0, 'the first finish pair must be released together');
    assert.equal(finishRequests.length, 2);

    const { decryptSecret } = await import('../src/crypto.js');
    const sessionPath = (projectId) => path.join(identities.get(projectId).directory, 'merchant-session.json');
    const alphaSession = JSON.parse(fs.readFileSync(sessionPath('alpha'), 'utf8'));
    const betaSession = JSON.parse(fs.readFileSync(sessionPath('beta'), 'utf8'));
    assert.equal(alphaSession.projectId, 'alpha');
    assert.equal(betaSession.projectId, 'beta');
    assert.equal(alphaSession.tokenSN, 'alpha-token-1');
    assert.equal(betaSession.tokenSN, 'beta-token-1');
    assert.equal(alphaSession.profileId, 101);
    assert.equal(betaSession.profileId, 202);
    assert.equal(alphaSession.orgName, 'alpha merchant');
    assert.equal(betaSession.orgName, 'beta merchant');
    assert.deepEqual(decryptSecret(alphaSession.vtokenSecret), serverSecrets.get(alphaSession.tokenSN).sharedSecret);
    assert.deepEqual(decryptSecret(betaSession.vtokenSecret), serverSecrets.get(betaSession.tokenSN).sharedSecret);
    assert.equal(serverSecrets.get(alphaSession.tokenSN).projectId, 'alpha');
    assert.equal(serverSecrets.get(betaSession.tokenSN).projectId, 'beta');

    const betaFilesBeforeReauth = readProjectFiles(directory, 'beta');
    const alphaIdentityFilesBeforeReauth = readProjectFiles(directory, 'alpha');
    const alphaReauthInit = await init('alpha');
    assert.equal(alphaReauthInit.processId, 'shared-process-id');
    const alphaReauthSms = await sendPhone('alpha', alphaReauthInit.processId, '7000000003');
    assert.equal(alphaReauthSms.status, 200);
    const alphaReauthResult = await verifyOtp('alpha', alphaReauthInit.processId);
    assert.equal(alphaReauthResult.status, 200);
    assert.equal((await alphaReauthResult.json()).success, true);

    const alphaSessionAfterReauth = JSON.parse(fs.readFileSync(sessionPath('alpha'), 'utf8'));
    const betaSessionAfterReauth = JSON.parse(fs.readFileSync(sessionPath('beta'), 'utf8'));
    assert.equal(alphaSessionAfterReauth.tokenSN, 'alpha-token-2');
    assert.equal(betaSessionAfterReauth.tokenSN, betaSession.tokenSN);
    assert.deepEqual(readProjectFiles(directory, 'beta'), betaFilesBeforeReauth);
    const alphaIdentityFilesAfterReauth = readProjectFiles(directory, 'alpha');
    for (const name of ['device.json', 'keypair.json']) {
      assert.deepEqual(alphaIdentityFilesAfterReauth[name], alphaIdentityFilesBeforeReauth[name]);
    }
    assert.deepEqual(
      decryptSecret(alphaSessionAfterReauth.vtokenSecret),
      serverSecrets.get(alphaSessionAfterReauth.tokenSN).sharedSecret,
    );
  },
);
