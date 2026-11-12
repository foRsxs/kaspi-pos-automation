import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { getProject } from './projectStore.js';
import { getStoredMerchantSession } from './merchantSession.js';
import {
  cancelConnectionNotification,
  claimNextConnectionNotification,
  getNotificationDeliverySettings,
  markConnectionNotificationSent,
  recoverSendingConnectionNotifications,
  recordNotificationError,
  recordNotificationSuccess,
  reserveNotificationTest,
  retryConnectionNotification,
} from './notificationStore.js';

const SMTP_SEND_TIMEOUT_MS = 20_000;
const SAFE_SEND_ERROR =
  'Не удалось отправить тестовое письмо. Проверьте настройки SMTP и доступность почтового сервера.';
const TEST_SUCCESS_MESSAGE = 'Тестовое письмо принято почтовым сервером.';

export class ConnectionNotificationError extends Error {
  constructor(message, status = 502, code = 'NOTIFICATION_SEND_FAILED') {
    super(message);
    this.name = 'ConnectionNotificationError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

const secretHash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const cleanText = (value, maxLength = 160) => {
  if (typeof value !== 'string') return '';
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, maxLength);
};

const createTransport = (settings) =>
  nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecurity === 'tls',
    requireTLS: settings.smtpSecurity === 'starttls',
    ...(settings.smtpUser ? { auth: { user: settings.smtpUser, pass: settings.smtpPassword } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    maxRecipients: 1,
  });

const transportSettings = (settings) => {
  if (!settings.configured) {
    throw new ConnectionNotificationError(
      'Сначала заполните и сохраните настройки SMTP.',
      400,
      'NOTIFICATION_NOT_CONFIGURED',
    );
  }
  return settings;
};

const sendMail = async (settings, message) => {
  const transport = createTransport(settings);
  try {
    const result = await transport.sendMail({
      ...message,
      signal: globalThis.AbortSignal.timeout(SMTP_SEND_TIMEOUT_MS),
    });
    const recipient = message.to.toLowerCase();
    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
    if (
      !accepted.some(
        (address) => (typeof address === 'string' ? address : address?.address)?.toLowerCase() === recipient,
      )
    ) {
      throw new Error('SMTP did not accept the configured recipient');
    }
    return result;
  } finally {
    transport.close?.();
  }
};

export const sendNotificationTest = async () => {
  const settings = transportSettings(getNotificationDeliverySettings());
  reserveNotificationTest();
  try {
    await sendMail(settings, {
      from: settings.smtpFrom,
      to: settings.email,
      subject: 'Тест уведомлений Kaspi Pay',
      text: 'Тестовое письмо. Настройки почтовых уведомлений работают.',
      messageId: `<kaspi-notification-test-${crypto.randomUUID()}@notifications.local>`,
    });
    recordNotificationSuccess();
    return { success: true, message: TEST_SUCCESS_MESSAGE };
  } catch {
    recordNotificationError();
    throw new ConnectionNotificationError(SAFE_SEND_ERROR, 502, 'NOTIFICATION_SEND_FAILED');
  }
};

const notificationText = (project, notification) => {
  const occurredAt = new Intl.DateTimeFormat('ru-KZ', {
    timeZone: 'Asia/Almaty',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(notification.lost_at));
  const organization = cleanText(notification.org_name) || 'не указана';
  const phone = cleanText(notification.phone, 80) || 'не указан';
  return [
    'Потеряно подключение проекта к Kaspi Pay.',
    `Проект: ${cleanText(project.name, 120) || project.id} (${project.id})`,
    `Организация: ${organization}`,
    `Телефон: ${phone}`,
    `Время: ${occurredAt} (Asia/Almaty)`,
    'Для восстановления подключения войдите в проект и пройдите вход в Kaspi Pay по SMS.',
  ].join('\n');
};

const currentIncidentMatches = (projectId, notification) => {
  try {
    const session = getStoredMerchantSession(projectId);
    return Boolean(
      session &&
      session.invalidatedAt === notification.lost_at &&
      secretHash(session.tokenSN) === notification.token_hash,
    );
  } catch {
    return false;
  }
};

const deliverOne = async (notification) => {
  let settings;
  try {
    settings = getNotificationDeliverySettings();
    if (!settings.enabled || !settings.configured) {
      cancelConnectionNotification(notification.id);
      return;
    }

    const project = getProject(notification.project_id, { includeArchived: true });
    if (!project || project.status === 'archived' || !currentIncidentMatches(notification.project_id, notification)) {
      cancelConnectionNotification(notification.id);
      return;
    }

    await sendMail(settings, {
      from: settings.smtpFrom,
      to: settings.email,
      subject: 'Потеряно подключение Kaspi Pay',
      text: notificationText(project, notification),
      messageId: `<kaspi-connection-${notification.id}@notifications.local>`,
    });
    markConnectionNotificationSent(notification.id);
  } catch {
    retryConnectionNotification(notification.id, notification.attempt_count);
    recordNotificationError();
  }
};

let started = false;
let timer = null;
let running = null;

const scheduleNext = () => {
  if (!started) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      await processConnectionNotifications();
    } catch {
      try {
        recordNotificationError();
      } catch {
        // A temporary SQLite error must not create an unhandled timer rejection.
      }
    } finally {
      scheduleNext();
    }
  }, 10_000);
  timer.unref();
};

export const processConnectionNotifications = () => {
  if (running) return running;
  running = (async () => {
    recoverSendingConnectionNotifications();
    const notification = claimNextConnectionNotification();
    if (!notification) return false;
    await deliverOne(notification);
    return true;
  })().finally(() => {
    running = null;
  });
  return running;
};

export const startConnectionNotifications = () => {
  if (started) return;
  started = true;
  // An SMTP acknowledgement can race process termination before SQLite records it.
  // Recover the same attempt and stable Message-ID to provide at-least-once delivery.
  try {
    recoverSendingConnectionNotifications();
  } catch {
    // Startup of the mail worker must not prevent the API or payment polling from starting.
  }
  scheduleNext();
};

export const stopConnectionNotifications = async () => {
  started = false;
  clearTimeout(timer);
  timer = null;
  await running;
};
