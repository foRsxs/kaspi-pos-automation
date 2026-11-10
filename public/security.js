// ─── Administrator authentication and shared API requests ───

const securityState = {
  authenticated: false,
  mustChangePassword: false,
  csrfToken: '',
  generation: 0,
};

window.securityState = securityState;

const securityElement = (id) => document.getElementById(id);

const updateSecurityState = (result = {}) => {
  securityState.generation++;
  securityState.authenticated = result.authenticated !== false;
  securityState.mustChangePassword = Boolean(result.mustChangePassword);
  if (typeof result.csrfToken === 'string') securityState.csrfToken = result.csrfToken;
};

const showSecurityMessage = (id, message, type = 'info') => {
  const target = securityElement(id);
  if (!target) return;
  if (!message) {
    target.classList.add('hidden');
    target.textContent = '';
    return;
  }
  target.className = `status-bar status-${type}`;
  target.textContent = message;
  target.classList.remove('hidden');
};

const adminRequest = async (path, options = {}) => {
  const generation = securityState.generation;
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.delete('Authorization');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && securityState.csrfToken) {
    headers.set('X-CSRF-Token', securityState.csrfToken);
  }

  const response = await fetch(path, {
    ...options,
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));

  if (generation !== securityState.generation)
    throw Object.assign(new Error('Сессия администратора изменилась. Повторите запрос.'), {
      status: 409,
      code: 'ADMIN_SESSION_CHANGED',
    });

  if (!response.ok) {
    const error = new Error(result.error || `Ошибка запроса: HTTP ${response.status}`);
    error.status = response.status;
    error.code = result.code;
    const requestPath = new URL(path, window.location.href).pathname;
    const isSessionCheck = method === 'GET' && ['/api/admin/session', '/api/admin/settings'].includes(requestPath);
    if (
      response.status === 401 &&
      (result.code === 'AUTH_SESSION_EXPIRED' || isSessionCheck || !requestPath.startsWith('/api/admin/'))
    ) {
      window.dispatchEvent(new CustomEvent('admin:unauthorized'));
    }
    throw error;
  }

  return result;
};

const isAdminLoggedIn = () => securityState.authenticated && !securityState.mustChangePassword;

const hideProtectedScreens = () => {
  for (const id of ['projectDashboard', 'bankWorkspace', 'mainScreen', 'authScreen']) {
    securityElement(id)?.classList.add('hidden');
  }
};

const showAdminLogin = (message = '') => {
  hideProtectedScreens();
  securityElement('forcedPasswordScreen')?.classList.add('hidden');
  securityElement('adminLogin')?.classList.remove('hidden');
  showSecurityMessage('adminLoginMsg', message, message ? 'err' : 'info');
};

const showForcedPasswordScreen = () => {
  hideProtectedScreens();
  securityElement('adminLogin')?.classList.add('hidden');
  securityElement('forcedPasswordScreen')?.classList.remove('hidden');
  showSecurityMessage('forcedPasswordMsg', '');
  securityElement('forcedCurrentPassword')?.focus();
};

const showAdminDashboard = async () => {
  securityElement('forcedPasswordScreen')?.classList.add('hidden');
  securityElement('adminLogin')?.classList.add('hidden');
  securityElement('bankWorkspace')?.classList.add('hidden');
  securityElement('mainScreen')?.classList.add('hidden');
  securityElement('authScreen')?.classList.add('hidden');
  securityElement('projectDashboard')?.classList.remove('hidden');
  showSecurityMessage('adminLoginMsg', '');
  if (typeof window.loadProjects === 'function') await window.loadProjects();
};

const clearPasswordFields = (...ids) => {
  for (const id of ids) {
    const field = securityElement(id);
    if (field) field.value = '';
  }
};

