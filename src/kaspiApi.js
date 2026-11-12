import { loggedFetch, signedQrPayHeaders } from './helpers.js';
import { KASPI_QRPAY_URL } from './config.js';
import { INACTIVE_KASPI_SESSION, markMerchantSessionInactive, markMerchantSessionVerified } from './merchantSession.js';

const unavailableError = () =>
  Object.assign(new Error('Kaspi Pay временно недоступен. Проверьте статус операции перед повтором.'), {
    status: 503,
    code: 'KASPI_UNAVAILABLE',
  });

const upstreamError = () =>
  Object.assign(new Error('Kaspi Pay вернул некорректный ответ.'), {
    status: 502,
    code: 'KASPI_UPSTREAM_ERROR',
  });

export const readKaspiResponse = async (response, session) => {
  let body;
  let readError;
  try {
    body = await response.json();
  } catch (error) {
    readError = error;
  }

  if ([401, 403].includes(response.status) || [-101001, '-101001'].includes(body?.StatusCode)) {
    markMerchantSessionInactive(session.projectId, session.tokenSN);
    throw Object.assign(new Error(INACTIVE_KASPI_SESSION.error), { status: 401, ...INACTIVE_KASPI_SESSION });
  }
  if (
    response.status >= 500 ||
    readError?.name === 'AbortError' ||
    ['system', 'body-timeout', 'request-timeout'].includes(readError?.type)
  ) {
    throw unavailableError();
  }
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) throw upstreamError();
  return body;
};

export const requestKaspi = async (url, session, options = {}) => {
  const headers = {
    ...signedQrPayHeaders(url, session, options.body),
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...options.headers,
  };
  let response;
  try {
    response = await loggedFetch(url, { ...options, headers });
  } catch {
    throw unavailableError();
  }
  return readKaspiResponse(response, session);
};

export const checkKaspiSession = async (session) => {
  const payload = JSON.stringify({
    EndDate: new Date().toISOString().slice(0, 10),
    LastTransactionDate: '',
    StatementPeriodCode: 0,
  });
  const body = await requestKaspi(`${KASPI_QRPAY_URL}/v02/history/operations`, session, {
    method: 'POST',
    body: payload,
  });
  if (![undefined, 0, '0'].includes(body.StatusCode)) {
    throw Object.assign(new Error(body.Message || body.message || 'Kaspi Pay отклонил проверку подключения.'), {
      status: 502,
      code: 'KASPI_UPSTREAM_ERROR',
    });
  }
  if (!markMerchantSessionVerified(session.projectId, session.tokenSN)) {
    throw Object.assign(new Error('Подключение к Kaspi Pay изменилось. Повторите проверку.'), {
      status: 409,
      code: 'KASPI_SESSION_CHANGED',
    });
  }
  return { active: true, profileId: session.profileId, orgName: session.orgName, phone: session.phone };
};
