// Read the existing project ledger; financial state remains owned by the server poller.
const paymentView = {
  entries: [],
  generation: 0,
  timer: null,
  searchTimer: null,
  loading: false,
  page: 1,
  total: 0,
  summary: {},
};
const PAYMENTS_PAGE_SIZE = 50;
const PAYMENT_LABELS = {
  pending: 'Отслеживается',
  paid: 'Оплачен',
  failed: 'Не оплачен',
  expired: 'Срок истёк',
  review: 'Требует сверки',
};
const setPaymentsNotice = (message, type = 'info') => {
  $('paymentsNotice').textContent = message;
  $('paymentsNotice').className = `status-bar status-${type}${message ? '' : ' hidden'}`;
};
const paymentCell = (row, text, className = '') => {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
};
const renderPayments = () => {
  const entries = paymentView.entries;
  const pages = Math.max(1, Math.ceil(paymentView.total / PAYMENTS_PAGE_SIZE));
  $('paymentsRows').replaceChildren();
  for (const payment of entries) {
    const row = document.createElement('tr');
    paymentCell(row, niceDate(payment.createdAt));
    const idCell = paymentCell(row, `#${payment.paymentId}`);
    const order = document.createElement('small');
    order.textContent = payment.orderId ? `Заказ: ${payment.orderId}` : 'Без номера заказа';
    idCell.append(order);
    paymentCell(row, payment.type === 'qr' ? 'QR' : payment.type === 'invoice' ? 'Счёт' : payment.type);
    const amount =
      payment.amount === null || payment.amount === undefined || !Number.isFinite(Number(payment.amount))
        ? '—'
        : new Intl.NumberFormat('ru-KZ', {
            style: 'currency',
            currency: 'KZT',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(Number(payment.amount));
    paymentCell(row, amount, 'payment-amount');
    const state = payment.result || 'review';
    const statusCell = paymentCell(row, '');
    const badge = document.createElement('span');
    badge.className = `payment-badge payment-${state}`;
    badge.textContent = PAYMENT_LABELS[state];
    const rawStatus = document.createElement('small');
    rawStatus.textContent = payment.status || 'Статус не получен';
    statusCell.append(badge, rawStatus);
    $('paymentsRows').append(row);
  }
  $('paymentsEmpty').classList.toggle('hidden', entries.length > 0 || paymentView.loading);
  $('paymentsEmpty').textContent = paymentView.summary.total
    ? 'Нет платежей с выбранными фильтрами.'
    : 'У этого проекта пока нет платежей, созданных через сервер.';
  const { total = 0, pending = 0, paid = 0 } = paymentView.summary;
  $('paymentsSummary').textContent =
    `Всего: ${total} · Отслеживаются: ${pending} · Оплачены: ${paid} · По фильтру: ${paymentView.total}`;
  $('paymentsPage').textContent = `${paymentView.page} / ${pages}`;
  $('btnPaymentsPrev').disabled = paymentView.loading || paymentView.page === 1;
  $('btnPaymentsNext').disabled = paymentView.loading || paymentView.page >= pages;
};
const filterPayments = () => {
  clearTimeout(paymentView.searchTimer);
  paymentView.page = 1;
  return loadPaymentRows();
};
const searchPayments = () => {
  clearTimeout(paymentView.searchTimer);
  paymentView.generation++;
  paymentView.searchTimer = setTimeout(filterPayments, 300);
};
const pagePayments = (offset) => {
  if (paymentView.loading) return;
  paymentView.page = Math.max(1, paymentView.page + offset);
  return loadPaymentRows();
};

const loadPaymentRows = async () => {
  const projectId = $('paymentsProject').value;
  if (!$('paymentsDialog').open || !projectId) return;
  const generation = ++paymentView.generation;
  paymentView.loading = true;
  $('btnRefreshPayments').disabled = true;
  renderPayments();
  setPaymentsNotice('Загружаем платежи…');
  try {
    const query = new URLSearchParams({
      page: String(paymentView.page),
      pageSize: String(PAYMENTS_PAGE_SIZE),
      status: $('paymentsStatus').value,
      search: $('paymentsSearch').value.trim(),
    });
    const result = await adminFetch(`/api/payments?${query}`, { headers: { 'X-Project-ID': projectId } });
    if (generation !== paymentView.generation || !$('paymentsDialog').open) return;
    paymentView.entries = Array.isArray(result.payments) ? result.payments : [];
    paymentView.page = result.page;
    paymentView.total = result.total;
    paymentView.summary = result.summary;
    $('paymentsUpdated').textContent = `Список обновлён: ${new Date().toLocaleTimeString('ru-KZ')}`;
    setPaymentsNotice('');
  } catch (error) {
    if (generation !== paymentView.generation || !$('paymentsDialog').open) return;
    setPaymentsNotice(`Не удалось обновить список. ${error.message}`, 'err');
  } finally {
    if (generation === paymentView.generation && $('paymentsDialog').open) {
      paymentView.loading = false;
      $('btnRefreshPayments').disabled = false;
      renderPayments();
    }
  }
};
const changePaymentsProject = () => {
  clearTimeout(paymentView.searchTimer);
  paymentView.entries = [];
  paymentView.page = 1;
  paymentView.total = 0;
  paymentView.summary = {};
  $('paymentsUpdated').textContent = '';
  renderPayments();
  return loadPaymentRows();
};
const closePayments = () => {
  paymentView.generation++;
  clearInterval(paymentView.timer);
  clearTimeout(paymentView.searchTimer);
  paymentView.timer = null;
  paymentView.loading = false;
  paymentView.entries = [];
  paymentView.page = 1;
  paymentView.total = 0;
  paymentView.summary = {};
  $('paymentsRows').replaceChildren();
  if ($('paymentsDialog').open) $('paymentsDialog').close();
};
const openPayments = async (projectId = '') => {
  closePayments();
  const generation = paymentView.generation;
  $('paymentsStatus').value = 'all';
  $('paymentsSearch').value = '';
  $('paymentsProject').replaceChildren();
  $('paymentsUpdated').textContent = '';
  $('paymentsSummary').textContent = '';
  $('paymentsEmpty').classList.add('hidden');
  $('btnRefreshPayments').disabled = true;
  $('paymentsDialog').showModal();
  setPaymentsNotice('Загружаем проекты…');
  try {
    const result = await adminFetch('/api/projects?includeArchived=true');
    if (generation !== paymentView.generation || !$('paymentsDialog').open) return;
    for (const project of result.projects || []) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = `${project.name} · ${project.id}${project.status === 'archived' ? ' (архив)' : ''}`;
      $('paymentsProject').append(option);
    }
    const preferred = projectId || selectedProject();
    if ([...$('paymentsProject').options].some((option) => option.value === preferred))
      $('paymentsProject').value = preferred;
    if (!$('paymentsProject').value) {
      setPaymentsNotice('Создайте проект, чтобы просматривать его платежи.');
      return;
    }
    paymentView.timer = setInterval(() => {
      if (!paymentView.loading && !document.hidden) loadPaymentRows();
    }, 10000);
    await changePaymentsProject();
  } catch (error) {
    if (generation === paymentView.generation && $('paymentsDialog').open) setPaymentsNotice(error.message, 'err');
  }
};
$('paymentsDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closePayments();
});
Object.assign(window, {
  openPayments,
  closePayments,
  loadPaymentRows,
  changePaymentsProject,
  filterPayments,
  searchPayments,
  pagePayments,
});
