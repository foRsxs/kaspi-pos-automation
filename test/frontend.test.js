import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';
import { URLSearchParams } from 'node:url';

const source = ['public/security.js', 'public/app.js', 'public/admin.js', 'public/payments.js', 'public/webhooks.js']
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

const makePage = (fetchImplementation = async () => ({ ok: true, json: async () => ({}) })) => {
  const elements = new Map();
  let created = 0;
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      if (['bankWorkspace', 'mainScreen'].includes(id)) classes.add('hidden');
      elements.set(id, {
        value: '',
        textContent: '',
        disabled: false,
        open: false,
        dataset: {},
        style: {},
        children: [],
        get options() {
          return this.children;
        },
        append(...children) {
          this.children.push(...children);
        },
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
          toggle: (name, force) => {
            const enabled = force ?? !classes.has(name);
            if (enabled) classes.add(name);
            else classes.delete(name);
            return enabled;
          },
        },
        addEventListener() {},
        setAttribute(name, value) {
          this[name] = value;
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
        focus() {},
        reset() {},
        replaceChildren(...children) {
          this.children = children;
        },
      });
    }
    return elements.get(id);
  };
  const storage = () => {
    const data = new Map();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
    };
  };
  const context = vm.createContext({
    document: {
      getElementById: element,
      createElement: () => element(`created-${created++}`),
      querySelectorAll: () => [],
    },
    window: { addEventListener() {}, dispatchEvent() {}, location: { href: 'http://localhost/' } },
    localStorage: storage(),
    sessionStorage: storage(),
    fetch: fetchImplementation,
    console,
    URL,
    URLSearchParams,
    Headers: globalThis.Headers,
    CustomEvent: globalThis.CustomEvent,
    Option: class {
      constructor(text, value) {
        this.textContent = text;
        this.value = value;
      }
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    confirm: () => assert.fail('Admin confirmation must use the HTML dialog'),
  });
  vm.runInContext(source, context);
  vm.runInContext("securityState.authenticated = true; securityState.csrfToken = 'test-csrf-token';", context);
  return { context, element, run: (code) => vm.runInContext(code, context) };
};

it('keeps only the selected payment tab visible when project status is refreshed', () => {
  const page = makePage();
  page.element('projectSelect').value = 'shop';
  page.run("adminState.projects = [{id:'shop',status:'active'}]; switchTab('qr'); updateBankProjectStatus();");
  assert.equal(page.element('invoiceTab').classList.contains('hidden'), true);
  assert.equal(page.element('qrTab').classList.contains('hidden'), false);
  page.run("adminState.projects[0].status = 'disabled'; updateBankProjectStatus();");
  assert.equal(page.element('btnCreate').disabled, true);
  assert.equal(page.element('btnCreateQr').disabled, true);
});

it('clears previous account operation IDs, results and SMS flow before opening another account', () => {
  const page = makePage();
  page.run('currentOpId=11; historyOpId=12; salesOpId=13; qrOperationId=14; authProcessId="old-flow";');
  page.element('salesList').textContent = 'Old account operation';
  page.element('invoiceAmount').value = '123';
  page.run('resetBankWorkspace();');
  assert.equal(
    page.run('[currentOpId,historyOpId,salesOpId,qrOperationId,authProcessId].every(value=>value===null)'),
    true,
  );
  assert.equal(page.element('salesList').textContent, '');
  assert.equal(page.element('invoiceAmount').value, '');
  assert.equal(page.element('salesDetail').classList.contains('hidden'), true);
});

it('ignores an in-flight bank response after the user changes the selected account', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  page.element('projectSelect').value = 'shop';
  const pending = page.run("apiFetch('/api/invoice/details?operationId=11')");
  page.element('projectSelect').value = 'booking';
  finish({ ok: true, json: async () => ({ Data: { Status: 'Processed' } }) });
  await assert.rejects(pending, /Проект переключён/);
});

