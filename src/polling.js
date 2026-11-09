import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { KASPI_QRPAY_URL } from './config.js';
import { signedQrPayHeaders } from './helpers.js';
import { decryptSecret } from './crypto.js';
import { getWebhooksByEvent } from './webhookStore.js';
import { projectWebhooks } from './projects.js';
import { logger } from './logger.js';
import { markMerchantSessionInactive } from './merchantSession.js';

import {
  storePayment,
  ownsStoredPayment,
  pendingPayments,
  pendingEntries,
  updatePendingPayment,
  finishStoredPayment,
  dueDeliveries,
  removeDelivery,
  retryDelivery,
  paymentSession,
} from './paymentStore.js';
export { listPayments } from './paymentStore.js';

const keyFor = (projectId, type, paymentId) => JSON.stringify([projectId, type, String(paymentId)]);
const hooksFor = (projectId, event) =>
  projectId === '__admin__' ? getWebhooksByEvent(event) : projectWebhooks(projectId, event);
// Only initial writes that failed are retained temporarily, so an existing bank
// operation can be recovered when storage becomes writable. History lives in SQLite.
const failedPersistence = new Map();
const retryPersistence = () => {
  for (const [key, entry] of failedPersistence) {
    storePayment(entry);
    failedPersistence.delete(key);
  }
};
export const trackPayment = (paymentId, type, sessionHeaders, meta = {}, projectId = '__admin__') => {
  const entry = {
    paymentId: String(paymentId),
    projectId,
    type,
    status: type === 'qr' ? 'QrTokenCreated' : 'RemotePaymentCreated',
    sessionHeaders: { ...sessionHeaders, projectId },
    meta,
    createdAt: Date.now(),
    retryCount: 0,
  };
  const key = keyFor(projectId, type, paymentId);
  try {
    storePayment(entry);
    failedPersistence.delete(key);
    return true;
  } catch (err) {
    failedPersistence.set(key, entry);
    logger.error('POLLING', `Payment ${paymentId} exists at Kaspi but persistence failed`, err.message);
    return false;
  }
};
export const ownsPayment = (projectId, type, paymentId) =>
  failedPersistence.has(keyFor(projectId, type, paymentId)) || ownsStoredPayment(projectId, type, paymentId);

export const requirePayment =
  (type, field, source = 'query') =>
  (req, res, next) => {
    const paymentId = req[source]?.[field];
    if (typeof paymentId !== 'string' && typeof paymentId !== 'number') {
      return res.status(400).json({ error: `${field} required` });
    }
    if (!/^[0-9]+$/.test(String(paymentId)) || !Number.isSafeInteger(Number(paymentId)) || Number(paymentId) <= 0)
      return res.status(400).json({ error: `${field} must be a positive safe-integer operation ID` });
    const types = type ? [type] : ['qr', 'invoice'];
    if (!req.project.isAdmin && !types.some((value) => ownsPayment(req.project.id, value, paymentId))) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    next();
  };

const QR_FINAL_STATUSES = {
  Processed: 'payment.success',
  QrTokenDiscarded: 'payment.expired',
  Expired: 'payment.expired',
  CancelledByUser: 'payment.failed',
  NotConfirmedByUser: 'payment.failed',
  CancelledByExternalSource: 'payment.failed',
  ProcessingFailed: 'payment.failed',
  Rejected: 'payment.failed',
  InsufficientFunds: 'payment.failed',
  InsufficientFundsError: 'payment.failed',
  Error: 'payment.failed',
  IrisSrcBlockCode1: 'payment.failed',
  IrisSrcBlockCode3: 'payment.failed',
  IrisSrcBlockCode9: 'payment.failed',
  IrisDestBlockCode3: 'payment.failed',
  IrisDestBlockCode5: 'payment.failed',
  IrisDestBlockCode7: 'payment.failed',
  IrisDestBlockCode10: 'payment.failed',
};
const INVOICE_FINAL_STATUSES = {
  Processed: 'payment.success',
  RemotePaymentCanceled: 'payment.failed',
  RemotePaymentRejected: 'payment.failed',
  Expired: 'payment.expired',
};

const fetchWithTimeout = async (url, options, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, timeout: timeoutMs, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
};

const fetchStatus = async (entry) => {
  const { paymentId, type } = entry;
  const sessionHeaders = paymentSession(entry);
  entry.sessionHeaders = sessionHeaders;
  if (entry.projectId !== (sessionHeaders.projectId || '__admin__')) {
    throw new Error('Payment session belongs to a different project');
  }
  const session = { ...sessionHeaders, decryptedSecret: decryptSecret(sessionHeaders.vtokenSecret) };
  const endpoint =
    type === 'qr'
      ? `kaspi-qr/status?qrOperationId=${encodeURIComponent(paymentId)}`
      : `remote/details?operationId=${encodeURIComponent(paymentId)}`;
  const url = `${KASPI_QRPAY_URL}/v02/${endpoint}`;
  const response = await fetchWithTimeout(url, { headers: signedQrPayHeaders(url, session) }, 15000);
  if (!response.ok) throw new Error(`Kaspi HTTP ${response.status}`);
  return response.json();
};

