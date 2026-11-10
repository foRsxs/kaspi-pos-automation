// Read-only delivery ledger with an explicit action to enqueue a safe retry.
const webhookView = {
  entries: [],
  generation: 0,
  detailsGeneration: 0,
  retryGeneration: 0,
  timer: null,
  searchTimer: null,
  loading: false,
  retrying: false,
  retryingDeliveryId: null,
  page: 1,
  total: 0,
  summary: {},
  pendingRetry: null,
};
const WEBHOOKS_PAGE_SIZE = 50;
const WEBHOOK_STATUS_LABELS = {
  queued: 'В очереди',
  retrying: 'Повторная попытка',
  sending: 'Отправляется',
  delivered: 'Доставлен',
  failed: 'Ошибка доставки',
  cancelled: 'Отменён',
};
const WEBHOOK_OUTCOME_LABELS = {
  delivered: 'Принят сервером',
  failed: 'Ошибка',
  timeout: 'Тайм-аут',
  cancelled: 'Отменена',
  sending: 'Выполняется',
  interrupted: 'Прервано перезапуском',
};

const setWebhooksNotice = (message, type = 'info') => {
  $('webhooksNotice').textContent = message;
  $('webhooksNotice').className = `status-bar status-${type}${message ? '' : ' hidden'}`;
};

const setWebhookDetailsNotice = (message, type = 'info') => {
  $('webhookDetailsNotice').textContent = message;
  $('webhookDetailsNotice').className = `status-bar status-${type}${message ? '' : ' hidden'}`;
};

const setWebhookRetryNotice = (message, type = 'info') => {
  $('webhookRetryNotice').textContent = message;
  $('webhookRetryNotice').className = `status-bar status-${type}${message ? '' : ' hidden'}`;
};

const webhookCell = (row, text, className = '') => {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
};

const webhookButton = (label, handler, className, ariaLabel = '') => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', handler);
  return button;
};

const webhookStatus = (status) => {
  const knownStatus = Object.hasOwn(WEBHOOK_STATUS_LABELS, status);
  return {
    label: knownStatus ? WEBHOOK_STATUS_LABELS[status] : status || 'Неизвестен',
    className: knownStatus ? `webhook-${status}` : 'webhook-unknown',
  };
};

