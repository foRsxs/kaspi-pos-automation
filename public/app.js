// ─── Kaspi Pay — Frontend App ───

const API = '';

// ─── State ───

let currentOpId = null;
let invoicePollingTimer = null;
let historyOpId = null;
let qrPollingTimer = null;
let qrCountdownTimer = null;
let qrOperationId = null;
// ─── Helpers ───

const $ = (id) => document.getElementById(id);
const digitsOnly = (str) => str.replace(/\D/g, '');
const selectedProject = () => $('projectSelect')?.value || sessionStorage.getItem('kaspi_project_id') || '';
const sessionKey = () => `kaspi_session:${selectedProject()}`;
const KASPI_SESSION_EXPIRED_MESSAGE = 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.';
const KASPI_UNAVAILABLE_MESSAGE = 'Kaspi Pay временно недоступен. Проверьте статус операции перед повтором.';
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const getSession = () => {
  try {
    return JSON.parse(localStorage.getItem(sessionKey()) || '{}');
  } catch {
    return {};
  }
};

const sessionHeaders = () => (selectedProject() ? { 'X-Project-ID': selectedProject() } : {});

const apiFetch = async (path, opts = {}) => {
  const projectId = selectedProject();
  const requestAuthGeneration = authFlowGeneration;
  try {
    const result = await window.adminRequest(API + path, {
      ...opts,
      headers: { ...sessionHeaders(), ...(opts.headers || {}) },
    });
    if (projectId !== selectedProject()) {
      throw new Error('Проект переключён. Результат операции проверьте в исходном проекте.');
    }
    window.clearBankNotice?.(projectId);
    return result;
  } catch (error) {
    if (projectId !== selectedProject()) {
      throw new Error('Проект переключён. Результат операции проверьте в исходном проекте.');
    }
    if (error.code === 'KASPI_SESSION_EXPIRED') {
      if (requestAuthGeneration !== authFlowGeneration) {
        throw Object.assign(
          new Error('Подключение к Kaspi Pay изменилось. Проверьте статус операции перед повтором.'),
          {
            code: 'KASPI_SESSION_CHANGED',
          },
        );
      }
      error.message ||= KASPI_SESSION_EXPIRED_MESSAGE;
      await window.handleKaspiSessionExpired?.(projectId, error.message);
    } else if (error.code === 'KASPI_UNAVAILABLE') {
      error.message = KASPI_UNAVAILABLE_MESSAGE;
      window.showBankUnavailable?.(projectId, error.message);
    }
    throw error;
  }
};

let authFlowGeneration = 0;
let authFlowProjectId = null;

const beginAuthFlow = (projectId) => {
  authFlowGeneration += 1;
  authFlowProjectId = projectId;
  authProcessId = null;
  return authFlowGeneration;
};

const cancelAuthFlow = () => {
  authFlowGeneration += 1;
  authFlowProjectId = null;
  authProcessId = null;
};

const isCurrentAuthFlow = (generation) =>
  generation === authFlowGeneration && authFlowProjectId === selectedProject() && Boolean($('connectDialog')?.open);

const completeAuthFlow = (data, generation) => {
  if (!isCurrentAuthFlow(generation)) return false;
  const projectId = authFlowProjectId;
  saveSession(data, projectId);
  authProcessId = null;
  window.finishConnectFlow?.(projectId, data, generation);
  return true;
};

const switchProject = () => {
  sessionStorage.setItem('kaspi_project_id', $('projectSelect').value);
  // Reload cancels the previous account's UI polling and pending screen updates.
  window.location.reload();
};

const connectServer = async () => {
  if (!window.isAdminLoggedIn()) return showAuthMsg('Войдите в панель администратора', 'err');
  if (!selectedProject()) return showAuthMsg('Выберите проект и его счёт Kaspi Pay', 'err');
  const generation = authFlowProjectId === selectedProject() ? authFlowGeneration : null;
  const projectId = selectedProject();
  try {
    const resp = await apiFetch('/api/session/check');
    if (generation !== null && !isCurrentAuthFlow(generation)) return;
    if (resp.active === true) {
      if (generation !== null) completeAuthFlow({ ...getSession(), ...resp }, generation);
      else {
        saveSession(resp, projectId);
        showMainScreen({ ...getSession(), ...resp });
      }
    } else {
      clearSession(projectId);
      showAuthMsg(resp.error || 'Сессия неактивна. Войдите по SMS.', 'info');
    }
  } catch (err) {
    if (err.code === 'KASPI_SESSION_EXPIRED') return;
    if (generation !== null && !isCurrentAuthFlow(generation)) return;
    showAuthMsg(err.message, 'err');
  }
};

