// ─── Administration panel ───

const ADMIN_WEBHOOK_EVENTS = [
  ['payment.success', 'Оплата прошла'],
  ['payment.failed', 'Оплата отклонена'],
  ['payment.expired', 'Срок оплаты истёк'],
  ['payment.lost', 'Статус требует сверки'],
];

const adminState = {
  projects: [],
  editId: null,
  pendingAction: null,
  connectingProjectId: null,
  connectReturnTo: 'dashboard',
  bankNotice: null,
};
const adminFetch = (path, options = {}) => window.adminRequest(path, options);

const clearAdminUI = () => {
  adminState.projects = [];
  adminState.editId = null;
  adminState.pendingAction = null;
  adminState.connectingProjectId = null;
  adminState.connectReturnTo = 'dashboard';
  adminState.bankNotice = null;
  $('projectsGrid').replaceChildren();
  $('archivedProjects').replaceChildren();
  $('projectCount').textContent = '0';
  $('projectSummary').textContent = 'Создайте первый проект для начала работы.';
  $('projectSelect').replaceChildren(new Option('Выберите проект', ''));
  $('projectForm').reset();
  $('webhookRows').replaceChildren();
  $('adminNotice').classList.add('hidden');
};

const showAdminMessage = (message, type = 'info') => {
  const loginVisible = !$('adminLogin').classList.contains('hidden');
  const target = loginVisible ? $('adminLoginMsg') : $('adminNotice');
  if (!message) {
    target.classList.add('hidden');
    return;
  }
  target.className = `status-bar status-${type}`;
  target.textContent = message;
  target.classList.remove('hidden');
};

const setProjectNotice = (message, type = 'info') => {
  const target = $('adminNotice');
  if (!message) {
    target.classList.add('hidden');
    return;
  }
  target.className = `status-bar status-${type}`;
  target.textContent = message;
  target.classList.remove('hidden');
};

const showProjectDialogMessage = (message) => {
  const target = $('projectDialogMsg');
  target.textContent = message || '';
  target.classList.toggle('hidden', !message);
};

const niceDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('ru-KZ', { dateStyle: 'medium', timeStyle: 'short' });
};

const adminEmptyState = (title, description) => {
  const state = document.createElement('div');
  state.className = 'empty-state';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = description;
  state.append(heading, body);
  return state;
};