const buildPayload = (event, entry, data) => ({
  event,
  projectId: entry.projectId,
  paymentId: entry.paymentId,
  type: entry.type,
  status: data.Status || entry.status,
  statusDesc: data.StatusDesc || '',
  amount: entry.meta.amount ?? data.Amount ?? null,
  orderId: entry.meta.orderId || null,
  qrToken: entry.meta.qrToken || null,
  receiptUrl: entry.meta.receiptUrl || data.ReceiptUrl || null,
  orderNumber: entry.meta.orderNumber || data.OrderNumber || null,
  data,
  timestamp: new Date().toISOString(),
});

const finishPayment = (entry, event, data) => {
  const payload = buildPayload(event, entry, data);
  const deliveries = hooksFor(entry.projectId, event).map((hook) => ({
    id: crypto.randomUUID(),
    projectId: entry.projectId,
    hookId: hook.id || null,
    url: hook.url,
    payload,
    attempt: 1,
    executeAfter: Date.now(),
  }));
  // Commit final status, credential removal and the outbox before any HTTP request.
  finishStoredPayment(entry, event, data.Status || entry.status, deliveries);
};

const processRetries = async () => {
  for (const delivery of dueDeliveries(Date.now())) {
    const hook = hooksFor(delivery.projectId, delivery.payload.event).find(
      (candidate) => candidate.url === delivery.url && (!delivery.hookId || candidate.id === delivery.hookId),
    );
    let done = !hook;
    if (hook) {
      const body = JSON.stringify(delivery.payload);
      const signature =
        'sha256=' +
        crypto
          .createHmac('sha256', hook.secret || '')
          .update(body)
          .digest('hex');
      try {
        const response = await fetchWithTimeout(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-ID': delivery.id,
          },
          body,
        });
        // fetch resolves for HTTP 4xx/5xx: those responses still need a retry.
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        done = true;
      } catch (err) {
        logger.error('WEBHOOK', `Delivery ${delivery.id}, attempt ${delivery.attempt}: ${err.message}`);
        done = delivery.attempt >= 3;
        delivery.executeAfter = Date.now() + (delivery.attempt === 1 ? 5000 : 30000);
        delivery.attempt++;
      }
    }
    if (done) removeDelivery(delivery.id);
    else retryDelivery(delivery);
  }
};

// Exported for deterministic integration checks; the timer never overlaps cycles.
export const pollOnce = async () => {
  retryPersistence();
  for (const entry of pendingPayments()) {
    let result;
    try {
      result = await fetchStatus(entry);
    } catch (err) {
      logger.warn('POLLING', `Payment ${entry.paymentId}: ${err.message}`);
    }
    if (result?.StatusCode === -101001) {
      markMerchantSessionInactive(entry.projectId, entry.sessionHeaders.tokenSN);
      finishPayment(entry, 'payment.lost', { Status: 'SessionExpired', StatusDesc: 'Статус платежа неизвестен' });
      continue;
    }
    if (!result?.Data?.Status) {
      entry.retryCount++;
      if (entry.retryCount > 10) {
        finishPayment(entry, 'payment.lost', {
          Status: 'PollingFailed',
          StatusDesc: 'Не удалось проверить статус платежа',
        });
      } else updatePendingPayment(entry);
      continue;
    }
    entry.retryCount = 0;
    entry.status = result.Data.Status;
    const event = (entry.type === 'qr' ? QR_FINAL_STATUSES : INVOICE_FINAL_STATUSES)[entry.status];
    if (event) finishPayment(entry, event, result.Data);
    else if (
      ['QrTokenCreated', 'Wait', 'RemotePaymentCreated'].includes(entry.status) &&
      entry.meta.expireDate &&
      Date.now() > new Date(entry.meta.expireDate).getTime()
    ) {
      finishPayment(entry, 'payment.expired', { Status: 'Expired', StatusDesc: 'Время оплаты истекло' });
    } else updatePendingPayment(entry);
    // Unknown statuses stay pending: do not turn an undocumented bank status into a failed payment.
  }
  await processRetries();
};

let pollActive = false;
let pollTimer = null;
let currentPoll = null;
const scheduleNext = () => {
  if (!pollActive) return;
  pollTimer = setTimeout(async () => {
    currentPoll = pollOnce();
    try {
      await currentPoll;
    } catch (err) {
      logger.error('POLLING', 'Unexpected error', err.message);
    } finally {
      currentPoll = null;
      scheduleNext();
    }
  }, 3000);
};

export const startPolling = () => {
  if (pollActive) return;
  pollActive = true;
  scheduleNext();
};

export const stopPolling = async () => {
  pollActive = false;
  clearTimeout(pollTimer);
  await currentPoll;
  retryPersistence();
};

export const getTrackedPayments = () =>
  Object.fromEntries(pendingEntries().map((entry) => [keyFor(entry.projectId, entry.type, entry.paymentId), entry]));