const renderWebhookRows = () => {
  const entries = webhookView.entries;
  const pages = Math.max(1, Math.ceil(webhookView.total / WEBHOOKS_PAGE_SIZE));
  $('webhooksRows').replaceChildren();

  for (const delivery of entries) {
    const row = document.createElement('tr');
    webhookCell(row, niceDate(delivery.createdAt));

    const identity = webhookCell(row, '');
    const paymentId = document.createElement('span');
    paymentId.textContent = delivery.paymentId ? `#${delivery.paymentId}` : 'Платёж не указан';
    const orderId = document.createElement('small');
    orderId.textContent = delivery.orderId ? `Заказ: ${delivery.orderId}` : 'Без номера заказа';
    const event = document.createElement('small');
    event.textContent = delivery.event || 'Событие не указано';
    identity.append(paymentId, orderId, event);

    const url = webhookCell(row, delivery.url || '—', 'webhook-url');
    url.title = delivery.url || '';

    const statusCell = webhookCell(row, '');
    const badge = document.createElement('span');
    const status = webhookStatus(delivery.status);
    badge.className = `webhook-status ${status.className}`;
    badge.textContent = status.label;
    statusCell.append(badge);

    const attempts = Number(delivery.attempts);
    webhookCell(row, Number.isFinite(attempts) ? String(attempts) : '0', 'webhook-number');

    const httpCell = webhookCell(row, '');
    const httpStatus = document.createElement('span');
    httpStatus.textContent =
      delivery.httpStatus === null || delivery.httpStatus === undefined ? 'HTTP —' : `HTTP ${delivery.httpStatus}`;
    const error = document.createElement('small');
    error.textContent =
      delivery.lastError || (delivery.status === 'retrying' ? 'Причина предыдущей ошибки не сохранена.' : 'Ошибок нет');
    httpCell.append(httpStatus, error);

    const actions = webhookCell(row, '', 'webhook-row-actions');
    const details = webhookButton(
      'Подробности',
      () => openWebhookDetails(delivery.id),
      'btn btn-secondary webhook-action-button',
      `Подробности доставки ${delivery.id}`,
    );
    details.disabled = webhookView.retrying;
    const canRetry = Boolean(delivery.canRetry);
    const retryLabel = webhookView.retryingDeliveryId === delivery.id ? 'Постановка…' : 'Повторить';
    const retry = webhookButton(
      retryLabel,
      () => openWebhookRetry(delivery),
      'btn btn-secondary webhook-action-button',
      `Повторить доставку ${delivery.id}`,
    );
    retry.disabled = !canRetry || webhookView.retrying;
    if (!canRetry) {
      const reason = document.createElement('small');
      reason.className = 'webhook-retry-reason';
      reason.textContent = delivery.retryDisabledReason || 'Повтор недоступен';
      retry.title = reason.textContent;
      actions.append(details, retry, reason);
    } else {
      actions.append(details, retry);
    }
    $('webhooksRows').append(row);
  }

  $('webhooksEmpty').classList.toggle('hidden', entries.length > 0 || webhookView.loading);
  $('webhooksEmpty').textContent = webhookView.summary.total
    ? 'Нет доставок с выбранными фильтрами.'
    : 'У этого проекта пока нет доставок вебхуков.';
  const {
    total = 0,
    queued = 0,
    retrying = 0,
    sending = 0,
    delivered = 0,
    failed = 0,
    cancelled = 0,
  } = webhookView.summary;
  $('webhooksSummary').textContent =
    `Всего: ${total} · В очереди: ${queued} · Отправляются: ${sending} · Доставлены: ${delivered} · Ошибки: ${failed} · Отменены: ${cancelled} · По фильтру: ${webhookView.total}`;
  if (retrying) $('webhooksSummary').textContent += ` · Повторяются: ${retrying}`;
  $('webhooksPage').textContent = `${webhookView.page} / ${pages}`;
  $('btnWebhooksPrev').disabled = webhookView.loading || webhookView.page === 1;
  $('btnWebhooksNext').disabled = webhookView.loading || webhookView.page >= pages;
};

const filterWebhooks = () => {
  clearTimeout(webhookView.searchTimer);
  webhookView.page = 1;
  return loadWebhookRows();
};

const searchWebhooks = () => {
  clearTimeout(webhookView.searchTimer);
  webhookView.generation++;
  webhookView.searchTimer = setTimeout(filterWebhooks, 300);
};

const pageWebhooks = (offset) => {
  if (webhookView.loading || webhookView.retrying) return;
  webhookView.page = Math.max(1, webhookView.page + offset);
  return loadWebhookRows();
};

const loadWebhookRows = async () => {
  const projectId = $('webhooksProject').value;
  if (!$('webhooksDialog').open || !projectId) return;
  const generation = ++webhookView.generation;
  webhookView.loading = true;
  $('btnRefreshWebhooks').disabled = true;
  renderWebhookRows();
  setWebhooksNotice('Загружаем доставки…');
  try {
    const query = new URLSearchParams({
      page: String(webhookView.page),
      pageSize: String(WEBHOOKS_PAGE_SIZE),
      status: $('webhooksStatus').value,
      search: $('webhooksSearch').value.trim().slice(0, 120),
    });
    const result = await adminFetch(`/api/webhook-deliveries?${query}`, {
      headers: { 'X-Project-ID': projectId },
    });
    if (generation !== webhookView.generation || !$('webhooksDialog').open) return;
    webhookView.entries = Array.isArray(result.deliveries) ? result.deliveries : [];
    webhookView.page = Number(result.page) || 1;
    webhookView.total = Number(result.total) || 0;
    webhookView.summary = result.summary || {};
    $('webhooksUpdated').textContent = `Список обновлён: ${new Date().toLocaleTimeString('ru-KZ')}`;
    setWebhooksNotice('');
  } catch (error) {
    if (generation !== webhookView.generation || !$('webhooksDialog').open) return;
    setWebhooksNotice(`Не удалось обновить список. ${error.message}`, 'err');
  } finally {
    if (generation === webhookView.generation && $('webhooksDialog').open) {
      webhookView.loading = false;
      $('btnRefreshWebhooks').disabled = false;
      renderWebhookRows();
    }
  }
};

