import { app } from "./app";
import { env } from "./config/env";
import { checkDatabaseConnection } from "./db/health";
import { syncWorker } from "./modules/orbital-data/index";
import { logger } from "./config/logger";

async function start(): Promise<void> {
  await checkDatabaseConnection();

  if (env.orbitalSyncEnabled) {
    syncWorker.start();
  }

  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? 'unknown';
  const dbHost = dbUrl.split('@')[1]?.split('/')[0] ?? 'localhost';

  app.listen(env.port, () => {
    logger.info(`OrbitMesh API running on http://localhost:${env.port}`);
    logger.info(`Environment : ${process.env.NODE_ENV ?? 'development'}`);
    logger.info(`Database    : ${dbName} @ ${dbHost}`);
    if ((process.env.NODE_ENV ?? 'development') === 'production') {
      logger.warn('Running in PRODUCTION mode — db:seed:demo is blocked');
    }
  });
}

start().catch((error: unknown) => {
  logger.error({ err: error }, "Failed to start OrbitMesh API");
  process.exit(1);
});
