import crypto from 'node:crypto';
import path from 'node:path';
import './projectStore.js';
import { db, transaction } from './database.js';
import { DATA_DIR } from './paths.js';
import { readJson } from './storage.js';
import { encryptSecret, decryptSecret } from './crypto.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    project_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('qr', 'invoice')),
    payment_id TEXT NOT NULL,
    status TEXT NOT NULL,
    event TEXT,
    result_group TEXT GENERATED ALWAYS AS (
      CASE WHEN event IS NULL THEN 'pending'
        WHEN event = 'payment.success' THEN 'paid'
        WHEN event = 'payment.failed' THEN 'failed'
        WHEN event = 'payment.expired' THEN 'expired' ELSE 'review' END
    ) STORED,
    amount_json TEXT,
    order_id TEXT,
    created_at INTEGER NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT NOT NULL,
    session_encrypted TEXT,
    PRIMARY KEY(project_id, type, payment_id)
  );
  CREATE INDEX IF NOT EXISTS payments_project_date_idx ON payments(project_id, created_at DESC, type, payment_id DESC);
  CREATE INDEX IF NOT EXISTS payments_project_result_date_idx ON payments(project_id, result_group, created_at DESC, type, payment_id DESC);
  CREATE INDEX IF NOT EXISTS payments_project_id_search_idx ON payments(project_id, payment_id COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS payments_project_order_search_idx ON payments(project_id, order_id COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments(event) WHERE event IS NULL;
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    hook_id TEXT,
    url TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    execute_after INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deliveries_due_idx ON webhook_deliveries(execute_after);
`);

const insertPayment = db.prepare(`INSERT INTO payments
  (project_id,type,payment_id,status,event,amount_json,order_id,created_at,retry_count,meta_json,session_encrypted)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insertDelivery = db.prepare(`INSERT INTO webhook_deliveries
  (id,project_id,hook_id,url,payload_json,attempt,execute_after) VALUES (?,?,?,?,?,?,?)`);
const paymentArgs = (entry) => [
  entry.projectId,
  entry.type,
  String(entry.paymentId),
  entry.status,
  entry.event || null,
  entry.meta.amount == null ? null : JSON.stringify(entry.meta.amount),
  entry.meta.orderId == null ? null : String(entry.meta.orderId),
  entry.createdAt,
  entry.retryCount || 0,
  JSON.stringify(entry.meta),
  !entry.event && entry.sessionHeaders ? encryptSecret(Buffer.from(JSON.stringify(entry.sessionHeaders))) : null,
];
const deliveryArgs = (entry) => [
  entry.id,
  entry.projectId,
  entry.hookId || null,
  entry.url,
  JSON.stringify(entry.payload),
  entry.attempt,
  entry.executeAfter,
];

// Validate before marking migration complete. A bad file must never silently become an empty ledger.
const migrationError = () => {
  throw new Error('Некорректный журнал платежей JSON: миграция SQLite отменена');
};
const validatePayment = (entry) => {
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.projectId !== 'string' ||
    !entry.projectId ||
    !['qr', 'invoice'].includes(entry.type) ||
    !/^\d+$/.test(String(entry.paymentId)) ||
    typeof entry.status !== 'string' ||
    !entry.status ||
    !Number.isSafeInteger(entry.createdAt) ||
    !entry.meta ||
    typeof entry.meta !== 'object' ||
    Array.isArray(entry.meta) ||
    (entry.event != null && typeof entry.event !== 'string') ||
    (entry.retryCount != null && (!Number.isSafeInteger(entry.retryCount) || entry.retryCount < 0))
  )
    migrationError();
  if (
    !entry.event &&
    (!entry.sessionHeaders ||
      typeof entry.sessionHeaders !== 'object' ||
      (entry.sessionHeaders.projectId || '__admin__') !== entry.projectId)
  )
    migrationError();
};
const validateDelivery = (entry) => {
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    !entry.id ||
    typeof entry.projectId !== 'string' ||
    !entry.projectId ||
    typeof entry.url !== 'string' ||
    !entry.payload ||
    typeof entry.payload !== 'object' ||
    entry.payload.projectId !== entry.projectId ||
    typeof entry.payload.event !== 'string' ||
    !Number.isSafeInteger(entry.attempt) ||
    entry.attempt < 1 ||
    !Number.isSafeInteger(entry.executeAfter)
  )
    migrationError();
};
const MIGRATION_KEY = 'legacy_payments_v1';
if (!db.prepare('SELECT 1 FROM store_meta WHERE key = ?').get(MIGRATION_KEY)) {
  const state = readJson(path.join(DATA_DIR, 'payments-state.json'), undefined);
  let entries;
  let deliveries;
  if (state !== undefined) {
    if (!state || !Array.isArray(state.payments) || !Array.isArray(state.deliveries)) migrationError();
    entries = state.payments.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) migrationError();
      const entry = pair[1];
      validatePayment(entry);
      if (pair[0] !== JSON.stringify([entry.projectId, entry.type, String(entry.paymentId)])) migrationError();
      return entry;
    });
    deliveries = state.deliveries;
  } else {
    const legacy = readJson(path.join(DATA_DIR, 'tracked-payments.json'), {});
    const retries = readJson(path.join(DATA_DIR, 'webhook-retries.json'), []);
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || !Array.isArray(retries)) migrationError();
    entries = Object.values(legacy).map((entry) => ({
      ...entry,
      projectId: '__admin__',
      sessionHeaders: entry.sessionHeaders ? { ...entry.sessionHeaders, projectId: '__admin__' } : undefined,
    }));
    deliveries = retries.map((entry) => ({
      id: crypto.randomUUID(),
      projectId: '__admin__',
      url: entry.hook?.url,
      payload: { ...entry.payload, projectId: '__admin__' },
      attempt: entry.attempt,
      executeAfter: entry.executeAfter,
    }));
  }
  transaction(() => {
    // A second process must not import the same files twice.
    if (db.prepare('SELECT 1 FROM store_meta WHERE key = ?').get(MIGRATION_KEY)) return;
    for (const entry of entries) {
      validatePayment(entry);
      insertPayment.run(...paymentArgs(entry));
    }
    for (const delivery of deliveries) {
      validateDelivery(delivery);
      insertDelivery.run(...deliveryArgs(delivery));
    }
    db.prepare('INSERT INTO store_meta(key,value) VALUES (?,?)').run(MIGRATION_KEY, new Date().toISOString());
  });
}