const buildProjectCard = (project, archived = false) => {
  const card = document.createElement('article');
  card.className = 'project-card';

  const header = document.createElement('div');
  header.className = 'project-card-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'project-title-wrap';
  const avatar = document.createElement('div');
  avatar.className = 'project-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = (project.name || project.id || 'П').slice(0, 1).toLocaleUpperCase('ru');
  const titleGroup = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'project-name';
  title.textContent = project.name || project.id;
  const id = document.createElement('div');
  id.className = 'project-id';
  id.textContent = project.id;
  titleGroup.append(title, id);
  titleWrap.append(avatar, titleGroup);

  const status = document.createElement('span');
  status.className = `project-status status-${project.status || 'disabled'}`;
  status.textContent =
    { active: 'Активен', disabled: 'Отключён', archived: 'В архиве' }[project.status] || 'Неизвестен';
  header.append(titleWrap, status);
  card.append(header);

  const connection = document.createElement('div');
  connection.className = 'connection-row';
  const dot = document.createElement('span');
  dot.className = `connection-dot${project.connection?.connected ? ' connected' : ''}`;
  dot.setAttribute('aria-hidden', 'true');
  const connectionText = document.createElement('div');
  connectionText.className = 'connection-copy';
  const org = document.createElement('span');
  org.textContent = project.connection?.connected
    ? project.connection.orgName || 'Kaspi Pay подключён'
    : 'Kaspi Pay не подключён';
  const details = document.createElement('small');
  details.textContent = project.connection?.connected
    ? [
        project.connection.phone,
        project.connection.profileId ? `Профиль ${project.connection.profileId}` : '',
        project.connection.verifiedAt ? `Проверен ${niceDate(project.connection.verifiedAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Подключите счёт через вход по SMS';
  connectionText.append(org, details);
  connection.append(dot, connectionText);
  card.append(connection);

  const meta = document.createElement('div');
  meta.className = 'project-meta';
  const created = document.createElement('span');
  created.textContent = `Создан ${niceDate(project.createdAt)}`;
  const updated = document.createElement('span');
  updated.textContent = `Изменён ${niceDate(project.updatedAt)}`;
  const webhooks = document.createElement('span');
  webhooks.textContent = `${(project.webhooks || []).length} вебхук(а)`;
  meta.append(created, updated, webhooks);
  card.append(meta);

  if (archived) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Финансовая история сохранена. Архивный проект нельзя подключить.';
    card.append(note);
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    const history = actionButton('История и возвраты', 'btn btn-secondary connect-action', () =>
      connectArchivedHistory(project),
    );
    history.setAttribute('aria-label', `Открыть историю проекта ${project.name || project.id}`);
    actions.append(
      history,
      actionButton('Платежи', 'btn btn-secondary', () => window.openPayments(project.id)),
      actionButton('Доставка вебхуков', 'btn btn-secondary', () => window.openWebhooks(project.id)),
    );
    card.append(actions);
    return card;
  }

  const actions = document.createElement('div');
  actions.className = 'project-actions';
  actions.append(
    actionButton(
      project.connection?.connected ? 'Открыть счёт Kaspi Pay' : 'Подключить счёт Kaspi Pay',
      'btn btn-primary connect-action',
      () => (project.connection?.connected ? openProjectWorkspace(project.id) : connectProject(project.id)),
      `${project.connection?.connected ? 'Открыть' : 'Подключить'} счёт Kaspi Pay проекта ${project.name || project.id}`,
    ),
    actionButton('Настроить', 'btn btn-secondary', () => openProjectDialog(project)),
    actionButton('Платежи', 'btn btn-secondary', () => window.openPayments(project.id)),
    actionButton('Доставка вебхуков', 'btn btn-secondary', () => window.openWebhooks(project.id)),
    actionButton(project.status === 'disabled' ? 'Включить' : 'Отключить', 'btn btn-secondary', () =>
      setProjectStatus(project),
    ),
    actionButton('Показать API-ключ', 'btn btn-secondary', () => revealProjectKey(project)),
    actionButton('Перевыпустить ключ', 'btn btn-secondary', () => rotateProjectKey(project)),
    actionButton('В архив', 'btn btn-secondary archive-action', () => askArchiveProject(project)),
  );
  card.append(actions);
  return card;
};

const actionButton = (label, className, handler, ariaLabel = '') => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', handler);
  return button;
};

const renderProjects = () => {
  const current = adminState.projects.filter((project) => project.status !== 'archived');
  const archived = adminState.projects.filter((project) => project.status === 'archived');
  const grid = $('projectsGrid');
  grid.replaceChildren();
  $('projectCount').textContent = String(current.length);
  $('projectSummary').textContent = current.length
    ? 'Настройте доступ, подключение и вебхуки для каждого проекта.'
    : 'Создайте первый проект для начала работы.';
  if (!current.length)
    grid.append(adminEmptyState('Пока нет проектов', 'Создайте проект, чтобы настроить его Kaspi Pay и API-доступ.'));
  else for (const project of current) grid.append(buildProjectCard(project));

  const archiveGrid = $('archivedProjects');
  archiveGrid.replaceChildren();
  if (!archived.length) archiveGrid.append(adminEmptyState('Архив пуст', 'Архивированные проекты появятся здесь.'));
  else for (const project of archived) archiveGrid.append(buildProjectCard(project, true));
  archiveGrid.classList.toggle('hidden', !$('showArchived').checked);
};

const syncProjectSelect = () => {
  const select = $('projectSelect');
  const previous = selectedProject();
  const available = adminState.projects.filter((project) => project.status !== 'archived');
  select.replaceChildren(new Option('Выберите проект', ''));
  for (const project of available) select.add(new Option(`${project.name} · ${project.id}`, project.id));
  const preserved = available.find((project) => project.id === previous);
  select.value = preserved ? previous : available.length === 1 ? available[0].id : '';
  sessionStorage.setItem('kaspi_project_id', select.value);
};

const loadAdminProjects = async () => {
  const button = $('adminLogin').classList.contains('hidden') ? $('btnRefreshProjects') : $('btnAdminLogin');
  if (!window.isAdminLoggedIn()) return false;
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Загрузка…';
  showAdminMessage('Загружаем проекты…', 'info');
  try {
    const query = $('showArchived').checked ? '?includeArchived=true' : '';
    const result = await adminFetch(`/api/projects${query}`);
    adminState.projects = Array.isArray(result.projects) ? result.projects : [];
    const editedProject = adminState.projects.find((project) => project.id === adminState.editId);
    if (editedProject && $('projectDialog').open) updateProjectSettingsInfo(editedProject);
    syncProjectSelect();
    renderProjects();
    updateBankProjectStatus();
    $('adminLogin').classList.add('hidden');
    $('projectDashboard').classList.remove('hidden');
    showAdminMessage('');
    return true;
  } catch (error) {
    showAdminMessage(error.message, 'err');
    return false;
  } finally {
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const toggleArchivedProjects = async () => {
  if (!(await loadAdminProjects())) $('showArchived').checked = false;
};

const connectProject = async (id, { forceLogin = false, returnTo = 'dashboard' } = {}) => {
  const project = adminState.projects.find((item) => item.id === id);
  if (!project) return;
  if (project.status === 'archived') return connectArchivedHistory(project);
  if (selectedProject() && selectedProject() !== id) resetBankWorkspace();
  $('projectSelect').value = id;
  sessionStorage.setItem('kaspi_project_id', id);
  if (forceLogin) window.clearSession(id);
  adminState.connectingProjectId = id;
  adminState.connectReturnTo = returnTo;
  $('authProjectContext').textContent = project.connection?.connected
    ? `${project.name || project.id} · подключён: ${[project.connection.orgName, project.connection.phone]
        .filter(Boolean)
        .join(' · ')}`
    : `${project.name || project.id} · счёт ещё не подключён`;
  updateBankProjectStatus();
  if (returnTo !== 'workspace') {
    $('projectDashboard').classList.remove('hidden');
    $('bankWorkspace').classList.add('hidden');
  }
  $('mainScreen').classList.add('hidden');
  $('authScreen').classList.remove('hidden');
  $('connectSuccess').classList.add('hidden');
  $('connectDialog').querySelector?.('.connect-dialog-footer')?.classList.remove('hidden');
  $('btnSendPhone').disabled = false;
  $('btnSendPhone').textContent = 'Получить SMS код';
  $('btnVerifyOtp').disabled = false;
  $('btnVerifyOtp').textContent = 'Подтвердить';
  window.beginAuthFlow(id);
  if (!$('connectDialog').open) $('connectDialog').showModal();
  $('authScreen').classList.remove('hidden');
  resetAuth();
  if (!forceLogin && project.connection?.connected) await window.connectServer();
};

const openProjectWorkspace = async (id) => {
  const project = adminState.projects.find((item) => item.id === id);
  if (!project) return;
  if (project.status === 'archived') return connectArchivedHistory(project);
  resetBankWorkspace();
  $('projectSelect').value = id;
  sessionStorage.setItem('kaspi_project_id', id);
  updateBankProjectStatus();
  $('projectDashboard').classList.add('hidden');
  $('bankWorkspace').classList.remove('hidden');
  $('mainScreen').classList.add('hidden');
  await connectProject(id, { returnTo: 'workspace' });
};

const closeConnectDialog = () => {
  window.cancelAuthFlow();
  const dialog = $('connectDialog');
  if (dialog.open) dialog.close();
  $('authScreen').classList.remove('hidden');
  $('connectSuccess').classList.add('hidden');
  $('connectDialog').querySelector?.('.connect-dialog-footer')?.classList.remove('hidden');
  $('btnSendPhone').disabled = false;
  $('btnSendPhone').textContent = 'Получить SMS код';
  $('btnVerifyOtp').disabled = false;
  $('btnVerifyOtp').textContent = 'Подтвердить';
  resetAuth();
  $('phoneInput').value = '';
  adminState.connectingProjectId = null;
  if (adminState.connectReturnTo === 'workspace') {
    $('bankWorkspace').classList.add('hidden');
    $('projectDashboard').classList.remove('hidden');
  }
  adminState.connectReturnTo = 'dashboard';
};

const refreshProjectsAfterConnect = async (generation) => {
  try {
    const result = await adminFetch('/api/projects');
    if (!window.isCurrentAuthFlow(generation)) return false;
    adminState.projects = Array.isArray(result.projects) ? result.projects : [];
    syncProjectSelect();
    renderProjects();
    updateBankProjectStatus();
    const editedProject = adminState.projects.find((project) => project.id === adminState.editId);
    if (editedProject && $('projectDialog').open) updateProjectSettingsInfo(editedProject);
    return true;
  } catch {
    return false;
  }
};

const finishConnectFlow = async (projectId, data, generation) => {
  const refreshed = await refreshProjectsAfterConnect(generation);
  if (!window.isCurrentAuthFlow(generation)) return;
  const project = adminState.projects.find((item) => item.id === projectId);
  const details = [project?.connection?.orgName || data.orgName, data.phone || project?.connection?.phone]
    .filter(Boolean)
    .join(' · ');
  $('authProjectContext').textContent = `${project?.name || projectId} · подключён${details ? `: ${details}` : ''}`;
  $('connectSuccessMessage').textContent = `${
    details ? `${project?.name || projectId} · ${details}` : `${project?.name || projectId} подключён к Kaspi Pay.`
  }${refreshed ? '' : ' Обновите список проектов, чтобы проверить статус.'}`;
  if (adminState.connectReturnTo === 'workspace') {
    openConnectedAccount();
    return;
  }
  $('authScreen').classList.add('hidden');
  $('connectSuccess').classList.remove('hidden');
  $('connectDialog').querySelector?.('.connect-dialog-footer')?.classList.add('hidden');
};

const openConnectedAccount = () => {
  const projectId = adminState.connectingProjectId;
  if (!projectId) return;
  const project = adminState.projects.find((item) => item.id === projectId);
  if (!project) return;
  if ($('projectDialog').open) closeProjectDialog();
  closeConnectDialog();
  resetBankWorkspace();
  $('projectSelect').value = projectId;
  sessionStorage.setItem('kaspi_project_id', projectId);
  updateBankProjectStatus();
  $('projectDashboard').classList.add('hidden');
  $('bankWorkspace').classList.remove('hidden');
  window.showMainScreen(window.getSession());
};

const connectArchivedHistory = async (project) => {
  resetBankWorkspace();
  const select = $('projectSelect');
  if (![...select.options].some((option) => option.value === project.id)) {
    select.add(new Option(`${project.name} · ${project.id} · архив`, project.id));
  }
  select.value = project.id;
  sessionStorage.setItem('kaspi_project_id', project.id);
  updateBankProjectStatus();
  $('projectDashboard').classList.add('hidden');
  $('bankWorkspace').classList.remove('hidden');
  $('authScreen').classList.add('hidden');
  $('mainScreen').classList.remove('hidden');
  let session = {};
  try {
    session = await apiFetch('/api/session/check');
    if (session.active) saveSession(session);
  } catch {
    // История по-прежнему доступна через банковский API, если сессия сервера активна.
  }
  if (selectedProject() !== project.id) return;
  showMainScreen({ ...project.connection, ...session });
  updateBankProjectStatus();
  switchTab('history');
};

const updateBankProjectStatus = () => {
  const project = adminState.projects.find((item) => item.id === selectedProject());
  const archived = project?.status === 'archived';
  const disabled = project?.status === 'disabled';
  const status = $('selectedProjectStatus');
  if (adminState.bankNotice?.projectId !== selectedProject()) adminState.bankNotice = null;
  const projectMessage = archived
    ? 'Архивный проект: доступны история и возвраты. Вход по SMS и создание оплат отключены.'
    : disabled
      ? 'Проект отключён: доступны история и возвраты, создание новых оплат и QR отключено.'
      : '';
  status.textContent = [projectMessage, adminState.bankNotice?.message].filter(Boolean).join(' ');
  status.classList.toggle('hidden', !status.textContent);
  if (archived) {
    $('invoiceTab').classList.add('hidden');
    $('qrTab').classList.add('hidden');
  }
  $('btnCreate').disabled = archived || disabled;
  $('btnCreateQr').disabled = archived || disabled;
  for (const id of ['clientPhone', 'invoiceAmount', 'invoiceComment', 'qrAmount'])
    $(id).disabled = archived || disabled;
  $('tabInvoice').classList.toggle('hidden', archived);
  $('tabQr').classList.toggle('hidden', archived);
};

const showBankUnavailable = (projectId, message) => {
  if (selectedProject() !== projectId) return;
  adminState.bankNotice = { projectId, message };
  updateBankProjectStatus();
};

const clearBankNotice = (projectId) => {
  if (selectedProject() !== projectId || adminState.bankNotice?.projectId !== projectId) return;
  adminState.bankNotice = null;
  updateBankProjectStatus();
};

const handleKaspiSessionExpired = async (projectId, message) => {
  if (selectedProject() !== projectId) return false;
  window.stopInvoicePolling?.();
  window.stopQrPolling?.();
  window.clearSession(projectId);
  const project = adminState.projects.find((item) => item.id === projectId);
  if (!project) return false;

  project.connection = { ...(project.connection || {}), connected: false };
  adminState.bankNotice = null;
  renderProjects();
  if ($('projectDialog').open && adminState.editId === projectId) updateProjectSettingsInfo(project);

  const sessionMessage = message || window.kaspiSessionExpiredMessage;
  if (project.status === 'archived') {
    adminState.bankNotice = {
      projectId,
      message: 'Подключение к Kaspi Pay потеряно. Архивный проект нельзя переподключить по SMS.',
    };
    updateBankProjectStatus();
    return false;
  }

  if ($('connectDialog').open && adminState.connectingProjectId === projectId) {
    $('authProjectContext').textContent = `${project.name || project.id} · подключение к Kaspi Pay потеряно`;
    window.showAuthMsg(sessionMessage, 'info');
    return true;
  }

  const returnTo = $('bankWorkspace').classList.contains('hidden') ? 'dashboard' : 'workspace';
  await connectProject(projectId, { forceLogin: true, returnTo });
  window.showAuthMsg(sessionMessage, 'info');
  return $('connectDialog').open && adminState.connectingProjectId === projectId;
};

const setProjectAccountMessage = (message, type = 'info') => {
  const target = $('projectAccountMessage');
  if (!message) {
    target.classList.add('hidden');
    return;
  }
  target.className = `status-bar status-${type}`;
  target.textContent = message;
  target.classList.remove('hidden');
};

const setProjectKeyMessage = (project, message, type = 'err') => {
  const target =
    $('projectDialog').open && adminState.editId === project.id ? $('projectKeyMessage') : $('adminNotice');
  if (!message) {
    target.classList.add('hidden');
    return;
  }
  target.className = `status-bar status-${type}`;
  target.textContent = message;
  target.classList.remove('hidden');
};

const projectSettingsHaveChanges = (project) => {
  const status = project.status === 'disabled' ? 'disabled' : 'active';
  if ($('projectName').value.trim() !== (project.name || '') || $('projectStatus').value !== status) return true;

  const currentWebhooks = [...$('webhookRows').querySelectorAll('.webhook-row')].map((row) => ({
    id: row.dataset.webhookId || '',
    url: row.querySelector('.webhook-url').value.trim(),
    events: [...row.querySelectorAll('.webhook-event:checked')].map((checkbox) => checkbox.value).sort(),
    secretProvided: Boolean(row.querySelector('.webhook-secret').value.trim()),
  }));
  const savedWebhooks = (project.webhooks || []).map((hook) => ({
    id: hook.id || '',
    url: hook.url || '',
    events: [...(hook.events || [])].sort(),
    secretProvided: false,
  }));
  return JSON.stringify(currentWebhooks) !== JSON.stringify(savedWebhooks);
};

const openAccountFromSettings = async (forceLogin = false) => {
  const project = adminState.projects.find((item) => item.id === adminState.editId);
  if (!project) return;
  if (projectSettingsHaveChanges(project)) {
    setProjectAccountMessage('Сначала сохраните изменения проекта, затем откройте счёт Kaspi Pay.', 'info');
    return;
  }
  if (!forceLogin && project.connection?.connected) {
    closeProjectDialog();
    await openProjectWorkspace(project.id);
    return;
  }
  await connectProject(project.id, { forceLogin, returnTo: 'settings' });
};

const revealProjectKey = async (project = null) => {
  const current = project || adminState.projects.find((item) => item.id === adminState.editId);
  if (!current) return;
  setProjectKeyMessage(current, 'Загружаем API-ключ…', 'info');
  try {
    const result = await adminFetch(`/api/projects/${encodeURIComponent(current.id)}/api-key`, { cache: 'no-store' });
    if (!result.apiKey) throw new Error('Сервер не вернул API-ключ проекта');
    setProjectKeyMessage(current, '');
    showSecretDialog(`API-ключ проекта · ${current.name || current.id}`, [
      { label: `${current.name || current.id} · ${current.id}`, secret: result.apiKey, kind: 'apiKey' },
    ]);
  } catch (error) {
    const message =
      error.status === 409 || error.code === 'API_KEY_NOT_RECOVERABLE'
        ? current.canRevealApiKey
          ? 'Ключ недоступен для просмотра. Если ключ создан до поддержки просмотра, перевыпустите его и обновите интеграцию.'
          : 'Ключ создан до поддержки просмотра. Для просмотра нового ключа перевыпустите его и обновите интеграцию.'
        : error.message;
    setProjectKeyMessage(current, message, 'err');
  }
};

const openProjectDialog = (project = null) => {
  adminState.editId = project?.id || null;
  $('projectDialogTitle').textContent = project ? 'Настройки проекта' : 'Новый проект';
  $('projectName').value = project?.name || '';
  $('projectId').value = '';
  $('projectId').disabled = Boolean(project);
  $('projectIdField').classList.toggle('hidden', Boolean(project));
  $('projectStatusField').classList.toggle('hidden', !project);
  $('projectStatus').value = project?.status === 'disabled' ? 'disabled' : 'active';
  $('projectAccountSection').classList.toggle('hidden', !project);
  $('projectKeySection').classList.toggle('hidden', !project);
  if (project) updateProjectSettingsInfo(project);
  setProjectAccountMessage('');
  $('projectKeyMessage').classList.add('hidden');
  $('webhookEditor').classList.toggle('hidden', !project);
  $('webhookRows').replaceChildren();
  if (project) for (const hook of project.webhooks || []) addWebhookRow(hook);
  showProjectDialogMessage('');
  $('projectDialog').showModal();
  $('projectName').focus();
};

const updateProjectSettingsInfo = (project) => {
  const connected = Boolean(project.connection?.connected);
  $('projectConnectionStatus').textContent = connected
    ? `Подключён: ${[project.connection.orgName || 'Kaspi Pay', project.connection.phone].filter(Boolean).join(' · ')}`
    : 'Счёт Kaspi Pay ещё не подключён.';
  $('projectConnectionStatus').classList.toggle('connected', connected);
  $('btnOpenAccountSettings').textContent = connected ? 'Открыть счёт Kaspi Pay' : 'Подключить счёт Kaspi Pay';
  $('btnReconnectAccount').classList.toggle('hidden', !connected);
  $('projectKeyHint').textContent = project.canRevealApiKey
    ? 'Ключ можно посмотреть позже в настройках. После перевыпуска прежний ключ сразу перестанет работать.'
    : 'Ключ создан до поддержки просмотра. Чтобы увидеть его, перевыпустите ключ и обновите интеграцию.';
};

const closeProjectDialog = () => {
  $('projectDialog').close();
  $('projectForm').reset();
  $('webhookRows').replaceChildren();
  adminState.editId = null;
};

const addWebhookRow = (hook = {}) => {
  const row = document.createElement('section');
  row.className = 'webhook-row';
  if (hook.id) row.dataset.webhookId = hook.id;
  const header = document.createElement('div');
  header.className = 'webhook-row-header';
  const title = document.createElement('span');
  title.textContent = hook.id ? 'Настроенный вебхук' : 'Новый вебхук';
  const remove = actionButton('Удалить', 'btn-remove', () => row.remove());
  header.append(title, remove);

  const urlLabel = document.createElement('label');
  urlLabel.textContent = 'URL назначения';
  const url = document.createElement('input');
  url.type = 'url';
  url.className = 'webhook-url';
  url.required = true;
  url.placeholder = 'https://example.kz/webhooks/kaspi';
  url.value = hook.url || '';
  urlLabel.append(url);

  const secretLabel = document.createElement('label');
  secretLabel.textContent = 'Секрет проверки уведомлений';
  const secret = document.createElement('input');
  secret.type = 'password';
  secret.className = 'webhook-secret';
  secret.autocomplete = 'new-password';
  secret.placeholder = hook.id ? 'Пустое поле сохранит текущий секрет' : 'Оставьте пустым для создания секрета';
  secretLabel.append(secret);
  const secretStatus = document.createElement('div');
  secretStatus.className = 'field-hint';
  secretStatus.textContent =
    'Ваш сайт использует его, чтобы проверить, что сообщение об оплате отправил этот сервер. Это не пароль Kaspi и не API-ключ проекта. Для нового вебхука оставьте поле пустым — сервер создаст секрет.';

  const eventHint = document.createElement('div');
  eventHint.className = 'field-hint';
  eventHint.textContent = 'События для отправки';
  const events = document.createElement('div');
  events.className = 'event-options';
  const selected = new Set(hook.events || []);
  for (const [value, captionText] of ADMIN_WEBHOOK_EVENTS) {
    const label = document.createElement('label');
    label.className = 'event-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'webhook-event';
    checkbox.value = value;
    checkbox.checked = selected.has(value);
    const caption = document.createElement('span');
    caption.textContent = captionText;
    label.append(checkbox, caption);
    events.append(label);
  }
  row.append(header, urlLabel, secretLabel, secretStatus, eventHint, events);
  $('webhookRows').append(row);
};

const submitProjectForm = async (event) => {
  event.preventDefault();
  const creatingProject = !adminState.editId;
  const button = $('btnSaveProject');
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Сохранение…';
  showProjectDialogMessage('');
  try {
    const name = $('projectName').value.trim();
    if (!name) throw new Error('Укажите название проекта');
    let result;
    if (!adminState.editId) {
      const id = $('projectId').value.trim();
      result = await adminFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...(id ? { id } : {}) }),
      });
    } else {
      const webhooks = [...$('webhookRows').querySelectorAll('.webhook-row')].map((row) => {
        const events = [...row.querySelectorAll('.webhook-event:checked')].map((checkbox) => checkbox.value);
        if (!events.length) throw new Error('Выберите хотя бы одно событие для каждого вебхука');
        const hook = { url: row.querySelector('.webhook-url').value.trim(), events };
        if (row.dataset.webhookId) hook.id = row.dataset.webhookId;
        const secret = row.querySelector('.webhook-secret').value.trim();
        if (secret) hook.secret = secret;
        return hook;
      });
      result = await adminFetch(`/api/projects/${encodeURIComponent(adminState.editId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, status: $('projectStatus').value, webhooks }),
      });
    }
    closeProjectDialog();
    await loadAdminProjects();
    const secrets = [];
    if (result.apiKey) secrets.push({ label: 'API-ключ проекта', secret: result.apiKey, kind: 'apiKey' });
    for (const generated of result.webhookSecrets || []) {
      const hook = result.project?.webhooks?.find((item) => item.id === generated.id);
      secrets.push({
        label: `Секрет вебхука${hook?.url ? ` · ${hook.url}` : ''}`,
        secret: generated.secret,
        kind: 'webhook',
      });
    }
    if (creatingProject)
      setProjectNotice('Проект создан. Следующий шаг — подключите счёт Kaspi Pay кнопкой в карточке проекта.', 'info');
    if (secrets.length) showSecretDialog('Доступы созданы', secrets);
    else if (!creatingProject) setProjectNotice('Изменения сохранены.', 'ok');
  } catch (error) {
    showProjectDialogMessage(error.message);
  } finally {
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const showSecretDialog = (title, secrets) => {
  $('secretDialogTitle').textContent = title;
  const hasApiKey = secrets.some((secret) => secret.kind === 'apiKey');
  const hasWebhookSecret = secrets.some((secret) => secret.kind === 'webhook');
  $('secretDialogEyebrow').textContent =
    hasApiKey && hasWebhookSecret ? 'ДОСТУПЫ ПРОЕКТА' : hasApiKey ? 'API-КЛЮЧ ПРОЕКТА' : 'СЕКРЕТ ВЕБХУКА';
  $('secretWarning').textContent =
    hasApiKey && hasWebhookSecret
      ? 'API-ключ можно посмотреть позже в настройках проекта. При перевыпуске старый ключ сразу перестанет работать. Секрет вебхука показывается только один раз — сохраните его сейчас.'
      : hasApiKey
        ? 'API-ключ можно посмотреть позже в настройках проекта. При перевыпуске старый ключ сразу перестанет работать.'
        : 'Секрет вебхука показывается только один раз. Скопируйте и сохраните его: сервер не сможет показать его повторно.';
  const list = $('secretList');
  list.replaceChildren();
  for (const secret of secrets) {
    const item = document.createElement('div');
    item.className = 'secret-item';
    const label = document.createElement('span');
    label.className = 'secret-label';
    label.textContent = secret.label;
    const row = document.createElement('div');
    row.className = 'secret-value-row';
    const value = document.createElement('code');
    value.className = 'secret-value';
    value.textContent = secret.secret;
    const copy = actionButton('Копировать', 'btn btn-secondary', async () => {
      try {
        await navigator.clipboard.writeText(secret.secret);
        copy.textContent = 'Скопировано';
        setTimeout(() => {
          if (copy.isConnected) copy.textContent = 'Копировать';
        }, 1400);
      } catch {
        copy.textContent = 'Скопируйте вручную';
      }
    });
    row.append(value, copy);
    item.append(label, row);
    list.append(item);
  }
  $('secretDialog').showModal();
};

const closeSecretDialog = () => $('secretDialog').close();
const clearSecretDialog = () => {
  $('secretList').replaceChildren();
  $('secretWarning').textContent = '';
};

const setProjectStatus = async (project) => {
  const status = project.status === 'disabled' ? 'active' : 'disabled';
  setProjectNotice('Сохраняем статус проекта…', 'info');
  try {
    await adminFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await loadAdminProjects();
    setProjectNotice(
      status === 'active' ? 'Проект включён.' : 'Проект отключён. API-ключ проекта больше не принимается.',
      'ok',
    );
  } catch (error) {
    setProjectNotice(error.message, 'err');
  }
};

const rotateProjectKey = async (project) => {
  $('confirmTitle').textContent = 'Перевыпустить API-ключ?';
  $('confirmDescription').textContent =
    `Для проекта «${project.name}» (${project.id}) будет создан новый ключ. Старый сразу перестанет работать — обновите его в своей интеграции.`;
  $('btnConfirmAction').textContent = 'Перевыпустить ключ';
  adminState.pendingAction = async () => {
    const result = await adminFetch(`/api/projects/${encodeURIComponent(project.id)}/rotate-key`, { method: 'POST' });
    await loadAdminProjects();
    return {
      title: 'Новый API-ключ проекта',
      secrets: [{ label: `Проект ${project.name} · ${project.id}`, secret: result.apiKey, kind: 'apiKey' }],
    };
  };
  $('confirmDialog').showModal();
};

const rotateProjectKeyFromSettings = () => {
  const project = adminState.projects.find((item) => item.id === adminState.editId);
  if (project) rotateProjectKey(project);
};

const askArchiveProject = (project) => {
  $('confirmTitle').textContent = 'Архивировать проект?';
  $('confirmDescription').textContent =
    `«${project.name}» (${project.id}) будет скрыт из списка и перестанет принимать запросы по API-ключу. Финансовая история сохранится.`;
  $('btnConfirmAction').textContent = 'Архивировать';
  adminState.pendingAction = async () => {
    const result = await adminFetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    if (selectedProject() === project.id) {
      clearSession();
      sessionStorage.removeItem('kaspi_project_id');
      stopInvoicePolling();
      stopQrPolling();
      $('bankWorkspace').classList.add('hidden');
    }
    await loadAdminProjects();
    if ($('showArchived').checked) $('archivedProjects').classList.remove('hidden');
    setProjectNotice(`Проект «${result.project?.name || project.name}» перемещён в архив.`, 'ok');
  };
  $('confirmDialog').showModal();
};

const closeConfirmDialog = () => {
  $('confirmDialog').close();
  adminState.pendingAction = null;
};

const runConfirmAction = async () => {
  if (!adminState.pendingAction) return;
  const button = $('btnConfirmAction');
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Выполняем…';
  try {
    const result = await adminState.pendingAction();
    closeConfirmDialog();
    if (result?.secrets) showSecretDialog(result.title, result.secrets);
  } catch (error) {
    closeConfirmDialog();
    setProjectNotice(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = buttonLabel;
  }
};

const goToDashboard = async () => {
  stopInvoicePolling();
  stopQrPolling();
  $('bankWorkspace').classList.add('hidden');
  $('adminLogin').classList.add('hidden');
  $('projectDashboard').classList.remove('hidden');
  await loadAdminProjects();
};

$('projectForm').addEventListener('submit', submitProjectForm);
$('btnConfirmAction').addEventListener('click', runConfirmAction);
$('btnOpenAccountSettings').addEventListener('click', () => openAccountFromSettings(false));
$('btnReconnectAccount').addEventListener('click', () => openAccountFromSettings(true));
$('btnRevealProjectKey').addEventListener('click', () => revealProjectKey());
$('btnRotateProjectKeySettings').addEventListener('click', rotateProjectKeyFromSettings);
$('connectDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeConnectDialog();
});
Object.assign(window, {
  clearAdminUI,
  loadProjects: loadAdminProjects,
  toggleArchivedProjects,
  connectProject,
  openProjectWorkspace,
  closeConnectDialog,
  openConnectedAccount,
  finishConnectFlow,
  openProjectDialog,
  closeProjectDialog,
  addWebhookRow,
  revealProjectKey,
  closeSecretDialog,
  clearSecretDialog,
  closeConfirmDialog,
  goToDashboard,
  handleKaspiSessionExpired,
  showBankUnavailable,
  clearBankNotice,
});
