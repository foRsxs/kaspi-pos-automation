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
  const alerts = [];
  const makeEventTarget = () => {
    const listeners = new Map();
    return {
      addEventListener(type, listener) {
        const handlers = listeners.get(type) || [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) || []) listener(event);
        return true;
      },
    };
  };
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      if (['bankWorkspace', 'mainScreen'].includes(id)) classes.add('hidden');
      const target = makeEventTarget();
      elements.set(id, {
        ...target,
        tagName: id.toLowerCase().endsWith('dialog') ? 'DIALOG' : 'DIV',
        value: '',
        textContent: '',
        disabled: false,
        checked: false,
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
        add(child) {
          this.children.push(child);
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
        setAttribute(name, value) {
          this[name] = value;
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
          this.dispatchEvent({ type: 'close' });
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
  const document = {
    getElementById: element,
    createElement: () => element(`created-${created++}`),
    querySelectorAll: (selector) =>
      selector === 'dialog[open]'
        ? [...elements.values()].filter((item) => item.tagName === 'DIALOG' && item.open)
        : [],
  };
  Object.assign(document, makeEventTarget());
  const window = Object.assign(makeEventTarget(), { location: { href: 'http://localhost/' } });
  const context = vm.createContext({
    document,
    window,
    localStorage: storage(),
    sessionStorage: storage(),
    fetch: fetchImplementation,
    alert: (message) => alerts.push(message),
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
  return { context, document, window, element, alerts, run: (code) => vm.runInContext(code, context) };
};

const serverSettingsResponse = (notifications = {}) => ({
  encryptionKeyConfigured: true,
  encryptionKeySource: 'file',
  apiKeyConfigured: true,
  notifications: {
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
    ...notifications,
  },
});

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

it('does not expire the administrator cookie for a generic bank 401', async () => {
  const page = makePage(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Kaspi request rejected', code: 'BANK_REQUEST_REJECTED' }),
  }));
  page.element('projectSelect').value = 'shop';

  await assert.rejects(page.run("apiFetch('/api/invoice/details?operationId=1')"), /Kaspi request rejected/);
  assert.equal(page.run('securityState.authenticated'), true);
});

it('does not apply a late Kaspi session expiry to a newly selected project', async () => {
  let finish;
  const page = makePage(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  page.element('projectSelect').value = 'shop';
  page.run(`
    adminState.projects = [
      {id:'shop',name:'Магазин',status:'active',connection:{connected:true}},
      {id:'booking',name:'Бронирование',status:'active',connection:{connected:true}}
    ];
    localStorage.setItem('kaspi_session:shop', JSON.stringify({profileId:11}));
    localStorage.setItem('kaspi_session:booking', JSON.stringify({profileId:22}));
  `);
  const pending = page.run("apiFetch('/api/session/check')");
  page.element('projectSelect').value = 'booking';
  finish({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Сессия Kaspi истекла', code: 'KASPI_SESSION_EXPIRED' }),
  });

  await assert.rejects(pending, /Проект переключён/);
  assert.equal(page.run("JSON.parse(localStorage.getItem('kaspi_session:shop')).profileId"), 11);
  assert.equal(page.run("JSON.parse(localStorage.getItem('kaspi_session:booking')).profileId"), 22);
  assert.equal(page.run('adminState.projects.every((project)=>project.connection.connected)'), true);
});

it('still clears administrator UI for explicit cookie expiry and administrator session checks', async () => {
  const page = makePage(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Сессия администратора завершена.', code: 'AUTH_SESSION_EXPIRED' }),
  }));
  page.run("adminState.projects = [{id:'shop',name:'Магазин',status:'active'}];");

  await assert.rejects(page.run("adminRequest('/api/invoice/create')"), /Сессия администратора завершена/);
  assert.equal(page.run('securityState.authenticated'), false);
  assert.equal(page.run('adminState.projects.length'), 0);

  page.run("updateSecurityState({authenticated:true,csrfToken:'test-csrf-token'});");
  await assert.rejects(page.run("adminRequest('/api/admin/session')"), /Сессия администратора завершена/);
  assert.equal(page.run('securityState.authenticated'), false);
});

it('handles a lost Kaspi session by preserving the admin cookie and opening SMS reconnection for that project', async () => {
  const page = makePage(async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      active: false,
      error: 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.',
      code: 'KASPI_SESSION_EXPIRED',
    }),
  }));
  page.element('projectSelect').value = 'shop';
  page.run(`
    adminState.projects = [
      {id:'shop',name:'Магазин',status:'active',connection:{connected:true,orgName:'Demo'}},
      {id:'booking',name:'Бронирование',status:'active',connection:{connected:true,orgName:'Other'}}
    ];
    localStorage.setItem('kaspi_session:shop', JSON.stringify({profileId:11}));
    localStorage.setItem('kaspi_session:booking', JSON.stringify({profileId:22}));
    adminState.editId = 'shop';
  `);
  page.element('projectDialog').open = true;
  page.run('invoicePollingTimer=1; qrPollingTimer=2; qrCountdownTimer=3;');

  await page.run("connectProject('shop')");

  assert.equal(page.run('securityState.authenticated'), true);
  assert.equal(page.run("localStorage.getItem('kaspi_session:shop')"), null);
  assert.equal(page.run("JSON.parse(localStorage.getItem('kaspi_session:booking')).profileId"), 22);
  assert.equal(page.run("adminState.projects.find((project)=>project.id==='shop').connection.connected"), false);
  assert.equal(page.element('projectConnectionStatus').textContent, 'Счёт Kaspi Pay ещё не подключён.');
  assert.equal(page.element('connectDialog').open, true);
  assert.equal(page.element('authMsg').textContent, 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.');
  assert.equal(page.run('[invoicePollingTimer,qrPollingTimer,qrCountdownTimer].every((timer)=>timer===null)'), true);
  assert.equal(page.element('projectSelect').value, 'shop');
});