const toEntry = (row) => ({
  cursor: row.rowid,
  projectId: row.project_id,
  type: row.type,
  paymentId: row.payment_id,
  status: row.status,
  event: row.event,
  meta: JSON.parse(row.meta_json),
  createdAt: row.created_at,
  retryCount: row.retry_count,
  sessionEncrypted: row.session_encrypted,
});
export const paymentSession = (entry) => JSON.parse(decryptSecret(entry.sessionEncrypted).toString('utf8'));
export const storePayment = (entry) => {
  if (!ownsStoredPayment(entry.projectId, entry.type, entry.paymentId)) insertPayment.run(...paymentArgs(entry));
};
export const ownsStoredPayment = (projectId, type, paymentId) =>
  Boolean(
    db
      .prepare('SELECT 1 FROM payments WHERE project_id = ? AND type = ? AND payment_id = ?')
      .get(projectId, type, String(paymentId)),
  );
export const pendingUpperBound = () => db.prepare('SELECT coalesce(max(rowid),0) AS n FROM payments').get().n;
export const pendingBatch = (after, upper) =>
  db
    .prepare('SELECT rowid,* FROM payments WHERE event IS NULL AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 100')
    .all(after, upper)
    .map(toEntry);
export const pendingEntries = () =>
  db
    .prepare('SELECT rowid,* FROM payments WHERE event IS NULL')
    .all()
    .map(toEntry)
    .map((entry) => ({ ...entry, sessionHeaders: paymentSession(entry) }));
export function* pendingPayments() {
  const upper = pendingUpperBound();
  let after = 0;
  while (true) {
    const entries = pendingBatch(after, upper);
    if (!entries.length) return;
    for (const entry of entries) {
      after = entry.cursor;
      yield entry;
    }
  }
}
export const updatePendingPayment = (entry) =>
  db
    .prepare(
      `UPDATE payments SET status=?,retry_count=?
  WHERE project_id=? AND type=? AND payment_id=? AND event IS NULL`,
    )
    .run(entry.status, entry.retryCount, entry.projectId, entry.type, entry.paymentId);
