import { Router } from 'express';
import {
  adminProfile,
  verifyAdminPassword,
  changeAdminPassword,
  createAdminSession,
  removeAdminSession,
  checkPasswordRateLimit,
  clearPasswordRateLimit,
  revealAdminApiKey,
  rotateAdminApiKey,
} from '../adminStore.js';
import { ADMIN_COOKIE, sameOrigin, requireAdminSession, requireFullAdminSession } from '../adminAuth.js';
import { encryptionKeySource } from '../serverSecrets.js';

const router = Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const issueSession = (req, res) => {
  const session = createAdminSession();
  res.cookie(ADMIN_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || req.secure,
    path: '/api',
    maxAge: session.expiresAt - Date.now(),
  });
  res.json({ authenticated: true, ...adminProfile(), csrfToken: session.csrfToken });
};
const client = (req) => req.socket.remoteAddress || 'local';
const confirmPassword = async (req) => {
  checkPasswordRateLimit(client(req));
  if (!(await verifyAdminPassword(req.body?.password)))
    throw Object.assign(new Error('Неверный пароль администратора'), { status: 401 });
  clearPasswordRateLimit(client(req));
};
router.post(
  '/login',
  asyncRoute(async (req, res) => {
    if (!sameOrigin(req) || !req.is('application/json'))
      return res.status(403).json({ error: 'Запрос входа отклонён' });
    checkPasswordRateLimit(client(req));
    const verified = await verifyAdminPassword(req.body?.password);
    if (!verified || req.body?.username !== adminProfile().username)
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    clearPasswordRateLimit(client(req));
    issueSession(req, res);
  }),
);
router.use(requireAdminSession);
router.get('/session', (req, res) =>
  res.json({
    authenticated: true,
    username: req.adminSession.username,
    mustChangePassword: req.adminSession.mustChangePassword,
    csrfToken: req.adminSession.csrfToken,
  }),
);
router.post('/logout', (req, res) => {
  removeAdminSession(req.adminSession.tokenHash);
  res.clearCookie(ADMIN_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || req.secure,
    path: '/api',
  });
  res.status(204).end();
});
router.post(
  '/password',
  asyncRoute(async (req, res) => {
    checkPasswordRateLimit(client(req));
    if (!(await verifyAdminPassword(req.body?.currentPassword)))
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    clearPasswordRateLimit(client(req));
    await changeAdminPassword(req.body?.newPassword);
    issueSession(req, res);
  }),
);
router.use(requireFullAdminSession);
router.get('/settings', (_req, res) =>
  res.json({
    username: adminProfile().username,
    encryptionKeyConfigured: true,
    encryptionKeySource,
    apiKeyConfigured: true,
  }),
);
router.post(
  '/api-key/reveal',
  asyncRoute(async (req, res) => {
    await confirmPassword(req);
    res.json({ apiKey: revealAdminApiKey() });
  }),
);
router.post(
  '/api-key/rotate',
  asyncRoute(async (req, res) => {
    await confirmPassword(req);
    res.json({ apiKey: rotateAdminApiKey(req.body?.apiKey) });
  }),
);
export default router;
