import { createContainer } from './container.js';
import { loadEnv } from './core/env.js';
import { createLogger } from './core/logger.js';
import { buildServer } from './http/server.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const c = createContainer(env, logger);
const timers: NodeJS.Timeout[] = [];

async function start() {
  await c.db.$connect();
  await c.settings.getAi(); // falla temprano si no se corrió el seed

  const app = await buildServer(c);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  if (c.gateway) {
    void c.gateway.start().catch((err: unknown) => logger.error({ err }, 'no se pudo iniciar WhatsApp'));
  } else {
    logger.warn('WhatsApp deshabilitado (WHATSAPP_ENABLED=false)');
  }

  // Cola durable: lo que quedó sin responder antes de un reinicio se retoma.
  const recovered = await c.worker.recoverPending();
  if (recovered) logger.info({ recovered }, 'respuestas pendientes recuperadas');

  c.followups.startScheduler();

  timers.push(
    setInterval(() => void c.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {}), 60 * 60_000),
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'apagando');
    timers.forEach(clearInterval);
    c.worker.stop();
    c.followups.stop();
    await app.close().catch(() => {});
    await c.worker.drain().catch(() => {});
    await c.gateway?.stop().catch(() => {});
    await c.db.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch(async (err: unknown) => {
  logger.fatal({ err }, 'no se pudo iniciar el servidor');
  await c.db.$disconnect().catch(() => {});
  process.exit(1);
});