export const finishStoredPayment = (entry, event, status, deliveries) =>
  transaction(() => {
    const changed = db
      .prepare(
        `UPDATE payments SET status=?,event=?,session_encrypted=NULL
    WHERE project_id=? AND type=? AND payment_id=? AND event IS NULL`,
      )
      .run(status, event, entry.projectId, entry.type, entry.paymentId);
    if (!changed.changes) return;
    for (const delivery of deliveries) insertDelivery.run(...deliveryArgs(delivery));
  });
export const deliveriesUpperBound = () =>
  db.prepare('SELECT coalesce(max(rowid),0) AS n FROM webhook_deliveries').get().n;
export const dueDeliveryBatch = (after, upper, now) =>
  db
    .prepare(
      `SELECT rowid,* FROM webhook_deliveries
  WHERE execute_after <= ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 100`,
    )
    .all(now, after, upper)
    .map((row) => ({
      cursor: row.rowid,
      id: row.id,
      projectId: row.project_id,
      hookId: row.hook_id,
      url: row.url,
      payload: JSON.parse(row.payload_json),
      attempt: row.attempt,
      executeAfter: row.execute_after,
    }));
export const removeDelivery = (id) => db.prepare('DELETE FROM webhook_deliveries WHERE id=?').run(id);
export function* dueDeliveries(now) {
  const upper = deliveriesUpperBound();
  let after = 0;
  while (true) {
    const entries = dueDeliveryBatch(after, upper, now);
    if (!entries.length) return;
    for (const entry of entries) {
      after = entry.cursor;
      yield entry;
    }
  }
}
export const retryDelivery = (delivery) =>
  db
    .prepare('UPDATE webhook_deliveries SET attempt=?,execute_after=? WHERE id=?')
    .run(delivery.attempt, delivery.executeAfter, delivery.id);

const invalidQuery = (message) => {
  const error = new Error(message);
  error.status = 400;
  throw error;
};
const positiveInteger = (value, fallback, max) => {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    invalidQuery('Некорректная страница или размер страницы');
  return Number(value);
};
export const listPayments = (projectId, query = {}) => {
  const page = positiveInteger(query.page, 1, 100000000);
  const pageSize = positiveInteger(query.pageSize, 50, 100);
  const status = query.status === undefined ? 'all' : query.status;
  if (!['all', 'pending', 'paid', 'failed', 'expired', 'review'].includes(status))
    invalidQuery('Некорректный фильтр статуса');
  const search = query.search === undefined ? '' : query.search;
  if (typeof search !== 'string' || search.length > 120) invalidQuery('Поиск должен содержать не более 120 символов');
  const terms = ['project_id = ?'];
  const args = [projectId];
  if (status !== 'all') {
    terms.push('result_group = ?');
    args.push(status);
  }
  if (search.trim()) {
    terms.push("(payment_id LIKE ? ESCAPE '\\' OR order_id LIKE ? ESCAPE '\\')");
    const pattern = search.trim().replace(/[\\%_]/g, '\\$&') + '%';
    args.push(pattern, pattern);
  }
  const where = terms.join(' AND ');
  return transaction(
    () => {
      const total = db.prepare(`SELECT count(*) AS n FROM payments WHERE ${where}`).get(...args).n;
      const summary = { total: 0, pending: 0, paid: 0, failed: 0, expired: 0, review: 0 };
      for (const row of db
        .prepare('SELECT result_group,count(*) AS n FROM payments WHERE project_id=? GROUP BY result_group')
        .all(projectId)) {
        summary[row.result_group] = row.n;
        summary.total += row.n;
      }
      const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
      const rows = db
        .prepare(
          `SELECT payment_id,type,status,event,result_group,amount_json,order_id,created_at FROM payments
      WHERE ${where} ORDER BY created_at DESC,type,payment_id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, pageSize, (currentPage - 1) * pageSize);
      return {
        payments: rows.map((row) => ({
          paymentId: row.payment_id,
          type: row.type,
          status: row.status,
          event: row.event,
          result: row.result_group,
          amount: row.amount_json === null ? null : JSON.parse(row.amount_json),
          orderId: row.order_id,
          createdAt: row.created_at,
        })),
        total,
        page: currentPage,
        pageSize,
        summary,
      };
    },
    { readOnly: true },
  );
};