it('requests explicit HTML confirmation before rotating an API key and cancels without a request', async () => {
  let requests = 0;
  const page = makePage(async () => {
    requests++;
    return { ok: true, json: async () => ({}) };
  });
  await page.run("rotateProjectKey({id:'shop',name:'Магазин'})");
  assert.equal(page.element('confirmDialog').open, true);
  assert.equal(requests, 0);
  page.run('closeConfirmDialog();');
  assert.equal(page.element('confirmDialog').open, false);
  assert.equal(page.run('adminState.pendingAction'), null);
  assert.equal(requests, 0);
});

it('opens SMS reconnection even for a connected account without sending requests or clearing another project', async () => {
  let requests = 0;
  const page = makePage(async () => {
    requests++;
    return { ok: true, json: async () => ({ active: true }) };
  });
  page.element('projectSelect').value = 'shop';
  page.run(`
    adminState.projects = [{id:'shop',name:'Магазин',status:'active',connection:{connected:true,orgName:'Demo'}}];
    localStorage.setItem('kaspi_session:shop', JSON.stringify({profileId:11}));
    localStorage.setItem('kaspi_session:booking', JSON.stringify({profileId:22}));
  `);
  await page.run("connectProject('shop', {forceLogin:true})");
  assert.equal(requests, 0, 'SMS reconnection must not be replaced by a session check or server logout');
  assert.equal(page.element('connectDialog').open, true);
  assert.equal(page.element('projectDashboard').classList.contains('hidden'), false);
  assert.equal(page.element('authScreen').classList.contains('hidden'), false);
  assert.equal(page.element('mainScreen').classList.contains('hidden'), true);
  assert.equal(page.run("localStorage.getItem('kaspi_session:shop')"), null);
  assert.equal(page.run("JSON.parse(localStorage.getItem('kaspi_session:booking')).profileId"), 22);
});

it('cancels a pending SMS initialization when the connection dialog closes', async () => {
  let finish;
  const requests = [];
  const page = makePage((path) => {
    requests.push(path);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  page.run("adminState.projects = [{id:'shop',name:'Магазин',status:'active'}];");
  await page.run("connectProject('shop', {forceLogin:true})");
  page.element('phoneInput').value = '7000000001';
  const pending = page.run('sendPhone()');
  page.run('closeConnectDialog()');
  finish({ ok: true, json: async () => ({ success: true, processId: 'late-auth-flow' }) });
  await pending;
  assert.deepEqual(requests, ['/api/auth/init'], 'a closed flow must not send the phone after a late init reply');
  assert.equal(page.element('connectDialog').open, false);
  assert.equal(page.run('authProcessId'), null);
  assert.equal(page.element('phoneInput').value, '');
  assert.equal(page.element('bankWorkspace').classList.contains('hidden'), true);
});

it('returns from the account connection dialog to the same project settings', async () => {
  const page = makePage();
  page.run("adminState.projects = [{id:'shop',name:'Магазин',status:'active',webhooks:[]}]; adminState.editId='shop';");
  page.element('projectName').value = 'Магазин';
  page.element('projectStatus').value = 'active';
  page.element('webhookRows').querySelectorAll = () => [];
  page.element('projectDialog').open = true;
  await page.run('openAccountFromSettings(true)');
  assert.equal(page.element('projectDialog').open, true);
  assert.equal(page.element('connectDialog').open, true);
  page.run('closeConnectDialog()');
  assert.equal(page.element('connectDialog').open, false);
  assert.equal(page.element('projectDialog').open, true);
  assert.equal(page.element('projectName').value, 'Магазин');
  assert.equal(page.run('adminState.editId'), 'shop');
});

it('ignores a successful OTP response after closing and reopening the same project connection', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  page.run("adminState.projects = [{id:'shop',name:'Магазин',status:'active'}];");
  await page.run("connectProject('shop', {forceLogin:true})");
  page.run("authProcessId = 'old-flow';");
  page.element('otpInput').value = '123456';
  const pending = page.run('verifyOtp()');
  page.run('closeConnectDialog()');
  await page.run("connectProject('shop', {forceLogin:true})");
  finish({ ok: true, json: async () => ({ success: true, step: 'finished', profileId: 11 }) });
  await pending;
  assert.equal(page.element('connectDialog').open, true, 'the new flow must remain open');
  assert.equal(page.run("localStorage.getItem('kaspi_session:shop')"), null);
  assert.equal(page.element('bankWorkspace').classList.contains('hidden'), true);
  assert.equal(page.run('authProcessId'), null);
});

it('does not replace another project context when the post-login refresh arrives after closing', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  page.run("adminState.projects = [{id:'shop',name:'Магазин',status:'active'}];");
  await page.run("connectProject('shop', {forceLogin:true})");
  const pending = page.run("finishConnectFlow('shop', {orgName:'Demo'}, authFlowGeneration)");
  page.run("closeConnectDialog(); adminState.projects = [{id:'booking',name:'Бронирование',status:'active'}];");
  page.element('projectSelect').value = 'booking';
  finish({ ok: true, json: async () => ({ projects: [{ id: 'shop', name: 'Old response', status: 'active' }] }) });
  await pending;
  assert.equal(page.run('adminState.projects[0].id'), 'booking');
  assert.equal(page.element('projectSelect').value, 'booking');
  assert.equal(page.element('connectDialog').open, false);
});

