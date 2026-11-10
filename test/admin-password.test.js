import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const projectRoot = path.dirname(fileURLToPath(new URL('../server.js', import.meta.url)));
const serverUrl = new URL('../server.js', import.meta.url).href;
const adminStoreUrl = new URL('../src/adminStore.js', import.meta.url).href;

const createSandbox = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-admin-password-'));
  const projectsFile = path.join(directory, 'projects.json');
  fs.writeFileSync(projectsFile, '[]');
  return { directory, projectsFile };
};

const makeEnvironment = ({ directory, projectsFile, adminApiKey }) => {
  const env = { ...process.env };
  for (const key of ['DATA_DIR', 'PORT', 'TOKEN_SECRET_KEY', 'ADMIN_API_KEY', 'PROJECTS_FILE']) {
    delete env[key];
  }
  Object.assign(env, {
    DATA_DIR: directory,
    PORT: '0',
    PROJECTS_FILE: projectsFile,
    DOTENV_CONFIG_PATH: path.join(directory, 'empty.env'),
  });
  if (adminApiKey) env.ADMIN_API_KEY = adminApiKey;
  return env;
};

const startServerProcess = async (env, { resetAdminPassword = false } = {}) => {
  const setup = resetAdminPassword
    ? `
      const adminStore = await import(${JSON.stringify(adminStoreUrl)});
      const temporaryPassword = await adminStore.resetAdminPassword();
      process.stdout.write('ADMIN_TEST_TEMP_PASSWORD=' + temporaryPassword + '\\n');
    `
    : '';
  const source = `
    try {
      const { server } = await import(${JSON.stringify(serverUrl)});
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      ${setup}
      process.stdout.write('ADMIN_TEST_PORT=' + server.address().port + '\\n');
    } catch (error) {
      console.error(error.stack || error);
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const startup = await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const inspectOutput = () => {
      const portMatch = /ADMIN_TEST_PORT=(\d+)/.exec(output);
      if (!portMatch) return;
      const passwordMatch = /ADMIN_TEST_TEMP_PASSWORD=([^\r\n]+)/.exec(output);
      finish({ port: Number(portMatch[1]), temporaryPassword: passwordMatch?.[1] });
    };
    const timeout = setTimeout(() => finish({ timedOut: true }), 20000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      inspectOutput();
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', (error) => finish({ error }));
    child.once('exit', (code, signal) => {
      finish({ exitCode: code, signal });
    });
  });

  return {
    child,
    ...startup,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
    ...(startup.port ? { baseUrl: `http://127.0.0.1:${startup.port}` } : {}),
  };
};

const stopServerProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
};

const getSessionCookie = (response) => {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || ''];
  const cookie = cookies.find((value) => value.startsWith('kaspi_admin_session='));
  assert.ok(cookie, 'a successful login or password change must set the admin session cookie');
  return cookie.split(';', 1)[0];
};

const assertSessionCookieAttributes = (response) => {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || ''];
  const cookie = cookies.find((value) => value.startsWith('kaspi_admin_session='));
  assert.ok(cookie, 'the session cookie must be present');
  assert.match(cookie, /(?:^|;\s*)Path=\/api(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)SameSite=Strict(?:;|$)/i);
  const maxAge = /(?:^|;\s*)Max-Age=(\d+)/i.exec(cookie);
  const expires = /(?:^|;\s*)Expires=([^;]+)/i.exec(cookie);
  assert.ok(maxAge || expires, 'the session cookie must expire after 12 hours');
  if (maxAge) assert.ok(Number(maxAge[1]) >= 12 * 60 * 60 - 1 && Number(maxAge[1]) <= 12 * 60 * 60);
  if (expires) {
    const expiration = Date.parse(expires[1]);
    const remainingMs = expiration - Date.now();
    assert.ok(remainingMs > 11.5 * 60 * 60 * 1000 && remainingMs <= 12.5 * 60 * 60 * 1000);
  }
};

