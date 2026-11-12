import { Router } from 'express';
import { checkKaspiSession } from '../kaspiApi.js';
import { requireSession } from '../merchantSession.js';

const router = Router();

router.get('/check', requireSession, async (req, res, next) => {
  try {
    res.json(await checkKaspiSession(req.session));
  } catch (err) {
    next(err);
  }
});

export default router;
