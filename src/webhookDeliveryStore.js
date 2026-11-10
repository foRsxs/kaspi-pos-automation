import { db, transaction } from './database.js';
import { projectWebhooks } from './projectStore.js';
import { getWebhooksByEvent } from './webhookStore.js';

const STATES = ['queued', 'retrying', 'sending', 'delivered', 'failed', 'cancelled'];
const TERMINAL = new Set(['delivered', 'failed', 'cancelled']);
const error = (status, message) => Object.assign(new Error(message), { status });

// One durable record is both the outbox task and the delivery journal entry.
transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, hook_id TEXT, url TEXT NOT NULL,
    payload_json TEXT NOT NULL, attempt INTEGER NOT NULL, execute_after INTEGER NOT NULL
  )`);
  if (!db.prepare('SELECT 1 FROM store_meta WHERE key=?').get('webhook_journal_v1')) {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(webhook_deliveries)')
        .all()
        .map((column) => column.name),
    );
    for (const [name, definition] of Object.entries({
      status: "TEXT NOT NULL DEFAULT 'queued'",
      attempt_count: 'INTEGER NOT NULL DEFAULT 0',
      created_at: 'INTEGER NOT NULL DEFAULT 0',
      updated_at: 'INTEGER NOT NULL DEFAULT 0',
      last_http_status: 'INTEGER',
      last_error: 'TEXT',
      delivered_at: 'INTEGER',
    })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN ${name} ${definition}`);
    }
    const now = Date.now();
    db.prepare(
      `UPDATE webhook_deliveries SET attempt_count=max(0,attempt-1),
      status=CASE WHEN attempt>1 THEN 'retrying' ELSE 'queued' END,
      created_at=coalesce(CAST(strftime('%s',json_extract(payload_json,'$.timestamp')) AS INTEGER)*1000,?),
      updated_at=?`,
    ).run(now, now);
    db.prepare('INSERT INTO store_meta(key,value) VALUES (?,?)').run('webhook_journal_v1', String(now));
  }
  db.exec(`CREATE INDEX IF NOT EXISTS deliveries_due_state_idx ON webhook_deliveries(status,execute_after)
      WHERE status IN ('queued','retrying');
    CREATE INDEX IF NOT EXISTS deliveries_project_date_idx ON webhook_deliveries(project_id,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS deliveries_project_state_idx ON webhook_deliveries(project_id,status,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS deliveries_payment_search_idx ON webhook_deliveries(
      project_id,CAST(json_extract(payload_json,'$.paymentId') AS TEXT) COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS deliveries_order_search_idx ON webhook_deliveries(
      project_id,CAST(json_extract(payload_json,'$.orderId') AS TEXT) COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id), number INTEGER NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, http_status INTEGER, error TEXT,
      duration_ms INTEGER, outcome TEXT NOT NULL, PRIMARY KEY(delivery_id,number)
    )`);
  // An interrupted HTTP request may already have reached the receiver. Retry the
  // same event ID; receivers must deduplicate it, just like any timed-out POST.
  const now = Date.now();
  const interrupted = 'Отправка прервана перезапуском сервера; результат доставки неизвестен.';
  db.prepare(
    `UPDATE webhook_delivery_attempts SET finished_at=?,error=?,outcome='interrupted'
    WHERE finished_at IS NULL`,
  ).run(now, interrupted);
  db.prepare(
    `UPDATE webhook_deliveries SET status=CASE WHEN attempt>=3 THEN 'failed' ELSE 'retrying' END,
    attempt=CASE WHEN attempt>=3 THEN attempt ELSE attempt+1 END,execute_after=?,updated_at=?,last_error=?
    WHERE status='sending'`,
  ).run(now, now, interrupted);
});

