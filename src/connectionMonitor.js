import { listProjects } from './projectStore.js';
import { getActiveMerchantSession, getStoredMerchantSession } from './merchantSession.js';
import { checkKaspiSession } from './kaspiApi.js';
import { getNotificationSettings, queueConnectionLoss } from './notificationStore.js';
import { logger } from './logger.js';

const CHECK_INTERVAL = 5 * 60 * 1000;
let active = false;
let timer = null;
let currentCheck = null;
let generation = 0;

const checkConnections = async () => {
  const checkGeneration = generation;
  const settings = getNotificationSettings();
  if (!settings.enabled || !settings.configured) return;
  for (const project of listProjects()) {
    if (checkGeneration !== generation || !getNotificationSettings().enabled) return;
    try {
      const stored = getStoredMerchantSession(project.id);
      if (!stored) continue;
      if (stored.invalidatedAt) {
        queueConnectionLoss(project.id, stored.tokenSN, stored.invalidatedAt, {
          orgName: stored.orgName,
          phone: stored.phone,
        });
        continue;
      }
      const session = getActiveMerchantSession(project.id);
      if (session) await checkKaspiSession(session);
    } catch (error) {
      if (['KASPI_SESSION_EXPIRED', 'KASPI_SESSION_CHANGED'].includes(error.code)) continue;
      logger.warn('CONNECTIONS', `Не удалось проверить подключение проекта ${project.id}`);
    }
  }
};

export const checkConnectionsOnce = () => {
  if (!currentCheck) currentCheck = checkConnections().finally(() => (currentCheck = null));
  return currentCheck;
};

const schedule = (delay) => {
  timer = setTimeout(async () => {
    try {
      await checkConnectionsOnce();
    } catch {
      logger.warn('CONNECTIONS', 'Не удалось выполнить проверку банковских подключений');
    } finally {
      if (active) schedule(CHECK_INTERVAL);
    }
  }, delay);
  timer.unref();
};

export const startConnectionMonitor = () => {
  if (active) return;
  active = true;
  schedule(0);
};

export const stopConnectionMonitor = async () => {
  active = false;
  generation++;
  clearTimeout(timer);
  await currentCheck;
};