const changeWebhooksProject = () => {
  clearTimeout(webhookView.searchTimer);
  webhookView.generation++;
  closeWebhookDetails();
  closeWebhookRetry();
  webhookView.entries = [];
  webhookView.page = 1;
  webhookView.total = 0;
  webhookView.summary = {};
  $('webhooksUpdated').textContent = '';
  renderWebhookRows();
  return loadWebhookRows();
};

const closeWebhookDetails = () => {
  webhookView.detailsGeneration++;
  $('webhookDetailsSummary').replaceChildren();
  $('webhookAttemptsRows').replaceChildren();
  $('webhookAttemptsEmpty').classList.add('hidden');
  $('webhookAttemptsHistoryNote').textContent = '';
  $('webhookAttemptsHistoryNote').classList.add('hidden');
  setWebhookDetailsNotice('');
  if ($('webhookDetailsDialog').open) $('webhookDetailsDialog').close();
};

const closeWebhookRetry = () => {
  webhookView.retryGeneration++;
  webhookView.pendingRetry = null;
  webhookView.retrying = false;
  webhookView.retryingDeliveryId = null;
  $('webhookRetryDescription').textContent = '';
  setWebhookRetryNotice('');
  $('btnConfirmWebhookRetry').disabled = false;
  if ($('webhookRetryDialog').open) $('webhookRetryDialog').close();
  renderWebhookRows();
};

const closeWebhooks = () => {
  webhookView.generation++;
  clearInterval(webhookView.timer);
  clearTimeout(webhookView.searchTimer);
  webhookView.timer = null;
  webhookView.loading = false;
  closeWebhookDetails();
  closeWebhookRetry();
  webhookView.entries = [];
  webhookView.page = 1;
  webhookView.total = 0;
  webhookView.summary = {};
  $('webhooksRows').replaceChildren();
  $('webhooksUpdated').textContent = '';
  $('webhooksSummary').textContent = '';
  $('webhooksPage').textContent = '';
  $('webhooksEmpty').classList.add('hidden');
  setWebhooksNotice('');
  if ($('webhooksDialog').open) $('webhooksDialog').close();
};

const openWebhooks = async (projectId = '') => {
  closeWebhooks();
  const generation = webhookView.generation;
  $('webhooksStatus').value = 'all';
  $('webhooksSearch').value = '';
  $('webhooksProject').replaceChildren();
  $('webhooksUpdated').textContent = '';
  $('webhooksSummary').textContent = '';
  $('webhooksEmpty').classList.add('hidden');
  $('btnRefreshWebhooks').disabled = true;
  $('webhooksDialog').showModal();
  setWebhooksNotice('Загружаем проекты…');
  try {
    const result = await adminFetch('/api/projects?includeArchived=true');
    if (generation !== webhookView.generation || !$('webhooksDialog').open) return;
    for (const project of result.projects || []) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = `${project.name} · ${project.id}${project.status === 'archived' ? ' (архив)' : ''}`;
      $('webhooksProject').append(option);
    }
    const preferred = projectId || selectedProject();
    if ([...$('webhooksProject').options].some((option) => option.value === preferred))
      $('webhooksProject').value = preferred;
    if (!$('webhooksProject').value && $('webhooksProject').options.length)
      $('webhooksProject').value = $('webhooksProject').options[0].value;
    if (!$('webhooksProject').value) {
      setWebhooksNotice('Создайте проект, чтобы просматривать доставки вебхуков.');
      return;
    }
    webhookView.timer = setInterval(() => {
      if (!webhookView.loading && !webhookView.retrying && !document.hidden) loadWebhookRows();
    }, 10000);
    await changeWebhooksProject();
  } catch (error) {
    if (generation === webhookView.generation && $('webhooksDialog').open) setWebhooksNotice(error.message, 'err');
  }
};

