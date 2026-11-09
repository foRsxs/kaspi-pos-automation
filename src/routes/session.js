import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { requireSession, saveMerchantSession, markMerchantSessionInactive } from '../merchantSession.js';

const router = Router();

router.get('/check', requireSession, async (req, res) => {
  const session = req.session;

  // 3. Ping Kaspi API to verify the token is still accepted
  try {
    const url = `${KASPI_QRPAY_URL}/v02/history/operations`;
    const payload = JSON.stringify({
      EndDate: new Date().toISOString().slice(0, 10),
      LastTransactionDate: '',
      StatementPeriodCode: 0,
    });
    const headers = { ...signedQrPayHeaders(url, session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });

    const body = await resp.json().catch(() => ({}));

    // Kaspi may return HTTP 200 but with error StatusCode in body
    if (resp.ok && (!body.StatusCode || body.StatusCode === 0)) {
      saveMerchantSession(req.kaspiProject.id, session);
      return res.json({ active: true, profileId: session.profileId, orgName: session.orgName, phone: session.phone });
    }

    if ([401, 403].includes(resp.status) || body.StatusCode === -101001) {
      markMerchantSessionInactive(req.kaspiProject.id, session.tokenSN);
    }
    return res.status(resp.ok ? 401 : resp.status).json({
      active: false,
      error: body.Message || body.message || 'Session rejected by Kaspi API.',
      code: body.StatusCode || body.Code,
      details: body,
    });
  } catch (err) {
    return res.status(500).json({ active: false, error: err.message });
  }
});

export default router;