it('does not add a blocking alert after opening SMS reconnection for a lost-session payment request', async () => {
  const page = makePage(async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      error: 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.',
      code: 'KASPI_SESSION_EXPIRED',
    }),
  }));
  page.element('projectSelect').value = 'shop';
  page.element('clientPhone').value = '7000000001';
  page.element('invoiceAmount').value = '100';
  page.element('qrAmount').value = '100';
  page.run("adminState.projects = [{id:'shop',name:'Магазин',status:'active',connection:{connected:true}}];");

  await page.run('createInvoice()');
  await page.run('createQr()');

  assert.deepEqual(page.alerts, []);
  assert.equal(page.element('connectDialog').open, true);
  assert.equal(page.element('authMsg').textContent, 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.');
});

it('marks an archived project disconnected without offering SMS reconnection', async () => {
  const page = makePage(async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      error: 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.',
      code: 'KASPI_SESSION_EXPIRED',
    }),
  }));
  page.run(`
    adminState.projects = [{id:'old-shop',name:'Старый магазин',status:'archived',connection:{connected:true}}];
    localStorage.setItem('kaspi_session:old-shop', JSON.stringify({profileId:11}));
  `);

  await page.run(
    "connectArchivedHistory({id:'old-shop',name:'Старый магазин',status:'archived',connection:{connected:true}})",
  );

  assert.equal(page.run('securityState.authenticated'), true);
  assert.equal(page.run("localStorage.getItem('kaspi_session:old-shop')"), null);
  assert.equal(page.run('adminState.projects[0].connection.connected'), false);
  assert.equal(page.element('connectDialog').open, false);
  assert.match(page.element('selectedProjectStatus').textContent, /Архивный проект нельзя переподключить по SMS/);
  assert.doesNotMatch(page.element('selectedProjectStatus').textContent, /Подключите счёт заново по SMS/);
});