const apiPost = (path, body) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

// ─── Session Persistence (localStorage) ───

const saveSession = (data, projectId = selectedProject()) => {
  const key = `kaspi_session:${projectId}`;
  let prev = {};
  try {
    prev = JSON.parse(localStorage.getItem(key) || '{}');
  } catch {}
  const merged = { ...prev, ...data };
  delete merged.tokenSN;
  delete merged.vtokenSecret;
  delete merged.otpBody;
  delete merged.body;
  if (data.phone) merged.phoneNumber = data.phone;
  localStorage.setItem(key, JSON.stringify(merged));
};

const clearSession = (projectId = selectedProject()) => localStorage.removeItem(`kaspi_session:${projectId}`);

const formatPhone = (digits) => {
  // Format up to 10 digits as "XXX XXX XX XX"
  const d = digits.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  if (d.length <= 8) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`;
};

const attachPhoneFormatter = (el) => {
  el.addEventListener('input', () => {
    const digits = digitsOnly(el.value);
    const formatted = formatPhone(digits);
    if (el.value !== formatted) el.value = formatted;
  });
};

window.addEventListener('DOMContentLoaded', async () => {
  attachPhoneFormatter($('phoneInput'));
  attachPhoneFormatter($('clientPhone'));
});

// ─── Auth UI Helpers ───

const setAuthStep = (n) => {
  for (let i = 1; i <= 3; i++) {
    $(`authStep${i}`).classList.toggle('hidden', i !== n);
    $(`dot${i}`).className = `step-dot${i < n ? ' done' : i === n ? ' active' : ''}`;
  }
};

const showAuthMsg = (msg, type) => {
  const el = $('authMsg');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.className = `status-bar status-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
};

const resetAuth = () => {
  setAuthStep(1);
  $('otpInput').value = '';
  showAuthMsg('', '');
};

// ─── Auth Flow ───

let authProcessId = null;

const sendPhone = async () => {
  const generation = authFlowGeneration;
  if (!isCurrentAuthFlow(generation)) return;
  if (!selectedProject()) return showAuthMsg('Загрузите список и выберите проект', 'err');
  if (!window.isAdminLoggedIn()) return showAuthMsg('Войдите в панель администратора', 'err');
  const phone = digitsOnly($('phoneInput').value);
  if (phone.length < 10) return showAuthMsg('Введите 10 цифр номера', 'err');

  const btn = $('btnSendPhone');
  btn.disabled = true;
  btn.innerHTML = 'Отправка...<span class="loader"></span>';
  showAuthMsg('', '');

  try {
    const init = await apiPost('/api/auth/init');
    if (!isCurrentAuthFlow(generation)) return;
    if (!init.success) {
      showAuthMsg(`Ошибка инициализации: ${JSON.stringify(init.body)}`, 'err');
      return;
    }

    authProcessId = init.processId;

    if (!isCurrentAuthFlow(generation)) return;
    const resp = await apiPost('/api/auth/send-phone', { phoneNumber: phone, processId: authProcessId });
    if (!isCurrentAuthFlow(generation)) return;
    if (resp.success) {
      $('otpDesc').textContent = resp.desc || `SMS отправлен на +7${phone}`;
      setAuthStep(2);
    } else {
      showAuthMsg(`Ошибка: ${resp.body?.data?.desc || JSON.stringify(resp.body)}`, 'err');
    }
  } catch (e) {
    if (!isCurrentAuthFlow(generation)) return;
    showAuthMsg(`Ошибка сети: ${e.message}`, 'err');
  } finally {
    if (isCurrentAuthFlow(generation)) {
      btn.disabled = false;
      btn.textContent = 'Получить SMS код';
    }
  }
};

