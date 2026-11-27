import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { pool, requireDatabaseUrl } from './db';
import { migrateDatabase } from './db/migrate';
import { seedIfEmpty } from './seed';
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
  (async () => {
    // Self-setup for fresh databases (e.g. Render Free, no shell):
    // create the tables, then seed the demo catalog only if empty.
    // Set AUTO_SETUP=false to skip this. Failures are logged, not fatal —
    // /health must still answer so a bad DB never takes the service down.
    if (process.env.AUTO_SETUP !== 'false') {
      try {
        await migrateDatabase(pool);
        const seeded = await seedIfEmpty(pool);
        // eslint-disable-next-line no-console
        console.log(`[api] startup setup done (seeded demo data: ${seeded})`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[api] startup setup failed (continuing)', err);
      }
    }
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[api] vsr-inventory-api listening on :${PORT} (commander: simulated)`);
    });
  })();
}
