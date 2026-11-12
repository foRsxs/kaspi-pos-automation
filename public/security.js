// ─── Administrator authentication and shared API requests ───

const securityState = {
  authenticated: false,
  mustChangePassword: false,
  csrfToken: '',
  generation: 0,
};
let serverSettingsGeneration = 0;
let serverSettingsLoadingGeneration = null;
let notificationBusyGeneration = null;
let notificationSettingsSnapshot = null;
let notificationsLoadedGeneration = null;
let notificationsConfigured = false;
let hasSmtpPassword = false;
let smtpCredentialBaseline = { host: '', user: '' };
let notificationTestCooldownUntil = 0;
let notificationTestCooldownTimer = null;

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
    error.retryAfter = response.headers?.get?.('Retry-After') || '';
    const requestPath = new URL(path, window.location.href).pathname;
    const isSessionCheck = method === 'GET' && ['/api/admin/session', '/api/admin/settings'].includes(requestPath);
    if (response.status === 401 && (result.code === 'AUTH_SESSION_EXPIRED' || isSessionCheck)) {
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

const notificationValuesFromForm = () => ({
  enabled: securityElement('notificationsEnabled').checked,
  email: securityElement('notificationEmail').value.trim(),
  smtpHost: securityElement('smtpHost').value.trim(),
  smtpPort: securityElement('smtpPort').value.trim(),
  smtpSecurity: securityElement('smtpSecurity').value || 'starttls',
  smtpUser: securityElement('smtpUser').value,
  smtpFrom: securityElement('smtpFrom').value.trim(),
  smtpPassword: securityElement('smtpPassword').value,
});

const notificationValuesFromResponse = (notifications = {}) => ({
  enabled: Boolean(notifications.enabled),
  email: String(notifications.email || ''),
  smtpHost: String(notifications.smtpHost || ''),
  smtpPort: String(notifications.smtpPort ?? 587),
  smtpSecurity: notifications.smtpSecurity === 'tls' ? 'tls' : 'starttls',
  smtpUser: String(notifications.smtpUser || ''),
  smtpFrom: String(notifications.smtpFrom || ''),
  smtpPassword: '',
});

const isCurrentServerSettingsView = (generation) =>
  generation === serverSettingsGeneration && securityElement('serverSettingsDialog').open && isAdminLoggedIn();

const notificationFormIsDirty = () =>
  !notificationSettingsSnapshot ||
  JSON.stringify(notificationValuesFromForm()) !== JSON.stringify(notificationSettingsSnapshot);

const notificationSettingsLoaded = () =>
  notificationsLoadedGeneration === serverSettingsGeneration && notificationSettingsSnapshot !== null;

const notificationTestCooldownSeconds = () =>
  Math.max(0, Math.ceil((notificationTestCooldownUntil - Date.now()) / 1000));

const scheduleNotificationTestCooldown = () => {
  if (
    notificationTestCooldownTimer !== null ||
    notificationTestCooldownSeconds() === 0 ||
    !securityElement('serverSettingsDialog').open
  )
    return;
  notificationTestCooldownTimer = setInterval(() => {
    if (!securityElement('serverSettingsDialog').open) {
      clearInterval(notificationTestCooldownTimer);
      notificationTestCooldownTimer = null;
      return;
    }
    updateConnectionNotificationControls();
    if (notificationTestCooldownSeconds() === 0) {
      clearInterval(notificationTestCooldownTimer);
      notificationTestCooldownTimer = null;
    }
  }, 1000);
};

const startNotificationTestCooldown = (seconds = 30) => {
  const duration = Number(seconds);
  const cooldownSeconds = Number.isFinite(duration) && duration > 0 ? Math.ceil(duration) : 30;
  notificationTestCooldownUntil = Math.max(notificationTestCooldownUntil, Date.now() + cooldownSeconds * 1000);
  scheduleNotificationTestCooldown();
  if (securityElement('serverSettingsDialog').open) updateConnectionNotificationControls();
};

const updateNotificationSummary = (notifications = {}) => {
  notificationsConfigured = Boolean(notifications.configured);
  hasSmtpPassword = Boolean(notifications.hasSmtpPassword);
  setSettingsStatus('notificationsSetupStatus', notificationsConfigured);
  const lastSentAt = notifications.lastSentAt ? new Date(notifications.lastSentAt) : null;
  securityElement('notificationsLastSentAt').textContent =
    lastSentAt && !Number.isNaN(lastSentAt.getTime())
      ? `Последнее письмо: ${lastSentAt.toLocaleString('ru')}`
      : 'Последнее письмо: не отправлялось';
  securityElement('notificationsLastError').textContent = notifications.lastError
    ? `Последняя ошибка: ${String(notifications.lastError)}`
    : 'Ошибок отправки нет.';
};

const updateConnectionNotificationControls = () => {
  const loading = serverSettingsLoadingGeneration === serverSettingsGeneration;
  const busy = notificationBusyGeneration === serverSettingsGeneration;
  const loaded = notificationSettingsLoaded();
  const disabled = loading || busy || !loaded;
  for (const id of [
    'notificationsEnabled',
    'notificationEmail',
    'smtpHost',
    'smtpPort',
    'smtpSecurity',
    'smtpUser',
    'smtpPassword',
    'smtpFrom',
  ]) {
    securityElement(id).disabled = disabled;
  }
  const dirty = notificationFormIsDirty();
  securityElement('btnSaveConnectionNotifications').disabled = disabled || !dirty;
  const testButton = securityElement('btnTestConnectionNotification');
  const cooldown = notificationTestCooldownSeconds();
  testButton.disabled = disabled || dirty || !notificationsConfigured || cooldown > 0;
  testButton.title =
    cooldown > 0
      ? `Повторное тестовое письмо будет доступно через ${cooldown} с.`
      : dirty
        ? 'Сначала сохраните изменения. Тестовое письмо использует сохранённые настройки.'
        : 'Ответ SMTP о приёме письма не подтверждает доставку во входящие.';
  securityElement('notificationTestHint').textContent =
    cooldown > 0
      ? `Следующее тестовое письмо можно отправить через ${cooldown} сек.`
      : 'Тест использует только сохранённые настройки. Приём письма почтовым сервером не гарантирует доставку во входящие.';
  securityElement('notificationsEnabledStatus').textContent = securityElement('notificationsEnabled').checked
    ? 'Уведомления включены'
    : 'Уведомления выключены';
  const smtpIdentityChanged =
    hasSmtpPassword &&
    (securityElement('smtpHost').value.trim() !== smtpCredentialBaseline.host ||
      securityElement('smtpUser').value !== smtpCredentialBaseline.user);
  securityElement('smtpPasswordHint').textContent = hasSmtpPassword
    ? smtpIdentityChanged
      ? 'Смена SMTP-сервера или имени пользователя удалит сохранённый пароль. Введите новый пароль, если он нужен.'
      : 'Сохранённый пароль есть. Оставьте поле пустым, чтобы сохранить его при неизменных сервере и имени пользователя.'
    : securityElement('smtpUser').value
      ? 'Для SMTP-аутентификации этому пользователю задайте пароль. Пароль не показывается.'
      : 'Пароль не показывается. Заполните поле, чтобы задать пароль SMTP.';
};

const validateConnectionNotificationValues = (values) => {
  const isEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (values.email && !isEmail(values.email)) return 'Введите один корректный email получателя.';
  if (values.smtpFrom && !isEmail(values.smtpFrom)) return 'Введите корректный email отправителя.';
  if (
    values.smtpPort &&
    (!/^\d+$/.test(values.smtpPort) || Number(values.smtpPort) < 1 || Number(values.smtpPort) > 65535)
  )
    return 'Порт SMTP должен быть числом от 1 до 65535.';
  if (values.enabled) {
    if (!values.email) return 'Укажите email получателя.';
    if (!values.smtpHost) return 'Укажите SMTP-сервер.';
    if (!values.smtpPort) return 'Укажите порт SMTP.';
    if (!values.smtpFrom) return 'Укажите email отправителя.';
    const smtpIdentityChanged =
      values.smtpHost !== smtpCredentialBaseline.host || values.smtpUser !== smtpCredentialBaseline.user;
    if (values.smtpUser && !values.smtpPassword && (!hasSmtpPassword || smtpIdentityChanged))
      return 'Для SMTP-аутентификации укажите пароль. После смены сервера или логина введите его заново.';
  }
  return '';
};

const applyConnectionNotificationSettings = (notifications = {}) => {
  const values = notificationValuesFromResponse(notifications);
  securityElement('notificationsEnabled').checked = values.enabled;
  securityElement('notificationEmail').value = values.email;
  securityElement('smtpHost').value = values.smtpHost;
  securityElement('smtpPort').value = values.smtpPort;
  securityElement('smtpSecurity').value = values.smtpSecurity;
  securityElement('smtpUser').value = values.smtpUser;
  securityElement('smtpPassword').value = '';
  securityElement('smtpFrom').value = values.smtpFrom;
  notificationSettingsSnapshot = values;
  updateNotificationSummary(notifications);
  smtpCredentialBaseline = { host: values.smtpHost.trim(), user: values.smtpUser };
  notificationsLoadedGeneration = serverSettingsGeneration;
  updateConnectionNotificationControls();
};

const loadServerSettings = async (generation) => {
  securityElement('serverSettingsUsername').textContent = 'admin';
  securityElement('encryptionKeyStatus').textContent = 'Проверяем…';
  securityElement('encryptionKeyStatus').className = 'settings-status';
  securityElement('serverApiKeyStatus').textContent = 'Проверяем состояние ключа…';
  showSecurityMessage('serverSettingsNotice', '');
  showSecurityMessage('connectionNotificationsMsg', '');
  try {
    const settings = await adminRequest('/api/admin/settings');
    if (!isCurrentServerSettingsView(generation)) return;
    const source = settings.encryptionKeySource === 'env' ? 'переменная окружения' : 'файл';
    setSettingsStatus('encryptionKeyStatus', Boolean(settings.encryptionKeyConfigured), source);
    securityElement('encryptionKeyHelp').textContent = settings.encryptionKeyConfigured
      ? `Сервер автоматически хранит TOKEN_SECRET_KEY в конфигурации (${source}). Значение скрыто. Замена требует перешифрования сохранённых данных.`
      : 'TOKEN_SECRET_KEY не настроен. Добавьте его в конфигурацию сервера. Значение нельзя посмотреть или изменить через панель.';
    setSettingsStatus('serverApiKeyStatus', Boolean(settings.apiKeyConfigured));
    applyConnectionNotificationSettings(settings.notifications || {});
  } catch (error) {
    if (isCurrentServerSettingsView(generation)) {
      showSecurityMessage('serverSettingsNotice', error.message, 'err');
      showSecurityMessage('connectionNotificationsMsg', error.message, 'err');
      securityElement('encryptionKeyStatus').textContent = 'Не удалось проверить';
      securityElement('serverApiKeyStatus').textContent = 'Не удалось проверить состояние ключа';
    }
  } finally {
    if (serverSettingsLoadingGeneration === generation) {
      serverSettingsLoadingGeneration = null;
      updateConnectionNotificationControls();
    }
  }
};

const saveConnectionNotifications = async (event) => {
  event?.preventDefault?.();
  if (!isAdminLoggedIn()) return;
  const generation = serverSettingsGeneration;
  if (!isCurrentServerSettingsView(generation)) return;
  if (!notificationSettingsLoaded()) {
    showSecurityMessage(
      'connectionNotificationsMsg',
      'Не удалось загрузить сохранённые настройки. Закройте окно и откройте его снова.',
      'err',
    );
    return;
  }
  const values = notificationValuesFromForm();
  const validationMessage = validateConnectionNotificationValues(values);
  if (validationMessage) {
    showSecurityMessage('connectionNotificationsMsg', validationMessage, 'err');
    return;
  }
  const dirty = notificationFormIsDirty();
  if (!dirty) return;

  notificationBusyGeneration = generation;
  updateConnectionNotificationControls();
  showSecurityMessage('connectionNotificationsMsg', 'Сохраняем настройки…');
  const payload = {
    enabled: values.enabled,
    email: values.email,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort ? Number(values.smtpPort) : 587,
    smtpSecurity: values.smtpSecurity,
    smtpUser: values.smtpUser,
    smtpFrom: values.smtpFrom,
    ...(values.smtpPassword ? { smtpPassword: values.smtpPassword } : {}),
  };
  try {
    const result = await adminRequest('/api/admin/settings/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!isCurrentServerSettingsView(generation)) return;
    applyConnectionNotificationSettings(result.notifications || {});
    showSecurityMessage('connectionNotificationsMsg', 'Настройки уведомлений сохранены.', 'ok');
  } catch (error) {
    if (isCurrentServerSettingsView(generation))
      showSecurityMessage('connectionNotificationsMsg', error.message, 'err');
  } finally {
    if (notificationBusyGeneration === generation) {
      clearPasswordFields('smtpPassword');
      notificationBusyGeneration = null;
      updateConnectionNotificationControls();
    }
  }
};

const sendTestConnectionNotification = async () => {
  if (!isAdminLoggedIn()) return;
  const generation = serverSettingsGeneration;
  if (!isCurrentServerSettingsView(generation)) return;
  if (!notificationSettingsLoaded()) {
    showSecurityMessage(
      'connectionNotificationsMsg',
      'Не удалось загрузить сохранённые настройки. Закройте окно и откройте его снова.',
      'err',
    );
    return;
  }
  if (notificationTestCooldownSeconds() > 0) {
    updateConnectionNotificationControls();
    showSecurityMessage(
      'connectionNotificationsMsg',
      `Повторное тестовое письмо будет доступно через ${notificationTestCooldownSeconds()} сек.`,
      'info',
    );
    return;
  }
  if (notificationFormIsDirty()) {
    showSecurityMessage(
      'connectionNotificationsMsg',
      'Сначала сохраните изменения. Тест использует только сохранённые настройки.',
      'err',
    );
    updateConnectionNotificationControls();
    return;
  }
  if (!notificationsConfigured) {
    showSecurityMessage(
      'connectionNotificationsMsg',
      'Сначала заполните и сохраните параметры почтового сервера.',
      'err',
    );
    return;
  }

  notificationBusyGeneration = generation;
  updateConnectionNotificationControls();
  showSecurityMessage('connectionNotificationsMsg', 'Отправляем тестовое письмо…');
  try {
    const result = await adminRequest('/api/admin/settings/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    startNotificationTestCooldown(30);
    if (!isCurrentServerSettingsView(generation)) return;
    showSecurityMessage(
      'connectionNotificationsMsg',
      result.message || 'Тестовое письмо принято почтовым сервером.',
      result.success ? 'ok' : 'err',
    );
    try {
      const settings = await adminRequest('/api/admin/settings');
      if (isCurrentServerSettingsView(generation)) updateNotificationSummary(settings.notifications || {});
    } catch {}
  } catch (error) {
    if (error.status === 429) startNotificationTestCooldown(error.retryAfter || 30);
    if (isCurrentServerSettingsView(generation))
      showSecurityMessage('connectionNotificationsMsg', error.message, 'err');
  } finally {
    if (notificationBusyGeneration === generation) {
      notificationBusyGeneration = null;
      updateConnectionNotificationControls();
    }
  }
};

const clearServerApiKey = () => {
  securityElement('serverApiKeyValue').textContent = '';
  securityElement('serverApiKeyValueRow').classList.add('hidden');
  securityElement('btnCopyServerApiKey').textContent = 'Копировать';
};

const resetServerSettingsView = () => {
  serverSettingsGeneration++;
  serverSettingsLoadingGeneration = null;
  notificationBusyGeneration = null;
  notificationSettingsSnapshot = null;
  notificationsLoadedGeneration = null;
  notificationsConfigured = false;
  hasSmtpPassword = false;
  smtpCredentialBaseline = { host: '', user: '' };
  clearPasswordFields('smtpPassword');
  if (notificationTestCooldownTimer !== null) {
    clearInterval(notificationTestCooldownTimer);
    notificationTestCooldownTimer = null;
  }
  showSecurityMessage('connectionNotificationsMsg', '');
  updateConnectionNotificationControls();
};

const bindServerSettingsClose = () => {
  const dialog = securityElement('serverSettingsDialog');
  if (dialog.dataset.settingsCloseBound) return;
  dialog.addEventListener('close', () => {
    securityElement('passwordSettingsDetails').open = false;
    clearPasswordFields(
      'settingsCurrentPassword',
      'settingsNewPassword',
      'settingsConfirmPassword',
      'serverApiKeyRevealPassword',
    );
    clearServerApiKey();
    resetServerSettingsView();
  });
  dialog.dataset.settingsCloseBound = 'true';
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
  bindServerSettingsClose();
  serverSettingsGeneration++;
  const generation = serverSettingsGeneration;
  serverSettingsLoadingGeneration = generation;
  notificationBusyGeneration = null;
  notificationSettingsSnapshot = null;
  notificationsLoadedGeneration = null;
  notificationsConfigured = false;
  hasSmtpPassword = false;
  clearPasswordFields(
    'settingsCurrentPassword',
    'settingsNewPassword',
    'settingsConfirmPassword',
    'serverApiKeyRevealPassword',
    'smtpPassword',
  );
  clearServerApiKey();
  securityElement('serverSettingsDialog').showModal();
  scheduleNotificationTestCooldown();
  updateConnectionNotificationControls();
  await loadServerSettings(generation);
};

const closeServerSettings = () => {
  const rotateDialog = securityElement('rotateServerApiKeyDialog');
  if (rotateDialog.open) rotateDialog.close();
  const dialog = securityElement('serverSettingsDialog');
  if (dialog.open) dialog.close();
  else resetServerSettingsView();
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
  window.closeWebhooks?.();
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
    'smtpPassword',
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
window.saveConnectionNotifications = saveConnectionNotifications;
window.sendTestConnectionNotification = sendTestConnectionNotification;
window.updateConnectionNotificationControls = updateConnectionNotificationControls;
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