const verifyOtp = async () => {
  const generation = authFlowGeneration;
  if (!isCurrentAuthFlow(generation)) return;
  const otp = digitsOnly($('otpInput').value);
  if (!otp) return showAuthMsg('Введите код', 'err');

  const btn = $('btnVerifyOtp');
  btn.disabled = true;
  btn.innerHTML = 'Проверка...<span class="loader"></span>';
  showAuthMsg('', '');

  try {
    const resp = await apiPost('/api/auth/verify-otp', { otp, processId: authProcessId });
    if (!isCurrentAuthFlow(generation)) return;
    if (resp.success && resp.step === 'finished') {
      completeAuthFlow(resp, generation);
    } else {
      showAuthMsg(`Неверный код или ошибка: ${resp.body?.data?.desc || JSON.stringify(resp.body)}`, 'err');
    }
  } catch (e) {
    if (!isCurrentAuthFlow(generation)) return;
    showAuthMsg(`Ошибка: ${e.message}`, 'err');
  } finally {
    if (isCurrentAuthFlow(generation)) {
      btn.disabled = false;
      btn.textContent = 'Подтвердить';
    }
  }
};

// ─── Main Screen ───

const showMainScreen = (data) => {
  $('projectDashboard').classList.add('hidden');
  $('adminLogin').classList.add('hidden');
  $('bankWorkspace').classList.remove('hidden');
  $('authScreen').classList.add('hidden');
  $('mainScreen').classList.remove('hidden');
  if (data) {
    $('userName').textContent = data.phone || '—';
    $('userOrg').textContent = data.orgName || '—';
    $('userAvatar').textContent = (data.orgName || 'K')[0].toUpperCase();
  }
  if (typeof window.updateBankProjectStatus === 'function') window.updateBankProjectStatus();
};

const resetBankWorkspace = () => {
  stopInvoicePolling();
  stopQrPolling();
  currentOpId = null;
  historyOpId = null;
  qrOperationId = null;
  salesOpId = null;
  authProcessId = null;
  cancelAuthFlow();
  for (const id of [
    'invoiceResult',
    'qrResult',
    'historyDetail',
    'salesDetail',
    'clientInfo',
    'refundSection',
    'refundMsg',
  ]) {
    $(id).classList.add('hidden');
  }
  for (const id of [
    'invoiceDetails',
    'historyList',
    'historyDetailContent',
    'salesList',
    'salesStats',
    'salesDetailContent',
    'qrCodeContainer',
    'qrTimer',
  ]) {
    $(id).textContent = '';
  }
  for (const id of [
    'clientPhone',
    'invoiceAmount',
    'invoiceComment',
    'qrAmount',
    'phoneInput',
    'otpInput',
    'refundAmount',
  ]) {
    $(id).value = '';
  }
  switchTab('invoice');
};

const logout = async () => {
  clearSession();
  resetBankWorkspace();
  $('mainScreen').classList.add('hidden');
  $('bankWorkspace').classList.add('hidden');
  $('projectDashboard').classList.remove('hidden');
  $('phoneInput').value = '';
  $('otpInput').value = '';
  setAuthStep(1);
  showAuthMsg('', '');
};

const switchTab = (tab) => {
  $('invoiceTab').classList.toggle('hidden', tab !== 'invoice');
  $('qrTab').classList.toggle('hidden', tab !== 'qr');
  $('historyTab').classList.toggle('hidden', tab !== 'history');
  $('salesTab').classList.toggle('hidden', tab !== 'sales');
  $('tabInvoice').classList.toggle('active', tab === 'invoice');
  $('tabQr').classList.toggle('active', tab === 'qr');
  $('tabHistory').classList.toggle('active', tab === 'history');
  $('tabSales').classList.toggle('active', tab === 'sales');
  if (tab === 'history') loadHistory();
  if (tab === 'sales') loadSales();
};

// ─── Invoice ───

const statusBadge = (status) => {
  const map = {
    RemotePaymentCreated: ['Ожидает оплаты', 'pending'],
    RemotePaymentPaid: ['Оплачен', 'paid'],
    RemotePaymentCanceled: ['Отменён', 'canceled'],
    RemotePaymentExpired: ['Истёк', 'expired'],
  };
  const [label, cls] = map[status] || [String(status || 'Неизвестен'), 'pending'];
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
};

const renderDetails = (data, containerId) => {
  if (!data) return;
  const el = $(containerId);
  const rows = (data.DynamicDetails || [])
    .sort((a, b) => a.Order - b.Order)
    .map(
      ({ Title, Data, IsBold }) =>
        `<div class="detail-row">
        <span class="detail-label">${escapeHtml(Title)}</span>
        <span class="detail-value" style="${IsBold ? 'font-weight:700' : ''}">${escapeHtml(Data)}</span>
      </div>`,
    )
    .join('');
  el.innerHTML = `<div style="text-align:center;margin:12px 0;">${statusBadge(data.Status)}</div>${rows}`;
};

