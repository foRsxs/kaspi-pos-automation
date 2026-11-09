import express from 'express';
import path from 'path';
import { PORT, ROOT_DIR } from './src/config.js';
import { authenticateProject, requireAdmin, selectKaspiProject } from './src/projects.js';
import authRoutes from './src/routes/auth.js';
import projectRoutes from './src/routes/projects.js';
import invoiceRoutes from './src/routes/invoice.js';
import qrRoutes from './src/routes/qr.js';
import historyRoutes from './src/routes/history.js';
import refundRoutes from './src/routes/refund.js';
import sessionRoutes from './src/routes/session.js';
import { startPolling, stopPolling, listPayments } from './src/polling.js';
import 'dotenv/config';

const app = express();

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', authenticateProject);
app.use('/api/projects', projectRoutes);
app.use('/api', selectKaspiProject);
app.get('/api/payments', (req, res) =>
  res.set('Cache-Control', 'no-store').json(listPayments(req.kaspiProject.id, req.query)),
);
app.use('/api/auth', requireAdmin, authRoutes);
app.use('/api/invoice', invoiceRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/history', requireAdmin, historyRoutes);
app.use('/api/refund', refundRoutes);
app.use('/api/session', requireAdmin, sessionRoutes);

app.use((err, _req, res, _next) => {
  const errorStatus = err.status ?? err.statusCode;
  const status = [400, 404, 409, 413, 422].includes(errorStatus) ? errorStatus : 500;
  if (status === 500) console.error('API error:', err.message);
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    ...(status < 500 && typeof err.code === 'string' ? { code: err.code } : {}),
  });
});

export const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🟢 Kaspi Pay App running at http://localhost:${PORT}\n`);
});
startPolling();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  server.close(async () => {
    try {
      await stopPolling();
      clearTimeout(deadline);
    } catch (err) {
      console.error('Failed to save state during shutdown:', err.message);
      process.exitCode = 1;
    }
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