it('keeps the project connected when Kaspi is unavailable and shows a retry-safe status message', async () => {
  let unavailable = true;
  const page = makePage(async () => {
    if (unavailable) {
      unavailable = false;
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: 'temporary upstream error', code: 'KASPI_UNAVAILABLE' }),
      };
    }
    return { ok: true, json: async () => ({ active: true }) };
  });
  page.element('projectSelect').value = 'shop';
  page.run(`
    adminState.projects = [{id:'shop',name:'Магазин',status:'active',connection:{connected:true,orgName:'Demo'}}];
    localStorage.setItem('kaspi_session:shop', JSON.stringify({profileId:11}));
  `);

  await assert.rejects(
    page.run("apiFetch('/api/invoice/create')"),
    /Kaspi Pay временно недоступен\. Проверьте статус операции перед повтором\./,
  );
  assert.equal(page.run('securityState.authenticated'), true);
  assert.equal(page.run('adminState.projects[0].connection.connected'), true);
  assert.equal(page.run("JSON.parse(localStorage.getItem('kaspi_session:shop')).profileId"), 11);
  assert.equal(
    page.element('selectedProjectStatus').textContent,
    'Kaspi Pay временно недоступен. Проверьте статус операции перед повтором.',
  );
  await page.run("apiFetch('/api/session/check')");
  assert.equal(page.element('selectedProjectStatus').classList.contains('hidden'), true);
});

it('does not invalidate a renewed Kaspi session when an older same-project request returns 401', async () => {
  let finishBankRequest;
  const page = makePage((path) => {
    if (path.startsWith('/api/invoice/details'))
      return new Promise((resolve) => {
        finishBankRequest = resolve;
      });
    return Promise.resolve({
      ok: true,
      json: async () => ({
        projects: [{ id: 'shop', name: 'Магазин', status: 'active', connection: { connected: true } }],
      }),
    });
  });
  page.element('projectSelect').value = 'shop';
  page.run(`
    adminState.projects = [{id:'shop',name:'Магазин',status:'active',connection:{connected:true}}];
    localStorage.setItem('kaspi_session:shop', JSON.stringify({profileId:11}));
  `);
  const pending = page.run("apiFetch('/api/invoice/details?operationId=1')");

  await page.run("connectProject('shop', {forceLogin:true,returnTo:'workspace'})");
  page.run('completeAuthFlow({profileId:22}, authFlowGeneration);');
  await new Promise((resolve) => setTimeout(resolve, 0));

  finishBankRequest({
    ok: false,
    status: 401,
    json: async () => ({
      active: false,
      error: 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.',
      code: 'KASPI_SESSION_EXPIRED',
    }),
  });
  await assert.rejects(pending, /Подключение к Kaspi Pay изменилось/);
  assert.equal(page.run('adminState.projects[0].connection.connected'), true);
  assert.equal(page.run("JSON.parse(localStorage.getItem('kaspi_session:shop')).profileId"), 22);
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

it('loads notification settings without exposing the SMTP password and displays safe server status', async () => {
  const page = makePage(async () => ({
    ok: true,
    json: async () =>
      serverSettingsResponse({
        enabled: true,
        email: 'ops@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecurity: 'tls',
        smtpUser: 'ops-user',
        smtpFrom: 'notifications@example.com',
        hasSmtpPassword: true,
        configured: true,
        lastSentAt: '2026-11-11T02:00:00.000Z',
        lastError: '<img src=x onerror=alert(1)>',
      }),
  }));

  await page.run('openServerSettings()');

  assert.equal(page.element('notificationsEnabled').checked, true);
  assert.equal(page.element('notificationEmail').value, 'ops@example.com');
  assert.equal(page.element('smtpHost').value, 'smtp.example.com');
  assert.equal(page.element('smtpPort').value, '587');
  assert.equal(page.element('smtpSecurity').value, 'tls');
  assert.equal(page.element('smtpUser').value, 'ops-user');
  assert.equal(page.element('smtpFrom').value, 'notifications@example.com');
  assert.equal(page.element('smtpPassword').value, '');
  assert.match(page.element('smtpPasswordHint').textContent, /Сохранённый пароль есть/);
  assert.equal(page.element('notificationsSetupStatus').textContent, 'Настроен');
  assert.match(page.element('notificationsLastSentAt').textContent, /2026/);
  assert.equal(page.element('notificationsLastError').textContent, 'Последняя ошибка: <img src=x onerror=alert(1)>');
  page.element('smtpHost').value = 'smtp.other.example';
  page.run('updateConnectionNotificationControls()');
  assert.match(page.element('smtpPasswordHint').textContent, /Смена SMTP-сервера/);
  assert.equal(page.element('btnTestConnectionNotification').disabled, true);
  page.element('smtpHost').value = 'smtp.example.com';
  page.run('updateConnectionNotificationControls()');
  assert.equal(page.element('btnTestConnectionNotification').disabled, false);
});

it('saves notification settings through the cookie and CSRF path without auto-sending a test email', async () => {
  const requests = [];
  const stored = {
    email: 'ops@example.com',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    smtpUser: 'ops-user',
    smtpFrom: 'notifications@example.com',
    hasSmtpPassword: true,
    configured: true,
  };
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    if (path === '/api/admin/settings') return { ok: true, json: async () => serverSettingsResponse(stored) };
    if (path === '/api/admin/settings/notifications')
      return {
        ok: true,
        json: async () =>
          serverSettingsResponse({
            ...stored,
            enabled: true,
            email: 'new@example.com',
            smtpHost: 'smtp.other.example',
            smtpUser: '',
            hasSmtpPassword: false,
          }),
      };
    assert.fail(`Unexpected request: ${path}`);
  });

  await page.run('openServerSettings()');
  page.element('smtpHost').value = 'smtp.other.example';
  page.element('notificationsEnabled').checked = true;
  page.run('updateConnectionNotificationControls()');
  await page.run('saveConnectionNotifications({preventDefault(){}})');
  assert.equal(requests.length, 1, 'enabling after changing SMTP identity requires a new password');
  assert.match(page.element('connectionNotificationsMsg').textContent, /укажите пароль/);

  page.element('smtpUser').value = '';
  page.element('notificationEmail').value = 'new@example.com';
  page.run('updateConnectionNotificationControls()');
  assert.equal(page.element('btnTestConnectionNotification').disabled, true);
  await page.run('sendTestConnectionNotification()');
  assert.equal(requests.length, 1, 'unsaved edits must not send a test email');
  assert.match(page.element('connectionNotificationsMsg').textContent, /Сначала сохраните изменения/);

  await page.run('saveConnectionNotifications({preventDefault(){}})');

  assert.equal(requests.length, 2, 'save must not trigger the test endpoint');
  assert.equal(requests[1].path, '/api/admin/settings/notifications');
  assert.equal(requests[1].options.method, 'PATCH');
  assert.equal(requests[1].options.credentials, 'same-origin');
  assert.equal(requests[1].options.headers.get('X-CSRF-Token'), 'test-csrf-token');
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.enabled, true, 'an SMTP relay without authentication can be enabled');
  assert.equal(payload.email, 'new@example.com');
  assert.equal(payload.smtpHost, 'smtp.other.example');
  assert.equal(payload.smtpPort, 587);
  assert.equal(payload.smtpUser, '', 'an empty SMTP user is sent to clear saved credentials');
  assert.equal(Object.hasOwn(payload, 'smtpPassword'), false, 'blank password keeps the server copy');
  assert.equal(page.element('smtpPassword').value, '');
  assert.equal(page.element('btnSaveConnectionNotifications').disabled, true);
});