const stopInvoicePolling = () => {
  if (invoicePollingTimer) {
    clearInterval(invoicePollingTimer);
    invoicePollingTimer = null;
  }
};

const refreshInvoice = async () => {
  if (!currentOpId) return null;
  try {
    const resp = await apiFetch(`/api/invoice/details?operationId=${encodeURIComponent(currentOpId)}`);
    renderDetails(resp.Data, 'invoiceDetails');
    const { Status: status } = resp.Data || {};
    $('btnCancel').classList.toggle('hidden', status !== 'RemotePaymentCreated');
    if (status && status !== 'RemotePaymentCreated') stopInvoicePolling();
    return status;
  } catch (e) {
    console.error(e);
    return null;
  }
};

const startInvoicePolling = () => {
  stopInvoicePolling();
  refreshInvoice();
  invoicePollingTimer = setInterval(refreshInvoice, 5000);
};

const createInvoice = async () => {
  const phone = digitsOnly($('clientPhone').value);
  const amount = $('invoiceAmount').value;
  const comment = $('invoiceComment').value || 'Оплата';
  if (!phone || !amount) return alert('Заполните телефон и сумму');

  const btn = $('btnCreate');
  btn.disabled = true;
  btn.innerHTML = 'Создание...<span class="loader"></span>';

  try {
    const resp = await apiPost('/api/invoice/create', {
      phoneNumber: phone,
      amount: Number(amount),
      comment,
    });

    if (resp.Data?.QrOperationId) {
      currentOpId = resp.Data.QrOperationId;
      $('invoiceOpId').textContent = `#${currentOpId}`;
      $('invoiceResult').classList.remove('hidden');
      $('clientPhone').value = '';
      $('invoiceAmount').value = '';
      $('invoiceComment').value = '';
      $('clientInfo').classList.add('hidden');
      startInvoicePolling();
    } else {
      alert(`Ошибка: ${resp.Message || JSON.stringify(resp)}`);
    }
  } catch (e) {
    if (e.code !== 'KASPI_SESSION_EXPIRED') alert(`Ошибка: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Выставить счёт';
  }
};

const cancelInvoice = async () => {
  if (!currentOpId || !confirm('Отменить счёт?')) return;
  try {
    await apiPost('/api/invoice/cancel', { operationId: currentOpId });
    refreshInvoice();
  } catch (e) {
    if (e.code !== 'KASPI_SESSION_EXPIRED') alert(`Ошибка: ${e.message}`);
  }
};

// ─── QR Code ───

const FINAL_QR_STATUSES = [
  'Paid',
  'CancelledByUser',
  'NotConfirmedByUser',
  'QrTokenDiscarded',
  'ProcessingFailed',
  'InsufficientFunds',
  'Error',
];

const qrStatusBadge = (status) => {
  const map = {
    QrTokenCreated: ['Ожидание сканирования', 'info'],
    QrTokenScanned: ['Отсканирован', 'info'],
    PaymentConfirmation: ['Подтверждение оплаты...', 'warn'],
    Paid: ['Оплачено ✅', 'ok'],
    CancelledByUser: ['Отменено клиентом', 'err'],
    NotConfirmedByUser: ['Не подтверждено', 'err'],
    QrTokenDiscarded: ['QR не отсканирован', 'err'],
    ProcessingFailed: ['Ошибка обработки', 'err'],
    InsufficientFunds: ['Недостаточно средств', 'err'],
    Error: ['Ошибка', 'err'],
  };
  const [label, cls] = map[status] || [status, 'info'];
  return { label, cls };
};

const stopQrPolling = () => {
  if (qrPollingTimer) {
    clearInterval(qrPollingTimer);
    qrPollingTimer = null;
  }
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer);
    qrCountdownTimer = null;
  }
};

const pollQrStatus = async () => {
  if (!qrOperationId) return;
  try {
    const resp = await apiFetch(`/api/qr/status?qrOperationId=${encodeURIComponent(qrOperationId)}`);
    const status = resp.Data?.Status;
    if (status) {
      const { label, cls } = qrStatusBadge(status);
      const el = $('qrStatus');
      el.className = `status-bar status-${cls}`;
      el.textContent = label;
    }
    if (FINAL_QR_STATUSES.includes(status)) {
      stopQrPolling();
    }
  } catch (e) {
    console.error('QR polling error:', e);
  }
};

const startQrCountdown = (seconds) => {
  let remaining = seconds;
  const timerEl = $('qrTimer');
  const tick = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerEl.textContent = `Осталось: ${m}:${String(s).padStart(2, '0')}`;
    if (remaining <= 0) {
      timerEl.textContent = 'Время истекло';
      stopQrPolling();
    }
    remaining--;
  };
  tick();
  qrCountdownTimer = setInterval(tick, 1000);
};

const generateQrSvg = (text, size = 256) => {
  // Simple QR placeholder using a data URL image via an API
  // For production, use a proper QR library; here we use a public API fallback
  return `<img src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}" alt="QR Code" style="max-width:100%;border-radius:8px;">`;
};

const createQr = async () => {
  const amount = $('qrAmount').value;
  if (!amount) return alert('Введите сумму');

  const btn = $('btnCreateQr');
  btn.disabled = true;
  btn.innerHTML = 'Создание...<span class="loader"></span>';

  stopQrPolling();

  try {
    const resp = await apiPost('/api/qr/create', { amount: Number(amount) });

    if (resp.Data?.QrToken) {
      qrOperationId = resp.Data.QrOperationId;
      const options = resp.Data.QrPaymentBehaviorOptions || {};
      const pollInterval = (parseInt(options.qrCodeScanEventPollingInterval) || 3) * 1000;
      const waitTimeout = parseInt(options.qrCodeScanWaitTimeout) || 180;

      $('qrCodeContainer').innerHTML = generateQrSvg(resp.Data.QrOriginalToken);
      $('qrStatus').className = 'status-bar status-info';
      $('qrStatus').textContent = 'Ожидание сканирования...';
      $('qrResult').classList.remove('hidden');
      $('qrAmount').value = '';

      startQrCountdown(waitTimeout);
      qrPollingTimer = setInterval(pollQrStatus, pollInterval);
    } else {
      alert(`Ошибка: ${resp.Message || JSON.stringify(resp)}`);
    }
  } catch (e) {
    if (e.code !== 'KASPI_SESSION_EXPIRED') alert(`Ошибка: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Создать QR';
  }
};

const resetQr = () => {
  stopQrPolling();
  qrOperationId = null;
  $('qrResult').classList.add('hidden');
  $('qrCodeContainer').innerHTML = '';
  $('qrTimer').textContent = '';
};

// ─── Client Phone Lookup ───

$('clientPhone').addEventListener('blur', async function () {
  const phone = digitsOnly(this.value);
  const info = $('clientInfo');
  if (phone.length < 10) {
    info.classList.add('hidden');
    return;
  }
  try {
    const resp = await apiFetch(`/api/invoice/client-info?phoneNumber=${encodeURIComponent(phone)}`);
    if (resp.Data?.ClientName) {
      info.textContent = `✓ ${resp.Data.ClientName} (${resp.Data.ClientStatus})`;
      info.style.background = '#e8f5e9';
      info.style.color = '#2e7d32';
      info.classList.remove('hidden');
    } else {
      info.textContent = '✗ Клиент не найден';
      info.style.background = '#ffebee';
      info.style.color = '#c62828';
      info.classList.remove('hidden');
    }
  } catch {
    info.classList.add('hidden');
  }
});

// ─── History ───

const loadHistory = async () => {
  const list = $('historyList');
  list.innerHTML =
    '<p style="text-align:center;color:#888;">Загрузка...<span class="loader" style="border-color:#888;border-top-color:transparent;"></span></p>';
  try {
    const resp = await apiPost('/api/invoice/history');
    const ops = resp.Data?.Operations || [];
    if (!ops.length) {
      list.innerHTML = '<p style="text-align:center;color:#888;">Нет операций</p>';
      return;
    }
    list.innerHTML = ops
      .map((op) => {
        const operationId = Number(op.Id);
        return `
        <div class="op-item" onclick="showHistoryDetail(${Number.isFinite(operationId) ? operationId : 0})">
          <div class="op-row">
            <div>
              <div class="op-name">${escapeHtml(op.ClientName || op.ClientShortName || '—')}</div>
              <div class="op-date">${escapeHtml(new Date(op.OrderRegDate).toLocaleString('ru'))}</div>
            </div>
            <div style="text-align:right;">
              <div class="op-amount">${escapeHtml(op.Amount)}</div>
              ${statusBadge(op.Status)}
            </div>
          </div>
        </div>`;
      })
      .join('');
  } catch (e) {
    list.innerHTML = `<p style="color:#c62828;">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
};

const showHistoryDetail = async (opId) => {
  historyOpId = opId;
  const panel = $('historyDetail');
  const content = $('historyDetailContent');
  content.innerHTML = '<p style="text-align:center;">Загрузка...</p>';
  panel.classList.remove('hidden');
  try {
    const resp = await apiFetch(`/api/invoice/details?operationId=${encodeURIComponent(opId)}`);
    renderDetails(resp.Data, 'historyDetailContent');
    $('btnCancelFromHistory').classList.toggle('hidden', resp.Data?.Status !== 'RemotePaymentCreated');
  } catch {
    content.innerHTML = '<p style="color:#c62828;">Ошибка</p>';
  }
};

const cancelFromHistory = async () => {
  if (!historyOpId || !confirm('Отменить счёт?')) return;
  try {
    await apiPost('/api/invoice/cancel', { operationId: historyOpId });
    showHistoryDetail(historyOpId);
    loadHistory();
  } catch (e) {
    if (e.code !== 'KASPI_SESSION_EXPIRED') alert(`Ошибка: ${e.message}`);
  }
};

// ─── Sales (operations history + details + refund) ───

let salesOpId = null;

const loadSales = async () => {
  const list = $('salesList');
  const stats = $('salesStats');
  list.innerHTML =
    '<p style="text-align:center;color:#888;">Загрузка...<span class="loader" style="border-color:#888;border-top-color:transparent;"></span></p>';
  stats.innerHTML = '';
  try {
    const now = new Date();
    const endDate =
      now.getFullYear() +
      '-' +
      String(now.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(now.getDate()).padStart(2, '0') +
      'T23:59:59.000+0500';
    const resp = await apiPost('/api/history/operations', { endDate });
    const data = resp.Data || {};
    // Stats
    const s = data.Statistic || {};
    stats.innerHTML = `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
      <div style="background:#e8f5e9;padding:8px 14px;border-radius:10px;text-align:center;"><div style="font-size:12px;color:#2e7d32;">Продажи</div><div style="font-weight:700;color:#2e7d32;">${escapeHtml(s.SalesAmount ?? 0)} ₸</div><div style="font-size:11px;color:#888;">${escapeHtml(s.SalesCount ?? 0)} шт</div></div>
      <div style="background:#ffebee;padding:8px 14px;border-radius:10px;text-align:center;"><div style="font-size:12px;color:#c62828;">Возвраты</div><div style="font-weight:700;color:#c62828;">${escapeHtml(s.ReturnsAmount ?? 0)} ₸</div><div style="font-size:11px;color:#888;">${escapeHtml(s.ReturnsCount ?? 0)} шт</div></div>
    </div>`;
    // Operations list
    const dailySets = data.DailySets || [];
    if (!dailySets.length) {
      list.innerHTML = '<p style="text-align:center;color:#888;">Нет операций</p>';
      return;
    }
    let html = '';
    for (const day of dailySets) {
      html += `<div style="font-size:13px;color:#888;margin:12px 0 4px;font-weight:600;">${escapeHtml(day.Date || '')}</div>`;
      for (const op of day.Operations || []) {
        const isReturn = op.OperationType === 1;
        const sign = isReturn ? '+' : '';
        const color = isReturn ? '#c62828' : '#1a1a1a';
        const operationId = Number(op.Id);
        const operationMethod = Number(op.OperationMethod || 0);
        html += `<div class="op-item" onclick="showSalesDetail(${Number.isFinite(operationId) ? operationId : 0}, ${Number.isFinite(operationMethod) ? operationMethod : 0})">
          <div class="op-row">
            <div>
              <div class="op-name">${escapeHtml(op.ClientName || op.ClientShortName || '—')}</div>
              <div class="op-date">${escapeHtml(op.Time || '')}</div>
            </div>
            <div style="text-align:right;">
              <div class="op-amount" style="color:${color};">${sign}${escapeHtml(op.Amount)} ₸</div>
            </div>
          </div>
        </div>`;
      }
    }
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = `<p style="color:#c62828;">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
};

const showSalesDetail = async (id, operationMethod) => {
  salesOpId = id;
  const panel = $('salesDetail');
  const content = $('salesDetailContent');
  const refundSection = $('refundSection');
  const refundMsg = $('refundMsg');
  content.innerHTML = '<p style="text-align:center;">Загрузка...</p>';
  refundSection.classList.add('hidden');
  refundMsg.classList.add('hidden');
  panel.classList.remove('hidden');
  try {
    const resp = await apiPost('/api/history/details', { id, operationMethod: operationMethod || 0 });
    const d = resp.Data || {};
    let rows = '';
    const receiptUrl = (() => {
      try {
        const url = new URL(d.ReceiptUrl);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
      } catch {
        return '';
      }
    })();
    const fields = [
      ['Сумма', d.Amount ? `${d.Amount} ₸` : null],
      ['Клиент', d.ClientName || d.ClientShortName],
      ['Дата', d.OrderRegDate ? new Date(d.OrderRegDate).toLocaleString('ru') : null],
      ['Статус', d.StatusDescription],
      ['Доступно к возврату', d.AvailableReturnAmount != null ? `${d.AvailableReturnAmount} ₸` : null],
      ['Тип возврата', d.PossibleReturnType],
      [
        'Чек',
        receiptUrl ? `<a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noopener noreferrer">Открыть</a>` : null,
      ],
    ];
    for (const [label, value] of fields) {
      if (value != null)
        rows += `<div class="detail-row"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${label === 'Чек' ? value : escapeHtml(value)}</span></div>`;
    }
    // Returns history
    if (d.Returns && d.Returns.length) {
      rows += '<div style="margin-top:12px;font-weight:600;font-size:14px;">Возвраты:</div>';
      for (const r of d.Returns) {
        rows += `<div class="detail-row"><span class="detail-label">${escapeHtml(r.Date || '')}</span><span class="detail-value" style="color:#c62828;">${escapeHtml(r.Amount)} ₸</span></div>`;
      }
    }
    content.innerHTML = rows || '<p style="color:#888;">Нет данных</p>';
    // Show refund if available
    const returnAmount = parseFloat(String(d.AvailableReturnAmount || '0').replace(/[^\d.]/g, ''));
    if (returnAmount > 0) {
      $('refundAmount').value = returnAmount;
      $('refundAmount').max = returnAmount;
      refundSection.classList.remove('hidden');
    }
  } catch (e) {
    content.innerHTML = `<p style="color:#c62828;">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
};

const createRefund = async () => {
  const amount = $('refundAmount').value;
  if (!salesOpId || !amount) return alert('Укажите сумму возврата');
  if (!confirm(`Вернуть ${amount} ₸?`)) return;
  const btn = $('btnRefund');
  const msg = $('refundMsg');
  btn.disabled = true;
  btn.innerHTML = 'Возврат...<span class="loader"></span>';
  msg.classList.add('hidden');
  try {
    const resp = await apiPost('/api/refund/create', { qrOperationId: salesOpId, returnAmount: Number(amount) });
    if (resp.StatusCode === 0) {
      msg.className = 'status-bar status-ok';
      msg.textContent = 'Возврат выполнен успешно';
    } else {
      msg.className = 'status-bar status-err';
      msg.textContent = resp.Description || resp.Message || 'Ошибка возврата';
    }
    msg.classList.remove('hidden');
    // Refresh detail
    showSalesDetail(salesOpId, 0);
  } catch (e) {
    if (e.code === 'KASPI_SESSION_EXPIRED') return;
    msg.className = 'status-bar status-err';
    msg.textContent = `Ошибка: ${e.message}`;
    msg.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сделать возврат';
  }
};

// ─── Expose to HTML onclick handlers ───

Object.assign(window, {
  kaspiSessionExpiredMessage: KASPI_SESSION_EXPIRED_MESSAGE,
  sendPhone,
  verifyOtp,
  showAuthMsg,
  stopInvoicePolling,
  stopQrPolling,
  resetAuth,
  logout,
  connectServer,
  beginAuthFlow,
  cancelAuthFlow,
  isCurrentAuthFlow,
  completeAuthFlow,
  clearSession,
  getSession,
  showMainScreen,
  resetBankWorkspace,
  switchProject,
  switchTab,
  createInvoice,
  refreshInvoice,
  cancelInvoice,
  createQr,
  resetQr,
  loadHistory,
  showHistoryDetail,
  cancelFromHistory,
  loadSales,
  showSalesDetail,
  createRefund,
});

// ─── Init ───

setAuthStep(1);
