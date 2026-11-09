import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { readJson, writeJson } from './storage.js';
import { decryptSecret } from './crypto.js';
import { getIdentity } from './identity.js';

const sessionFile = (projectId) => path.join(DATA_DIR, 'projects', projectId, 'merchant-session.json');

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
};

export const getConnectionSummary = (projectId) => {
  try {
    const session = readJson(sessionFile(projectId), null);
    if (!session || session.projectId !== projectId) return { connected: false };
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
  const session = readJson(file, null);
  if (session && session.projectId === projectId && session.tokenSN === tokenSN) {
    writeJson(file, { ...session, invalidatedAt: new Date().toISOString() });
  }
};

export const requireSession = (req, res, next) => {
  try {
    const projectId = req.kaspiProject.id;
    const session = readJson(sessionFile(projectId), null);
    if (!session || session.invalidatedAt) {
      return res.status(401).json({ active: false, error: 'Подключите счёт проекта через вход в Kaspi Pay по SMS' });
    }
    if (session.projectId !== projectId) throw new Error('Kaspi session belongs to a different project');
    req.session = { ...session, projectId, decryptedSecret: decryptSecret(session.vtokenSecret) };
    next();
  } catch {
    res.status(401).json({ active: false, error: 'Сессия Kaspi недействительна. Подключите счёт заново' });
  }
};