it('keeps notification controls blocked when settings fail to load', async () => {
  const requests = [];
  const page = makePage(async (path) => {
    requests.push(path);
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: 'Настройки временно недоступны.' }),
    };
  });

  await page.run('openServerSettings()');

  assert.equal(page.element('notificationsEnabled').disabled, true);
  assert.equal(page.element('btnSaveConnectionNotifications').disabled, true);
  assert.equal(page.element('btnTestConnectionNotification').disabled, true);
  await page.run('saveConnectionNotifications({preventDefault(){}})');
  await page.run('sendTestConnectionNotification()');
  assert.deepEqual(requests, ['/api/admin/settings'], 'failed loading must not save or send using an empty form');
  assert.match(page.element('connectionNotificationsMsg').textContent, /Не удалось загрузить сохранённые настройки/);
});

it('tests saved SMTP settings even when notifications are disabled and refreshes server delivery status', async () => {
  const requests = [];
  let settingsReads = 0;
  const page = makePage(async (path, options) => {
    requests.push({ path, options });
    if (path === '/api/admin/settings') {
      settingsReads++;
      return {
        ok: true,
        json: async () =>
          serverSettingsResponse({
            enabled: false,
            email: 'ops@example.com',
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpSecurity: 'starttls',
            smtpFrom: 'notifications@example.com',
            configured: true,
            lastSentAt: settingsReads > 1 ? '2026-11-11T02:05:00.000Z' : null,
            lastError: settingsReads > 1 ? '<smtp error>' : null,
          }),
      };
    }
    if (path === '/api/admin/settings/notifications/test')
      return {
        ok: true,
        json: async () => ({ success: true, message: 'Тестовое письмо принято почтовым сервером.' }),
      };
    assert.fail(`Unexpected request: ${path}`);
  });

  await page.run('openServerSettings()');
  assert.equal(page.element('notificationsEnabled').checked, false);
  assert.equal(page.element('btnTestConnectionNotification').disabled, false);
  await page.run('sendTestConnectionNotification()');

  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/api/admin/settings', '/api/admin/settings/notifications/test', '/api/admin/settings'],
  );
  const testRequest = requests[1];
  assert.equal(testRequest.options.method, 'POST');
  assert.equal(testRequest.options.credentials, 'same-origin');
  assert.equal(testRequest.options.headers.get('X-CSRF-Token'), 'test-csrf-token');
  assert.deepEqual(JSON.parse(testRequest.options.body), {});
  assert.equal(page.element('connectionNotificationsMsg').textContent, 'Тестовое письмо принято почтовым сервером.');
  assert.match(page.element('notificationsLastSentAt').textContent, /2026/);
  assert.equal(page.element('notificationsLastError').textContent, 'Последняя ошибка: <smtp error>');
  assert.equal(page.element('btnTestConnectionNotification').disabled, true, 'successful test starts cooldown');
  await page.run('sendTestConnectionNotification()');
  assert.equal(
    requests.filter(({ path }) => path === '/api/admin/settings/notifications/test').length,
    1,
    'a second test request during cooldown is blocked in the handler',
  );
  assert.match(page.element('connectionNotificationsMsg').textContent, /доступно через/);
});