const addWebhookDetail = (labelText, valueText, className = '') => {
  const row = document.createElement('div');
  row.className = 'webhook-detail-row';
  const label = document.createElement('dt');
  label.textContent = labelText;
  const value = document.createElement('dd');
  value.textContent = valueText || '—';
  if (className) value.className = className;
  row.append(label, value);
  $('webhookDetailsSummary').append(row);
};

const renderWebhookDetails = (delivery, attempts) => {
  $('webhookDetailsSummary').replaceChildren();
  addWebhookDetail('Платёж', delivery.paymentId ? `#${delivery.paymentId}` : '—');
  addWebhookDetail('Заказ', delivery.orderId || '—');
  addWebhookDetail('Событие', delivery.event || '—');
  addWebhookDetail('ID доставки (X-Webhook-ID)', delivery.id || '—', 'webhook-break-word');
  addWebhookDetail(
    'Всего попыток',
    delivery.attempts === null || delivery.attempts === undefined ? '0' : String(delivery.attempts),
  );
  addWebhookDetail('Адрес', delivery.url || '—', 'webhook-break-word');
  addWebhookDetail('Статус', webhookStatus(delivery.status).label);
  addWebhookDetail('Создан', niceDate(delivery.createdAt));
  addWebhookDetail('Обновлён', niceDate(delivery.updatedAt));
  addWebhookDetail('Следующая попытка', niceDate(delivery.nextAttemptAt));
  addWebhookDetail('Доставлен', niceDate(delivery.deliveredAt));
  addWebhookDetail(
    'HTTP',
    delivery.httpStatus === null || delivery.httpStatus === undefined ? '—' : String(delivery.httpStatus),
  );
  addWebhookDetail('Последняя ошибка', delivery.lastError || '—', 'webhook-break-word');

  const rows = $('webhookAttemptsRows');
  rows.replaceChildren();
  const attemptCount = Number(delivery.attempts);
  const missingAttemptDetails = Number.isFinite(attemptCount) ? Math.max(0, attemptCount - attempts.length) : 0;
  const historyNote = $('webhookAttemptsHistoryNote');
  historyNote.textContent = missingAttemptDetails
    ? `Для ${missingAttemptDetails} ранних попыток подробности недоступны: они выполнялись до обновления журнала.`
    : '';
  historyNote.classList.toggle('hidden', missingAttemptDetails === 0);
  for (const attempt of attempts) {
    const row = document.createElement('tr');
    webhookCell(row, attempt.number === null || attempt.number === undefined ? '—' : String(attempt.number));
    webhookCell(row, niceDate(attempt.startedAt));
    webhookCell(row, niceDate(attempt.finishedAt));
    webhookCell(row, WEBHOOK_OUTCOME_LABELS[attempt.outcome] || attempt.outcome || '—');
    webhookCell(
      row,
      attempt.httpStatus === null || attempt.httpStatus === undefined ? '—' : String(attempt.httpStatus),
    );
    const duration = Number(attempt.durationMs);
    webhookCell(
      row,
      attempt.durationMs === null || attempt.durationMs === undefined || !Number.isFinite(duration)
        ? '—'
        : `${duration} мс`,
    );
    webhookCell(row, attempt.error || '—', 'webhook-break-word');
    rows.append(row);
  }
  $('webhookAttemptsEmpty').classList.toggle('hidden', attempts.length > 0);
};