const submitAdminLogin = async (event) => {
  event.preventDefault();
  const button = securityElement('btnAdminLogin');
  const passwordField = securityElement('adminPassword');
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Входим…';
  showSecurityMessage('adminLoginMsg', '');

  try {
    const result = await adminRequest('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: passwordField.value }),
    });
    updateSecurityState({ ...result, authenticated: true });
    clearPasswordFields('adminPassword');
    if (securityState.mustChangePassword) showForcedPasswordScreen();
    else await showAdminDashboard();
  } catch (error) {
    showSecurityMessage('adminLoginMsg', error.message, 'err');
  } finally {
    clearPasswordFields('adminPassword');
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const validatePasswordForm = (currentPassword, newPassword, confirmPassword, messageId) => {
  if (!currentPassword) {
    showSecurityMessage(messageId, 'Введите текущий пароль.', 'err');
    return false;
  }
  if (newPassword.length < 12 || newPassword.length > 128) {
    showSecurityMessage(messageId, 'Новый пароль должен содержать от 12 до 128 символов.', 'err');
    return false;
  }
  if (newPassword !== confirmPassword) {
    showSecurityMessage(messageId, 'Новые пароли не совпадают.', 'err');
    return false;
  }
  return true;
};

const submitPasswordChange = async (event, { forced = false } = {}) => {
  event.preventDefault();
  const ids = forced
    ? ['forcedCurrentPassword', 'forcedNewPassword', 'forcedConfirmPassword']
    : ['settingsCurrentPassword', 'settingsNewPassword', 'settingsConfirmPassword'];
  const [currentId, newId, confirmId] = ids;
  const messageId = forced ? 'forcedPasswordMsg' : 'changeAdminPasswordMsg';
  const button = securityElement(forced ? 'btnForcedPassword' : 'btnChangeAdminPassword');
  const buttonLabel = button.textContent;
  const currentPassword = securityElement(currentId).value;
  const newPassword = securityElement(newId).value;
  const confirmPassword = securityElement(confirmId).value;

  if (!validatePasswordForm(currentPassword, newPassword, confirmPassword, messageId)) {
    clearPasswordFields(...ids);
    return;
  }

  button.disabled = true;
  button.textContent = 'Сохраняем…';
  showSecurityMessage(messageId, '');
  try {
    const result = await adminRequest('/api/admin/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    updateSecurityState({ ...result, authenticated: true, mustChangePassword: false });
    if (forced) {
      await showAdminDashboard();
    } else {
      showSecurityMessage(messageId, 'Пароль изменён.', 'ok');
    }
  } catch (error) {
    showSecurityMessage(messageId, error.message, 'err');
  } finally {
    clearPasswordFields(...ids);
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const setSettingsStatus = (id, configured, detail = '') => {
  const target = securityElement(id);
  if (!target) return;
  target.className = `settings-status ${configured ? 'is-configured' : 'is-missing'}`;
  target.textContent = configured ? `Настроен${detail ? ` · ${detail}` : ''}` : 'Не настроен';
};

const loadServerSettings = async () => {
  securityElement('serverSettingsUsername').textContent = 'admin';
  securityElement('encryptionKeyStatus').textContent = 'Проверяем…';
  securityElement('encryptionKeyStatus').className = 'settings-status';
  securityElement('serverApiKeyStatus').textContent = 'Проверяем состояние ключа…';
  showSecurityMessage('serverSettingsNotice', '');
  try {
    const settings = await adminRequest('/api/admin/settings');
    const source = settings.encryptionKeySource === 'env' ? 'переменная окружения' : 'файл';
    setSettingsStatus('encryptionKeyStatus', Boolean(settings.encryptionKeyConfigured), source);
    securityElement('encryptionKeyHelp').textContent = settings.encryptionKeyConfigured
      ? `Сервер автоматически хранит TOKEN_SECRET_KEY в конфигурации (${source}). Значение скрыто. Замена требует перешифрования сохранённых данных.`
      : 'TOKEN_SECRET_KEY не настроен. Добавьте его в конфигурацию сервера. Значение нельзя посмотреть или изменить через панель.';
    setSettingsStatus('serverApiKeyStatus', Boolean(settings.apiKeyConfigured));
  } catch (error) {
    showSecurityMessage('serverSettingsNotice', error.message, 'err');
    securityElement('encryptionKeyStatus').textContent = 'Не удалось проверить';
    securityElement('serverApiKeyStatus').textContent = 'Не удалось проверить состояние ключа';
  }
};

const clearServerApiKey = () => {
  securityElement('serverApiKeyValue').textContent = '';
  securityElement('serverApiKeyValueRow').classList.add('hidden');
  securityElement('btnCopyServerApiKey').textContent = 'Копировать';
};

const showServerApiKey = (apiKey, message = '') => {
  if (!apiKey) throw new Error('Сервер не вернул ключ администратора API');
  securityElement('serverApiKeyValue').textContent = apiKey;
  securityElement('serverApiKeyValueRow').classList.remove('hidden');
  if (message) showSecurityMessage('serverSettingsNotice', message, 'ok');
};

const revealServerApiKey = async () => {
  const passwordField = securityElement('serverApiKeyRevealPassword');
  const password = passwordField.value;
  if (!password) {
    showSecurityMessage('serverSettingsNotice', 'Введите текущий пароль администратора для просмотра ключа.', 'err');
    passwordField.focus();
    return;
  }
  const button = securityElement('btnRevealServerApiKey');
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Проверяем…';
  try {
    const result = await adminRequest('/api/admin/api-key/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    showServerApiKey(result.apiKey, 'Ключ показан. Скопируйте и храните его безопасно.');
  } catch (error) {
    showSecurityMessage('serverSettingsNotice', error.message, 'err');
  } finally {
    clearPasswordFields('serverApiKeyRevealPassword');
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const openServerSettings = async () => {
  if (!isAdminLoggedIn()) return;
  clearPasswordFields(
    'settingsCurrentPassword',
    'settingsNewPassword',
    'settingsConfirmPassword',
    'serverApiKeyRevealPassword',
  );
  clearServerApiKey();
  securityElement('serverSettingsDialog').showModal();
  await loadServerSettings();
};

const closeServerSettings = () => {
  const rotateDialog = securityElement('rotateServerApiKeyDialog');
  if (rotateDialog.open) rotateDialog.close();
  securityElement('serverSettingsDialog').close();
};

const openRotateServerApiKey = () => {
  if (!isAdminLoggedIn()) return;
  clearPasswordFields('rotateServerApiKeyPassword');
  securityElement('rotateServerApiKeyValue').value = '';
  securityElement('confirmServerApiKeyRotation').checked = false;
  showSecurityMessage('rotateServerApiKeyMsg', '');
  securityElement('rotateServerApiKeyDialog').showModal();
  securityElement('rotateServerApiKeyPassword').focus();
};

const closeRotateServerApiKey = () => {
  const dialog = securityElement('rotateServerApiKeyDialog');
  if (dialog.open) dialog.close();
  clearPasswordFields('rotateServerApiKeyPassword');
  securityElement('rotateServerApiKeyValue').value = '';
  securityElement('confirmServerApiKeyRotation').checked = false;
  showSecurityMessage('rotateServerApiKeyMsg', '');
};

const rotateServerApiKey = async (event) => {
  event.preventDefault();
  if (!securityElement('confirmServerApiKeyRotation').checked) return;
  const passwordField = securityElement('rotateServerApiKeyPassword');
  const password = passwordField.value;
  const apiKeyField = securityElement('rotateServerApiKeyValue');
  const apiKey = apiKeyField.value.trim();
  if (apiKey && (apiKey.length < 32 || apiKey.length > 256)) {
    showSecurityMessage('rotateServerApiKeyMsg', 'Свой ключ должен содержать от 32 до 256 символов.', 'err');
    apiKeyField.focus();
    return;
  }
  if (!password) {
    showSecurityMessage('rotateServerApiKeyMsg', 'Введите текущий пароль администратора.', 'err');
    passwordField.focus();
    return;
  }
  const button = securityElement('btnRotateServerApiKey');
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Перевыпускаем…';
  showSecurityMessage('rotateServerApiKeyMsg', '');
  try {
    const result = await adminRequest('/api/admin/api-key/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, ...(apiKey ? { apiKey } : {}) }),
    });
    closeRotateServerApiKey();
    showServerApiKey(result.apiKey, 'Ключ перевыпущен. Скопируйте его и обновите все интеграции.');
    setSettingsStatus('serverApiKeyStatus', true);
  } catch (error) {
    showSecurityMessage('rotateServerApiKeyMsg', error.message, 'err');
  } finally {
    clearPasswordFields('rotateServerApiKeyPassword');
    apiKeyField.value = '';
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const copyServerApiKey = async () => {
  const value = securityElement('serverApiKeyValue').textContent;
  if (!value) return;
  const button = securityElement('btnCopyServerApiKey');
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Скопировано';
  } catch {
    button.textContent = 'Скопируйте вручную';
  }
};

const clearAdminSessionUI = (message = '') => {
  updateSecurityState({ authenticated: false, mustChangePassword: false, csrfToken: '' });
  window.resetBankWorkspace?.();
  window.closePayments?.();
  window.clearAdminUI?.();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  window.clearSecretDialog?.();
  clearPasswordFields(
    'adminPassword',
    'forcedCurrentPassword',
    'forcedNewPassword',
    'forcedConfirmPassword',
    'settingsCurrentPassword',
    'settingsNewPassword',
    'settingsConfirmPassword',
    'serverApiKeyRevealPassword',
    'rotateServerApiKeyPassword',
    'rotateServerApiKeyValue',
  );
  clearServerApiKey();
  sessionStorage.removeItem('kaspi_admin_key');
  showAdminLogin(message);
  securityElement('adminPassword')?.focus();
};
const adminLogout = async () => {
  let logoutError = '';
  try {
    if (securityState.authenticated) await adminRequest('/api/admin/logout', { method: 'POST' });
  } catch (error) {
    if (error.status !== 401) logoutError = 'Не удалось подтвердить выход на сервере.';
  } finally {
    clearAdminSessionUI(logoutError);
  }
};

window.securityState = securityState;
window.adminRequest = adminRequest;
window.isAdminLoggedIn = isAdminLoggedIn;
window.openServerSettings = openServerSettings;
window.closeServerSettings = closeServerSettings;
window.openRotateServerApiKey = openRotateServerApiKey;
window.closeRotateServerApiKey = closeRotateServerApiKey;
window.adminLogout = adminLogout;

window.addEventListener('admin:unauthorized', () =>
  clearAdminSessionUI('Сессия администратора завершена. Войдите снова.'),
);

window.addEventListener('DOMContentLoaded', async () => {
  sessionStorage.removeItem('kaspi_admin_key');
  securityElement('adminLoginForm').addEventListener('submit', submitAdminLogin);
  securityElement('forcedPasswordForm').addEventListener('submit', (event) =>
    submitPasswordChange(event, { forced: true }),
  );
  securityElement('changeAdminPasswordForm').addEventListener('submit', (event) => submitPasswordChange(event));
  securityElement('rotateServerApiKeyForm').addEventListener('submit', rotateServerApiKey);
  securityElement('btnRevealServerApiKey').addEventListener('click', revealServerApiKey);
  securityElement('btnOpenRotateServerApiKey').addEventListener('click', openRotateServerApiKey);
  securityElement('btnCopyServerApiKey').addEventListener('click', copyServerApiKey);
  securityElement('serverSettingsDialog').addEventListener('close', () => {
    securityElement('passwordSettingsDetails').open = false;
    clearPasswordFields(
      'settingsCurrentPassword',
      'settingsNewPassword',
      'settingsConfirmPassword',
      'serverApiKeyRevealPassword',
    );
    clearServerApiKey();
  });
  securityElement('rotateServerApiKeyDialog').addEventListener('close', () => {
    clearPasswordFields('rotateServerApiKeyPassword');
    securityElement('rotateServerApiKeyValue').value = '';
    securityElement('confirmServerApiKeyRotation').checked = false;
  });

  try {
    const result = await adminRequest('/api/admin/session');
    updateSecurityState({ ...result, authenticated: true });
    if (securityState.mustChangePassword) showForcedPasswordScreen();
    else await showAdminDashboard();
  } catch (error) {
    updateSecurityState({ authenticated: false, mustChangePassword: false, csrfToken: '' });
    if (error.status && error.status !== 401) showAdminLogin(error.message);
    else showAdminLogin();
  }
});