it('ignores stale notification settings responses after closing and reopening server settings', async () => {
  const pendingReads = [];
  const page = makePage(
    () =>
      new Promise((resolve) => {
        pendingReads.push(resolve);
      }),
  );

  const firstOpen = page.run('openServerSettings()');
  page.element('smtpPassword').value = 'discard-on-close';
  page.run('closeServerSettings()');
  assert.equal(page.element('smtpPassword').value, '');

  const secondOpen = page.run('openServerSettings()');
  pendingReads[0]({
    ok: true,
    json: async () => serverSettingsResponse({ email: 'old@example.com' }),
  });
  await firstOpen;
  assert.equal(page.element('notificationEmail').value, '', 'the closed view response must be ignored');

  pendingReads[1]({
    ok: true,
    json: async () => serverSettingsResponse({ email: 'current@example.com' }),
  });
  await secondOpen;
  assert.equal(page.element('notificationEmail').value, 'current@example.com');

  page.element('smtpPassword').value = 'clear-on-logout';
  page.run("clearAdminSessionUI('Сессия завершена');");
  assert.equal(page.element('smtpPassword').value, '');
});

it('does not let a late notification save overwrite a reopened settings view or clear its new password', async () => {
  let finishSave;
  let settingsRead = 0;
  const page = makePage((path) => {
    if (path === '/api/admin/settings') {
      settingsRead++;
      const email = settingsRead === 1 ? 'initial@example.com' : 'reopened@example.com';
      return Promise.resolve({
        ok: true,
        json: async () => serverSettingsResponse({ email }),
      });
    }
    if (path === '/api/admin/settings/notifications')
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    assert.fail(`Unexpected request: ${path}`);
  });

  await page.run('openServerSettings()');
  page.element('notificationEmail').value = 'pending-save@example.com';
  page.element('smtpPassword').value = 'old-view-password';
  const pendingSave = page.run('saveConnectionNotifications({preventDefault(){}})');
  page.run('closeServerSettings()');
  assert.equal(page.element('smtpPassword').value, '');
  await page.run('openServerSettings()');
  page.element('smtpPassword').value = 'new-view-password';

  finishSave({
    ok: true,
    json: async () =>
      serverSettingsResponse({ email: 'pending-save@example.com', hasSmtpPassword: true, configured: true }),
  });
  await pendingSave;

  assert.equal(page.element('notificationEmail').value, 'reopened@example.com');
  assert.equal(page.element('smtpPassword').value, 'new-view-password');
  assert.equal(page.element('serverSettingsDialog').open, true);
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