export const insertDelivery = (entry) => {
  const timestamp = Date.parse(entry.payload.timestamp);
  const createdAt = Number.isFinite(timestamp) ? timestamp : Date.now();
  return db
    .prepare(
      `INSERT INTO webhook_deliveries
    (id,project_id,hook_id,url,payload_json,attempt,execute_after,status,attempt_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      entry.id,
      entry.projectId,
      entry.hookId || null,
      entry.url,
      JSON.stringify(entry.payload),
      entry.attempt,
      entry.executeAfter,
      entry.attempt > 1 ? 'retrying' : 'queued',
      Math.max(0, entry.attempt - 1),
      createdAt,
      Date.now(),
    );
};

const queuedEntry = (row) => ({
  id: row.id,
  projectId: row.project_id,
  hookId: row.hook_id,
  url: row.url,
  payload: JSON.parse(row.payload_json),
  attempt: row.attempt,
});
export const webhooksForEvent = (projectId, event) =>
  projectId === '__admin__' ? getWebhooksByEvent(event) : projectWebhooks(projectId, event);
export const matchingDeliveryHook = (delivery) => {
  const hooks = webhooksForEvent(delivery.projectId, delivery.payload.event);
  return hooks.find((hook) => hook.url === delivery.url && (!delivery.hookId || hook.id === delivery.hookId));
};

export function* dueDeliveries(now) {
  const upper = db.prepare('SELECT coalesce(max(rowid),0) AS n FROM webhook_deliveries').get().n;
  let after = 0;
  while (true) {
    const rows = db
      .prepare(
        `SELECT rowid,* FROM webhook_deliveries
      WHERE status IN ('queued','retrying') AND execute_after<=? AND rowid>? AND rowid<=?
      ORDER BY rowid LIMIT 100`,
      )
      .all(now, after, upper);
    if (!rows.length) return;
    for (const row of rows) {
      after = row.rowid;
      yield queuedEntry(row);
    }
  }
}

export const claimDelivery = (id) =>
  transaction(() => {
    const now = Date.now();
    const row = db
      .prepare(
        `UPDATE webhook_deliveries SET status='sending',attempt_count=attempt_count+1,updated_at=?
    WHERE id=? AND status IN ('queued','retrying') AND execute_after<=? RETURNING *`,
      )
      .get(now, id, now);
    if (!row) return null;
    db.prepare(
      `INSERT INTO webhook_delivery_attempts(delivery_id,number,started_at,outcome)
    VALUES (?,?,?,'sending')`,
    ).run(id, row.attempt_count, now);
    return { ...queuedEntry(row), number: row.attempt_count };
  });

export const cancelDelivery = (id) =>
  db
    .prepare(
      `UPDATE webhook_deliveries
  SET status='cancelled',last_error=?,updated_at=? WHERE id=? AND status IN ('queued','retrying')`,
    )
    .run('Получатель удалён, его URL изменён или подписка на событие отключена.', Date.now(), id);

export const completeDeliveryAttempt = (id, number, { httpStatus = null, error: failure = null, durationMs }) =>
  transaction(() => {
    const row = db
      .prepare("SELECT * FROM webhook_deliveries WHERE id=? AND status='sending' AND attempt_count=?")
      .get(id, number);
    if (!row) return;
    const now = Date.now();
    const delivered = httpStatus >= 200 && httpStatus < 300 && !failure;
    const status = delivered ? 'delivered' : row.attempt >= 3 ? 'failed' : 'retrying';
    const message = delivered ? null : String(failure || 'Неизвестная ошибка доставки').slice(0, 1000);
    const executeAfter = now + (row.attempt === 1 ? 5000 : 30000);
    db.prepare(
      `UPDATE webhook_delivery_attempts SET finished_at=?,http_status=?,error=?,duration_ms=?,outcome=?
      WHERE delivery_id=? AND number=?`,
    ).run(now, httpStatus, message, durationMs, delivered ? 'delivered' : 'failed', id, number);
    db.prepare(
      `UPDATE webhook_deliveries SET status=?,attempt=?,execute_after=?,updated_at=?,
      last_http_status=?,last_error=?,delivered_at=? WHERE id=?`,
    ).run(
      status,
      status === 'retrying' ? row.attempt + 1 : row.attempt,
      executeAfter,
      now,
      httpStatus,
      message,
      delivered ? now : null,
      id,
    );
  });

const toDelivery = (row) => {
  const payload = JSON.parse(row.payload_json);
  const available = Boolean(matchingDeliveryHook(queuedEntry(row)));
  const terminal = TERMINAL.has(row.status);
  return {
    id: row.id,
    projectId: row.project_id,
    paymentId: payload.paymentId ?? null,
    type: payload.type ?? null,
    orderId: payload.orderId ?? null,
    event: payload.event,
    url: row.url,
    status: row.status,
    attempts: row.attempt_count,
    httpStatus: row.last_http_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: ['queued', 'retrying'].includes(row.status) ? row.execute_after : null,
    deliveredAt: row.delivered_at,
    canRetry: terminal && available,
    retryDisabledReason: !available
      ? 'Получатель или подписка больше не настроены. Восстановите прежний URL и подписку.'
      : !terminal
        ? 'Доставка уже выполняется или ожидает отправки.'
        : null,
  };
};

const positiveInteger = (value, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > maximum
  )
    throw error(400, 'Некорректная страница или размер страницы');
  return Number(value);
};
export const listWebhookDeliveries = (projectId, query = {}) => {
  const page = positiveInteger(query.page, 1, 100000000);
  const pageSize = positiveInteger(query.pageSize, 50, 100);
  const status = query.status ?? 'all';
  if (typeof status !== 'string' || (status !== 'all' && !STATES.includes(status)))
    throw error(400, 'Некорректный статус доставки');
  const search = query.search ?? '';
  if (typeof search !== 'string' || search.length > 120) throw error(400, 'Некорректная строка поиска');
  const terms = ['project_id=?'];
  const args = [projectId];
  if (status !== 'all') {
    terms.push('status=?');
    args.push(status);
  }
  if (search.trim()) {
    terms.push(
      "(CAST(json_extract(payload_json,'$.paymentId') AS TEXT) LIKE ? ESCAPE '\\' OR CAST(json_extract(payload_json,'$.orderId') AS TEXT) LIKE ? ESCAPE '\\')",
    );
    const prefix = search.trim().replace(/[\\%_]/g, '\\$&') + '%';
    args.push(prefix, prefix);
  }
  return transaction(
    () => {
      const where = terms.join(' AND ');
      const total = db.prepare(`SELECT count(*) AS n FROM webhook_deliveries WHERE ${where}`).get(...args).n;
      const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
      const rows = db
        .prepare(
          `SELECT * FROM webhook_deliveries WHERE ${where}
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, pageSize, (currentPage - 1) * pageSize);
      const summary = Object.fromEntries(['total', ...STATES].map((state) => [state, 0]));
      for (const row of db
        .prepare('SELECT status,count(*) AS n FROM webhook_deliveries WHERE project_id=? GROUP BY status')
        .all(projectId)) {
        summary[row.status] = row.n;
        summary.total += row.n;
      }
      return { deliveries: rows.map(toDelivery), total, page: currentPage, pageSize, summary };
    },
    { readOnly: true },
  );
};

