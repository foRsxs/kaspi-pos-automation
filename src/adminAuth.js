import crypto from 'node:crypto';
import { getAdminSession } from './adminStore.js';

export const ADMIN_COOKIE = 'kaspi_admin_session';
export const cookieToken = (req) => {
  const matches = (req.get('Cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ADMIN_COOKIE}=`));
  return matches.length === 1 ? matches[0].slice(ADMIN_COOKIE.length + 1) : '';
};
export const sameOrigin = (req) => {
  if (req.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = req.get('Origin');
  if (!origin) return true;
  try {
    const value = new URL(origin);
    return (
      ['http:', 'https:'].includes(value.protocol) && value.host.toLowerCase() === (req.get('Host') || '').toLowerCase()
    );
  } catch {
    return false;
  }
};
export const validCsrf = (req, session) => {
  const supplied = req.get('X-CSRF-Token');
  if (typeof supplied !== 'string' || !sameOrigin(req)) return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(supplied), digest(session.csrfToken));
};
export const sessionForRequest = (req) => getAdminSession(cookieToken(req));
export const requireAdminSession = (req, res, next) => {
  const session = sessionForRequest(req);
  if (!session) return res.status(401).json({ error: 'Войдите в админку', code: 'AUTH_SESSION_EXPIRED' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !validCsrf(req, session))
    return res
      .status(403)
      .json({ error: 'Запрос отклонён. Обновите страницу и повторите вход.', code: 'CSRF_INVALID' });
  req.adminSession = session;
  next();
};
export const requireFullAdminSession = (req, res, next) => {
  if (req.adminSession.mustChangePassword)
    return res
      .status(403)
      .json({ error: 'Сначала задайте постоянный пароль администратора', code: 'ADMIN_PASSWORD_CHANGE_REQUIRED' });
  next();
};