const request = (baseUrl, route, { method = 'GET', body, cookie, csrfToken, bearer, headers = {} } = {}) =>
  fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const readJson = async (response) => {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

const login = async (baseUrl, password) => {
  const response = await request(baseUrl, '/api/admin/login', {
    method: 'POST',
    body: { username: 'admin', password },
  });
  return { response, cookie: response.ok ? getSessionCookie(response) : undefined };
};

const getSession = async (baseUrl, cookie) => {
  const response = await request(baseUrl, '/api/admin/session', { cookie });
  return { response, body: response.ok ? await readJson(response) : null };
};

it('requires the initial password change and rotates the admin API key across restart', async (t) => {
  const sandbox = createSandbox();
  const initialApiKey = 'legacy-admin-api-key-for-password-test-0123456789';
  const environment = makeEnvironment({ ...sandbox, adminApiKey: initialApiKey });
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map((child) => stopServerProcess(child)));
    fs.rmSync(sandbox.directory, { recursive: true, force: true });
  });

  let processState = await startServerProcess(environment, { resetAdminPassword: true });
  children.add(processState.child);
  assert.ok(processState.port, `server startup failed: ${processState.errors}`);
  assert.equal(typeof processState.temporaryPassword, 'string');
  assert.ok(processState.temporaryPassword.length >= 12);
  const temporaryPassword = processState.temporaryPassword;
  let { baseUrl } = processState;
  const secretsPath = path.join(sandbox.directory, 'server-secrets.json');
  assert.ok(fs.existsSync(secretsPath), 'a fresh data directory must persist its generated master key');
  const savedSecretsFile = fs.readFileSync(secretsPath);
  assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);

  assert.equal((await request(baseUrl, '/api/admin/session')).status, 401);
  const initialLogin = await login(baseUrl, processState.temporaryPassword);
  assert.equal(initialLogin.response.status, 200);
  assertSessionCookieAttributes(initialLogin.response);
  const initialCookie = initialLogin.cookie;
  const initialSession = await getSession(baseUrl, initialCookie);
  assert.equal(initialSession.response.status, 200);
  assert.deepEqual(Object.keys(initialSession.body).sort(), [
    'authenticated',
    'csrfToken',
    'mustChangePassword',
    'username',
  ]);
  assert.equal(initialSession.body.authenticated, true);
  assert.equal(initialSession.body.username, 'admin');
  assert.equal(initialSession.body.mustChangePassword, true);
  assert.equal(typeof initialSession.body.csrfToken, 'string');
  assert.ok(initialSession.body.csrfToken.length >= 16);
  assert.equal(JSON.stringify(initialSession.body).includes(processState.temporaryPassword), false);
  assert.equal((await request(baseUrl, '/api/admin/settings', { cookie: initialCookie })).status, 403);

  const secondForcedLogin = await login(baseUrl, processState.temporaryPassword);
  assert.equal(secondForcedLogin.response.status, 200);
  const forcedProjects = await request(baseUrl, '/api/projects', { cookie: initialCookie });
  assert.equal(forcedProjects.status, 403);
  assert.equal((await readJson(forcedProjects)).code, 'ADMIN_PASSWORD_CHANGE_REQUIRED');
  const forcedProjectWrite = await request(baseUrl, '/api/projects', {
    method: 'POST',
    body: { id: 'blocked-shop', name: 'Blocked shop' },
    cookie: initialCookie,
    csrfToken: initialSession.body.csrfToken,
  });
  assert.equal(forcedProjectWrite.status, 403);
  assert.equal((await readJson(forcedProjectWrite)).code, 'ADMIN_PASSWORD_CHANGE_REQUIRED');

  const newPassword = 'New-Admin-Password-2026!';
  const passwordWithoutCsrf = await request(baseUrl, '/api/admin/password', {
    method: 'POST',
    body: { currentPassword: processState.temporaryPassword, newPassword },
    cookie: initialCookie,
  });
  assert.equal(passwordWithoutCsrf.status, 403);
  const crossOriginChange = await request(baseUrl, '/api/admin/password', {
    method: 'POST',
    body: { currentPassword: processState.temporaryPassword, newPassword },
    cookie: initialCookie,
    csrfToken: initialSession.body.csrfToken,
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(crossOriginChange.status, 403, 'an unrelated origin cannot use even a valid CSRF token');

  const passwordChange = await request(baseUrl, '/api/admin/password', {
    method: 'POST',
    body: { currentPassword: processState.temporaryPassword, newPassword },
    cookie: initialCookie,
    csrfToken: initialSession.body.csrfToken,
  });
  assert.equal(passwordChange.status, 200);
  assertSessionCookieAttributes(passwordChange);
  const changedCookie = getSessionCookie(passwordChange);
  assert.notEqual(changedCookie, initialCookie);
  assert.equal((await getSession(baseUrl, initialCookie)).response.status, 401);
  assert.equal((await getSession(baseUrl, secondForcedLogin.cookie)).response.status, 401);
  const changedSession = await getSession(baseUrl, changedCookie);
  assert.equal(changedSession.response.status, 200);
  assert.equal(changedSession.body.mustChangePassword, false);
  assert.equal(changedSession.body.username, 'admin');
  assert.ok(changedSession.body.csrfToken);
  assert.equal((await login(baseUrl, temporaryPassword)).response.status, 401);

  const missingWriteCsrf = await request(baseUrl, '/api/projects', {
    method: 'POST',
    body: { id: 'csrf-shop', name: 'CSRF shop' },
    cookie: changedCookie,
  });
  assert.equal(missingWriteCsrf.status, 403);

  const createdResponse = await request(baseUrl, '/api/projects', {
    method: 'POST',
    body: { id: 'password-shop', name: 'Password shop' },
    cookie: changedCookie,
    csrfToken: changedSession.body.csrfToken,
  });
  assert.equal(createdResponse.status, 201);
  const created = await readJson(createdResponse);
  const projectApiKey = created.apiKey;
  assert.equal(typeof projectApiKey, 'string');

  const settingsResponse = await request(baseUrl, '/api/admin/settings', { cookie: changedCookie });
  assert.equal(settingsResponse.status, 200);
  const settings = await readJson(settingsResponse);
  assert.deepEqual(settings, {
    username: 'admin',
    encryptionKeyConfigured: true,
    encryptionKeySource: 'file',
    apiKeyConfigured: true,
  });
  assert.equal((await readJson(await request(baseUrl, '/api/projects', { bearer: initialApiKey }))).projects.length, 1);
  assert.equal((await request(baseUrl, '/api/payments', { bearer: projectApiKey })).status, 200);

  const revealResponse = await request(baseUrl, '/api/admin/api-key/reveal', {
    method: 'POST',
    body: { password: newPassword },
    cookie: changedCookie,
    csrfToken: changedSession.body.csrfToken,
  });
  assert.equal(revealResponse.status, 200);
  assert.deepEqual(await readJson(revealResponse), { apiKey: initialApiKey });

  const rotateResponse = await request(baseUrl, '/api/admin/api-key/rotate', {
    method: 'POST',
    body: { password: newPassword },
    cookie: changedCookie,
    csrfToken: changedSession.body.csrfToken,
  });
  assert.equal(rotateResponse.status, 200);
  const rotated = await readJson(rotateResponse);
  const rotatedApiKey = rotated.apiKey;
  assert.deepEqual(Object.keys(rotated).sort(), ['apiKey']);
  assert.equal(typeof rotatedApiKey, 'string');
  assert.notEqual(rotatedApiKey, initialApiKey);
  assert.equal((await request(baseUrl, '/api/projects', { bearer: initialApiKey })).status, 401);
  const rotatedBearerResponse = await request(baseUrl, '/api/projects', { bearer: rotatedApiKey });
  assert.equal(rotatedBearerResponse.status, 200);
  const projectsJson = await readJson(rotatedBearerResponse);
  assert.equal(JSON.stringify(projectsJson).includes(rotatedApiKey), false);
  assert.equal(JSON.stringify(projectsJson).includes(projectApiKey), false);
  assert.equal(JSON.stringify(projectsJson).includes(initialApiKey), false);
  assert.equal(JSON.stringify(projectsJson).includes('apiKeyHash'), false);
  assert.equal(JSON.stringify(projectsJson).includes('key_encrypted'), false);
  assert.equal((await request(baseUrl, '/api/payments', { bearer: projectApiKey })).status, 200);

  const logoutWithoutCsrf = await request(baseUrl, '/api/admin/logout', {
    method: 'POST',
    cookie: changedCookie,
  });
  assert.equal(logoutWithoutCsrf.status, 403);

  const sessionForLogout = await getSession(baseUrl, changedCookie);
  assert.equal(sessionForLogout.response.status, 200);
  const logoutResponse = await request(baseUrl, '/api/admin/logout', {
    method: 'POST',
    cookie: changedCookie,
    csrfToken: sessionForLogout.body.csrfToken,
  });
  assert.equal(logoutResponse.status, 204);
  assert.equal((await getSession(baseUrl, changedCookie)).response.status, 401);

  await stopServerProcess(processState.child);
  processState = await startServerProcess(environment);
  children.add(processState.child);
  assert.ok(processState.port, `server restart failed: ${processState.errors}`);
  baseUrl = processState.baseUrl;
  assert.deepEqual(
    fs.readFileSync(secretsPath),
    savedSecretsFile,
    'the generated master key must persist across restart',
  );

  const restartedLogin = await login(baseUrl, newPassword);
  assert.equal(restartedLogin.response.status, 200);
  assertSessionCookieAttributes(restartedLogin.response);
  const restartedSession = await getSession(baseUrl, restartedLogin.cookie);
  assert.equal(restartedSession.body.mustChangePassword, false);
  const restartedSettings = await readJson(
    await request(baseUrl, '/api/admin/settings', { cookie: restartedLogin.cookie }),
  );
  assert.deepEqual(restartedSettings, settings);

  const restartedReveal = await request(baseUrl, '/api/admin/api-key/reveal', {
    method: 'POST',
    body: { password: newPassword },
    cookie: restartedLogin.cookie,
    csrfToken: restartedSession.body.csrfToken,
  });
  assert.equal(restartedReveal.status, 200);
  assert.equal((await readJson(restartedReveal)).apiKey, rotatedApiKey);
  assert.equal((await request(baseUrl, '/api/projects', { bearer: initialApiKey })).status, 401);
  assert.equal((await request(baseUrl, '/api/projects', { bearer: rotatedApiKey })).status, 200);
  assert.equal((await request(baseUrl, '/api/payments', { bearer: projectApiKey })).status, 200);

  await stopServerProcess(processState.child);
  fs.unlinkSync(secretsPath);
  const missingSecret = await startServerProcess(environment);
  children.add(missingSecret.child);
  assert.equal(missingSecret.port, undefined, 'existing database data must not cause a new master key to be generated');
  assert.equal(missingSecret.exitCode, 1, missingSecret.errors || missingSecret.output);
  assert.equal(fs.existsSync(secretsPath), false);
});