export const getWebhookDelivery = (projectId, id) => {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE project_id=? AND id=?').get(projectId, id);
  if (!row) throw error(404, 'Доставка не найдена');
  return {
    delivery: toDelivery(row),
    attempts: db
      .prepare(
        `SELECT number,started_at AS startedAt,finished_at AS finishedAt,
      http_status AS httpStatus,error,duration_ms AS durationMs,outcome
      FROM webhook_delivery_attempts WHERE delivery_id=? ORDER BY number`,
      )
      .all(id),
  };
};

export const retryWebhookDelivery = (projectId, id) =>
  transaction(() => {
    const row = db.prepare('SELECT * FROM webhook_deliveries WHERE project_id=? AND id=?').get(projectId, id);
    if (!row) throw error(404, 'Доставка не найдена');
    if (!TERMINAL.has(row.status)) throw error(409, 'Доставка уже выполняется или ожидает отправки.');
    if (!matchingDeliveryHook(queuedEntry(row)))
      throw error(409, 'Получатель или подписка больше не настроены. Восстановите прежний URL и подписку.');
    const now = Date.now();
    db.prepare(
      `UPDATE webhook_deliveries SET status='queued',attempt=1,execute_after=?,updated_at=?,
    delivered_at=NULL WHERE id=?`,
    ).run(now, now, id);
    return { delivery: toDelivery(db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(id)) };
  });