it('allows account setup when unchanged webhook events were saved in a different order', () => {
  const page = makePage();
  page.element('projectName').value = 'Магазин';
  page.element('projectStatus').value = 'active';
  page.element('webhookRows').querySelectorAll = () => [
    {
      dataset: { webhookId: 'demo-hook' },
      querySelector: (selector) => ({ value: selector === '.webhook-url' ? 'https://example.com/hook' : '' }),
      querySelectorAll: () => [{ value: 'payment.success' }, { value: 'payment.failed' }],
    },
  ];
  assert.equal(
    page.run(`projectSettingsHaveChanges({name:'Магазин',status:'active',webhooks:[
    {id:'demo-hook',url:'https://example.com/hook',events:['payment.failed','payment.success']}
  ]})`),
    false,
  );
  page.element('projectName').value = 'Другое название';
  assert.equal(page.run("projectSettingsHaveChanges({name:'Магазин',status:'active',webhooks:[]})"), true);
});

it('requests server filters and the requested page without filtering returned rows in the browser', async () => {
  const requests = [];
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    return {
      ok: true,
      json: async () => ({
        payments: [{ paymentId: '52', type: 'qr', status: 'Processed', result: 'paid', amount: 100, createdAt: 1 }],
        total: 102,
        page: 2,
        pageSize: 50,
        summary: { total: 120, pending: 18, paid: 102 },
      }),
    };
  });
  page.element('paymentsProject').value = 'shop';
  page.element('paymentsStatus').value = 'paid';
  page.element('paymentsSearch').value = 'ORD-';
  page.element('paymentsDialog').open = true;
  page.run('paymentView.page = 2;');
  await page.run('loadPaymentRows()');
  const query = new URL(requests[0].path, 'http://localhost').searchParams;
  assert.equal(query.get('page'), '2');
  assert.equal(query.get('pageSize'), '50');
  assert.equal(query.get('status'), 'paid');
  assert.equal(query.get('search'), 'ORD-');
  assert.equal(page.element('paymentsRows').children.length, 1, 'show the server page as returned');
  assert.equal(page.element('paymentsPage').textContent, '2 / 3');
  assert.equal(page.element('btnPaymentsNext').disabled, false);
  assert.match(page.element('paymentsSummary').textContent, /Всего: 120/);
});