const openWebhookDetails = async (deliveryId) => {
  const projectId = $('webhooksProject').value;
  if (!projectId || !$('webhooksDialog').open) return;
  closeWebhookDetails();
  const generation = ++webhookView.detailsGeneration;
  $('webhookDetailsDialog').showModal();
  setWebhookDetailsNotice('Загружаем подробности…');
  try {
    const result = await adminFetch(`/api/webhook-deliveries/${encodeURIComponent(deliveryId)}`, {
      headers: { 'X-Project-ID': projectId },
    });
    if (
      generation !== webhookView.detailsGeneration ||
      !$('webhookDetailsDialog').open ||
      !$('webhooksDialog').open ||
      $('webhooksProject').value !== projectId
    )
      return;
    if (!result.delivery) throw new Error('Сервер не вернул данные доставки.');
    renderWebhookDetails(result.delivery, Array.isArray(result.attempts) ? result.attempts : []);
    setWebhookDetailsNotice('');
  } catch (error) {
    if (generation === webhookView.detailsGeneration && $('webhookDetailsDialog').open)
      setWebhookDetailsNotice(`Не удалось загрузить подробности. ${error.message}`, 'err');
  }
};

const openWebhookRetry = (delivery) => {
  if (!delivery.canRetry || webhookView.retrying || !$('webhooksDialog').open) return;
  webhookView.pendingRetry = { id: delivery.id, projectId: $('webhooksProject').value };
  $('webhookRetryDescription').textContent =
    `Повторно в очередь будет поставлена доставка «${delivery.event || delivery.type || 'вебхук'}» для платежа ${delivery.paymentId ? `#${delivery.paymentId}` : '—'} (заказ ${delivery.orderId || '—'}). ID доставки: ${delivery.id || '—'}. Адрес получателя: ${delivery.url || '—'}.`;
  setWebhookRetryNotice('');
  $('btnConfirmWebhookRetry').disabled = false;
  $('webhookRetryDialog').showModal();
};

const runWebhookRetry = async () => {
  const pending = webhookView.pendingRetry;
  if (!pending || webhookView.retrying || !$('webhookRetryDialog').open) return;
  const generation = ++webhookView.retryGeneration;
  webhookView.retrying = true;
  webhookView.retryingDeliveryId = pending.id;
  $('btnConfirmWebhookRetry').disabled = true;
  setWebhookRetryNotice('Ставим доставку в очередь…');
  renderWebhookRows();
  try {
    await adminFetch(`/api/webhook-deliveries/${encodeURIComponent(pending.id)}/retry`, {
      method: 'POST',
      headers: { 'X-Project-ID': pending.projectId },
    });
    if (generation !== webhookView.retryGeneration) return;
    if (!$('webhooksDialog').open || $('webhooksProject').value !== pending.projectId) return;
    webhookView.retrying = false;
    webhookView.retryingDeliveryId = null;
    closeWebhookRetry();
    await loadWebhookRows();
    if (!$('webhooksNotice').classList.contains('status-err'))
      setWebhooksNotice('Повторная доставка поставлена в очередь.', 'ok');
  } catch (error) {
    if (generation !== webhookView.retryGeneration || !$('webhookRetryDialog').open) return;
    setWebhookRetryNotice(`Не удалось поставить доставку в очередь. ${error.message}`, 'err');
  } finally {
    if (generation === webhookView.retryGeneration) {
      webhookView.retrying = false;
      webhookView.retryingDeliveryId = null;
      $('btnConfirmWebhookRetry').disabled = false;
      renderWebhookRows();
    }
  }
};

$('webhooksDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeWebhooks();
});
$('webhookDetailsDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeWebhookDetails();
});
$('webhookRetryDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeWebhookRetry();
});

Object.assign(window, {
  openWebhooks,
  closeWebhooks,
  loadWebhookRows,
  changeWebhooksProject,
  filterWebhooks,
  searchWebhooks,
  pageWebhooks,
  openWebhookDetails,
  closeWebhookDetails,
  openWebhookRetry,
  closeWebhookRetry,
  runWebhookRetry,
});
