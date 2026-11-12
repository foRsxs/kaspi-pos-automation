import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { readJson, writeJson } from './storage.js';
import { decryptSecret } from './crypto.js';
import { getIdentity } from './identity.js';
import { queueConnectionLoss, resolveConnectionLoss } from './notificationStore.js';
import { logger } from './logger.js';

const sessionFile = (projectId) => path.join(DATA_DIR, 'projects', projectId, 'merchant-session.json');

export const INACTIVE_KASPI_SESSION = Object.freeze({
  active: false,
  error: 'Подключение к Kaspi Pay потеряно. Подключите счёт заново по SMS.',
  code: 'KASPI_SESSION_EXPIRED',
});

export const getStoredMerchantSession = (projectId) => {
  const session = readJson(sessionFile(projectId), null);
  return session?.projectId === projectId && session.tokenSN && session.profileId && session.vtokenSecret
    ? session
    : null;
};

export const getActiveMerchantSession = (projectId) => {
  const session = getStoredMerchantSession(projectId);
  if (!session || session.invalidatedAt) return null;
  return { ...session, decryptedSecret: decryptSecret(session.vtokenSecret) };
};

export const saveMerchantSession = (projectId, session) => {
  if (!session.tokenSN || !session.vtokenSecret || !session.profileId) throw new Error('Incomplete Kaspi session');
  const { directory } = getIdentity(projectId);
  // Only persist the encrypted credential and public account metadata.
  const fields = ['tokenSN', 'vtokenSecret', 'profileId', 'organizationId', 'orgName', 'phone', 'organizations'];
  const saved = Object.fromEntries(
    fields.filter((field) => session[field] !== undefined).map((field) => [field, session[field]]),
  );
  writeJson(path.join(directory, 'merchant-session.json'), {
    ...saved,
    projectId,
    verifiedAt: new Date().toISOString(),
  });
  try {
    resolveConnectionLoss(projectId);
  } catch {
    logger.warn('NOTIFICATIONS', `Не удалось отменить уведомления восстановленного проекта ${projectId}`);
  }
};

export const getConnectionSummary = (projectId) => {
  try {
    const session = getStoredMerchantSession(projectId);
    if (!session) return { connected: false };
    decryptSecret(session.vtokenSecret);
    return {
      connected: !session.invalidatedAt,
      orgName: session.orgName || null,
      phone: session.phone || null,
      profileId: session.profileId,
      verifiedAt: session.verifiedAt || null,
    };
  } catch {
    return { connected: false };
  }
};

export const markMerchantSessionInactive = (projectId, tokenSN) => {
  const file = sessionFile(projectId);
  const session = getStoredMerchantSession(projectId);
  if (session && session.tokenSN === tokenSN) {
    const invalidatedAt = session.invalidatedAt || new Date().toISOString();
    try {
      queueConnectionLoss(projectId, tokenSN, invalidatedAt, { orgName: session.orgName, phone: session.phone });
    } catch {
      logger.warn('NOTIFICATIONS', `Не удалось поставить уведомление проекта ${projectId} в очередь`);
    }
    if (!session.invalidatedAt) writeJson(file, { ...session, invalidatedAt });
  }
};

export const markMerchantSessionVerified = (projectId, tokenSN) => {
  const file = sessionFile(projectId);
  const session = getStoredMerchantSession(projectId);
  if (!session || session.tokenSN !== tokenSN || session.invalidatedAt) return false;
  writeJson(file, { ...session, verifiedAt: new Date().toISOString() });
  return true;
};

export const requireSession = (req, res, next) => {
  try {
    const projectId = req.kaspiProject.id;
    const session = getActiveMerchantSession(projectId);
    if (!session) {
      return res.status(401).json(INACTIVE_KASPI_SESSION);
    }
    req.session = session;
    next();
  } catch {
    res.status(401).json(INACTIVE_KASPI_SESSION);
  }
};