it('isolates payment-view requests from the bank workspace and ignores the previous project reply', async () => {
  const requests = [];
  const page = makePage((path, options) => new Promise((resolve) => requests.push({ path, options, resolve })));
  page.element('projectSelect').value = 'bank-workspace-project';
  page.element('paymentsProject').value = 'shop';
  page.element('paymentsStatus').value = 'all';
  page.element('paymentsDialog').open = true;
  const first = page.run('loadPaymentRows()');
  page.element('paymentsProject').value = 'booking';
  const second = page.run('changePaymentsProject()');
  assert.equal(new URL(requests[0].path, 'http://localhost').pathname, '/api/payments');
  assert.equal(requests[0].options.headers.get('X-Project-ID'), 'shop');
  assert.equal(requests[1].options.headers.get('X-Project-ID'), 'booking');
  requests[1].resolve({
    ok: true,
    json: async () => ({
      payments: [
        { paymentId: '22', type: 'qr', amount: 1200, status: 'Wait', result: 'pending', event: null, createdAt: 1 },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
      summary: { total: 1, pending: 1, paid: 0 },
    }),
  });
  await second;
  requests[0].resolve({ ok: true, json: async () => ({ payments: [{ paymentId: '11' }] }) });
  await first;
  assert.equal(page.run('paymentView.entries[0].paymentId'), '22');
  assert.equal(page.element('projectSelect').value, 'bank-workspace-project');
  assert.equal(page.element('paymentsRows').children.length, 1);
});

it('does not restore payment rows after their dialog was closed during refresh', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  page.element('paymentsProject').value = 'shop';
  page.element('paymentsStatus').value = 'all';
  page.element('paymentsDialog').open = true;
  const pending = page.run('loadPaymentRows()');
  page.run('closePayments()');
  finish({ ok: true, json: async () => ({ payments: [{ paymentId: '11' }] }) });
  await pending;
  assert.equal(page.element('paymentsDialog').open, false);
  assert.equal(page.run('paymentView.entries.length'), 0);
  assert.equal(page.element('paymentsRows').children.length, 0);
  assert.equal(page.run('paymentView.timer'), null);
});

it('loads webhook deliveries from the selected archived-capable project using server filters and page size 50', async () => {
  const requests = [];
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    return {
      ok: true,
      json: async () => ({
        deliveries: [
          {
            id: 'delivery-1',
            projectId: 'shop',
            paymentId: 'payment-8',
            type: 'invoice',
            orderId: 'ORDER-88',
            event: 'payment.failed',
            url: 'https://merchant.example/hook',
            status: 'failed',
            attempts: 3,
            httpStatus: 503,
            lastError: 'Service unavailable',
            createdAt: '2026-11-10T10:00:00Z',
            canRetry: false,
            retryDisabledReason: 'Получатель больше не настроен',
          },
        ],
        total: 62,
        page: 2,
        pageSize: 50,
        summary: { total: 62, queued: 2, retrying: 1, sending: 1, delivered: 45, failed: 11, cancelled: 2 },
      }),
    };
  });
  page.element('webhooksProject').value = 'shop';
  page.element('webhooksStatus').value = 'failed';
  page.element('webhooksSearch').value = 'ORDER-88';
  page.element('webhooksDialog').open = true;
  page.run('webhookView.page = 2;');

  await page.run('loadWebhookRows()');

  const requestUrl = new URL(requests[0].path, 'http://localhost');
  assert.equal(requestUrl.pathname, '/api/webhook-deliveries');
  assert.equal(requestUrl.searchParams.get('page'), '2');
  assert.equal(requestUrl.searchParams.get('pageSize'), '50');
  assert.equal(requestUrl.searchParams.get('status'), 'failed');
  assert.equal(requestUrl.searchParams.get('search'), 'ORDER-88');
  assert.equal(requests[0].options.headers.get('X-Project-ID'), 'shop');
  const row = page.element('webhooksRows').children[0];
  assert.equal(row.children[2].textContent, 'https://merchant.example/hook');
  assert.equal(row.children[5].children[0].textContent, 'HTTP 503');
  assert.equal(row.children[6].children[1].disabled, true);
  assert.equal(row.children[6].children[2].textContent, 'Получатель больше не настроен');
  assert.equal(page.element('webhooksPage').textContent, '2 / 2');
  assert.match(page.element('webhooksSummary').textContent, /Ошибки: 11/);
});

