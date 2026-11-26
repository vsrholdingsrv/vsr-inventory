import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { pool, requireDatabaseUrl } from './db';
import { productsRouter } from './routes/products';
import { storesRouter } from './routes/stores';
import { movementsRouter } from './routes/movements';
import { commanderRouter } from './routes/commander';
import { invoicesRouter } from './routes/invoices';
import { dashboardRouter } from './routes/dashboard';

export const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'vsr-inventory-api', commanderMode: 'simulated' });
});

app.use('/api/products', productsRouter(pool));
app.use('/api/stores', storesRouter(pool));
app.use('/api/movements', movementsRouter(pool));
app.use('/api/commander', commanderRouter(pool));
app.use('/api/invoices', invoicesRouter(pool));
app.use('/api/dashboard', dashboardRouter(pool));

// 404 for unknown API routes.
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler: never leak stack traces to clients.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[api] error', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT ?? 3000);

if (require.main === module) {
  requireDatabaseUrl();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] vsr-inventory-api listening on :${PORT} (commander: simulated)`);
  });
}