it('limits repeated failed admin logins by client IP', async (t) => {
  const sandbox = createSandbox();
  const environment = makeEnvironment({
    ...sandbox,
    adminApiKey: 'admin-api-key-for-password-limit-test-0123456789',
  });
  let processState;
  t.after(async () => {
    await stopServerProcess(processState?.child);
    fs.rmSync(sandbox.directory, { recursive: true, force: true });
  });

  processState = await startServerProcess(environment, { resetAdminPassword: true });
  assert.ok(processState.port, `server startup failed: ${processState.errors}`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(processState.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'incorrect-admin-password' },
    });
    assert.equal(response.status, 401, `failed login ${attempt + 1} should be rejected as credentials`);
  }
  const limited = await request(processState.baseUrl, '/api/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'incorrect-admin-password' },
  });
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 15 * 60);
  await stopServerProcess(processState.child);
  processState = await startServerProcess(environment, { resetAdminPassword: true });
  assert.ok(processState.port, processState.errors);
  assert.equal(
    (await login(processState.baseUrl, processState.temporaryPassword)).response.status,
    200,
    'a trusted password reset must restore access without retaining the old login lockout',
  );
});

it('uses Secure cookies in production and rejects expired browser sessions', async (t) => {
  const sandbox = createSandbox();
  const environment = { ...makeEnvironment(sandbox), NODE_ENV: 'production' };
  let processState;
  t.after(async () => {
    await stopServerProcess(processState?.child);
    fs.rmSync(sandbox.directory, { recursive: true, force: true });
  });
  processState = await startServerProcess(environment, { resetAdminPassword: true });
  assert.ok(processState.port, processState.errors);
  const signedIn = await login(processState.baseUrl, processState.temporaryPassword);
  assert.equal(signedIn.response.status, 200);
  assert.match(signedIn.response.headers.get('set-cookie'), /; Secure(?:;|$)/);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path.join(sandbox.directory, 'projects.sqlite'));
  try {
    database.prepare('UPDATE admin_sessions SET expires_at=0').run();
  } finally {
    database.close();
  }
  const expired = await request(processState.baseUrl, '/api/admin/session', { cookie: signedIn.cookie });
  assert.equal(expired.status, 401);
  assert.equal((await readJson(expired)).code, 'AUTH_SESSION_EXPIRED');
});