it('does not restore webhook deliveries after the journal closes during refresh', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  page.element('webhooksProject').value = 'shop';
  page.element('webhooksStatus').value = 'all';
  page.element('webhooksDialog').open = true;
  const pending = page.run('loadWebhookRows()');
  page.run('closeWebhooks()');
  finish({ ok: true, json: async () => ({ deliveries: [{ id: 'private-delivery' }], total: 1 }) });
  await pending;
  assert.equal(page.element('webhooksDialog').open, false);
  assert.equal(page.run('webhookView.entries.length'), 0);
  assert.equal(page.element('webhooksRows').children.length, 0);
  assert.equal(page.run('webhookView.timer'), null);
});

it('loads archived webhook projects from the includeArchived project list', async () => {
  const requests = [];
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    if (path === '/api/projects?includeArchived=true')
      return {
        ok: true,
        json: async () => ({ projects: [{ id: 'old-shop', name: 'Старый магазин', status: 'archived' }] }),
      };
    return {
      ok: true,
      json: async () => ({ deliveries: [], total: 0, page: 1, summary: { total: 0 } }),
    };
  });

  await page.run("openWebhooks('old-shop')");

  assert.equal(requests[0].path, '/api/projects?includeArchived=true');
  assert.equal(page.element('webhooksProject').value, 'old-shop');
  assert.equal(requests[1].options.headers.get('X-Project-ID'), 'old-shop');
  page.run('closeWebhooks()');
});

it('clears webhook journal data when the administrator session is logged out', () => {
  const page = makePage();
  page.element('webhooksDialog').open = true;
  page.run("webhookView.entries = [{id:'private-delivery'}]; webhookView.total = 1;");

  page.run("clearAdminSessionUI('Сессия завершена');");

  assert.equal(page.element('webhooksDialog').open, false);
  assert.equal(page.run('webhookView.entries.length'), 0);
  assert.equal(page.element('webhooksRows').children.length, 0);
  assert.equal(page.run('securityState.authenticated'), false);
});

it('loads scoped webhook attempt details, including delivery ID and nullable duration', async () => {
  const requests = [];
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    return {
      ok: true,
      json: async () => ({
        delivery: {
          id: 'wh-42',
          paymentId: 'pay-42',
          orderId: 'order-42',
          event: 'payment.failed',
          url: 'https://merchant.example/hook',
          status: 'failed',
          attempts: 2,
          createdAt: 1794300000000,
          updatedAt: 1794300100000,
        },
        attempts: [
          { number: 1, startedAt: 1794300000000, outcome: 'interrupted', durationMs: null, error: 'Worker restarted' },
        ],
      }),
    };
  });
  page.element('webhooksProject').value = 'archived-shop';
  page.element('webhooksDialog').open = true;

  await page.run("openWebhookDetails('wh-42')");

  assert.equal(requests[0].path, '/api/webhook-deliveries/wh-42');
  assert.equal(requests[0].options.headers.get('X-Project-ID'), 'archived-shop');
  assert.equal(page.element('webhookDetailsSummary').children[3].children[1].textContent, 'wh-42');
  assert.equal(page.element('webhookDetailsSummary').children[4].children[1].textContent, '2');
  const attempt = page.element('webhookAttemptsRows').children[0];
  assert.equal(attempt.children[3].textContent, 'Прервано перезапуском');
  assert.equal(attempt.children[5].textContent, '—');
  assert.equal(
    page.element('webhookAttemptsHistoryNote').textContent,
    'Для 1 ранних попыток подробности недоступны: они выполнялись до обновления журнала.',
  );
  page.run('closeWebhookDetails()');
  assert.equal(page.element('webhookAttemptsRows').children.length, 0);
});

it('cancels webhook retry without a request and sends a confirmed retry through adminRequest with CSRF', async () => {
  const requests = [];
  let finishRetry;
  const page = makePage((path, options) => {
    requests.push({ path, options });
    if (path.includes('/retry'))
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    return Promise.resolve({
      ok: true,
      json: async () => ({ deliveries: [], total: 0, page: 1, summary: { total: 0 } }),
    });
  });
  page.element('webhooksProject').value = 'shop';
  page.element('webhooksDialog').open = true;

  page.run(
    "openWebhookRetry({id:'delivery-42',paymentId:'pay-42',orderId:'order-42',event:'payment.failed',url:'https://merchant.example/hook',canRetry:true})",
  );
  assert.equal(page.element('webhookRetryDialog').open, true);
  assert.match(page.element('webhookRetryDescription').textContent, /payment\.failed/);
  assert.match(page.element('webhookRetryDescription').textContent, /delivery-42/);
  assert.match(page.element('webhookRetryDescription').textContent, /https:\/\/merchant\.example\/hook/);
  page.run('closeWebhookRetry()');
  assert.equal(requests.length, 0, 'cancel must not retry');

  page.run(
    "openWebhookRetry({id:'delivery-42',paymentId:'pay-42',orderId:'order-42',event:'payment.failed',url:'https://merchant.example/hook',canRetry:true})",
  );
  const first = page.run('runWebhookRetry()');
  const second = page.run('runWebhookRetry()');
  assert.equal(requests.length, 1, 'double click must create only one retry request');
  assert.equal(requests[0].path, '/api/webhook-deliveries/delivery-42/retry');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.get('X-Project-ID'), 'shop');
  assert.equal(requests[0].options.headers.get('X-CSRF-Token'), 'test-csrf-token');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.headers.get('Authorization'), null);

  finishRetry({ ok: true, status: 202, json: async () => ({ delivery: { id: 'delivery-42' } }) });
  await Promise.all([first, second]);
  assert.equal(requests.length, 2, 'a successful retry refreshes the list');
  assert.equal(new URL(requests[1].path, 'http://localhost').pathname, '/api/webhook-deliveries');
  assert.equal(page.element('webhookRetryDialog').open, false);
  assert.equal(page.element('webhooksNotice').textContent, 'Повторная доставка поставлена в очередь.');
});

it('shows webhook delivery access on active and archived project cards', () => {
  const page = makePage();
  const active = page.run("buildProjectCard({id:'shop',name:'Магазин',status:'active'})");
  const archived = page.run("buildProjectCard({id:'old-shop',name:'Старый магазин',status:'archived'}, true)");
  const allText = (node) => [node.textContent, ...(node.children || []).map(allText)].join(' ');
  assert.match(allText(active), /Доставка вебхуков/);
  assert.match(allText(archived), /Доставка вебхуков/);
});

it('uses cookie and CSRF for browser writes without sending an administrative Bearer key', async () => {
  const requests = [];
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    return { ok: true, json: async () => ({}) };
  });
  await page.run("adminRequest('/api/projects', {method:'POST',headers:{Authorization:'Bearer old-key'},body:'{}'})");
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.headers.get('Authorization'), null);
  assert.equal(requests[0].options.headers.get('X-CSRF-Token'), 'test-csrf-token');
});

it('rejects a late private response after the browser session changes', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = page.run("adminRequest('/api/projects')");
  page.run("updateSecurityState({authenticated:false,csrfToken:''})");
  finish({ ok: true, json: async () => ({ projects: [{ id: 'private-project' }] }) });
  await assert.rejects(pending, /Сессия администратора изменилась/);
});
