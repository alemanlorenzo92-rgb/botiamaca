import type { Job, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from '../core/logger.js';

export type JobHandler = (payload: Prisma.JsonValue, job: Job) => Promise<void>;

/** Trabajos en paralelo: con historiales de cientos de chats, de a uno tarda horas. */
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

/** Cola durable mínima sobre Postgres (FOR UPDATE SKIP LOCKED). Sobrevive reinicios. */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly logger: Logger,
  ) {}

  on(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, payload: Prisma.InputJsonValue) {
    return this.db.job.create({ data: { type, payload } });
  }

  private async claim(): Promise<Job | null> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE jobs SET status = 'RUNNING', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'PENDING' AND run_at <= now()
        ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING id`;
    return rows[0] ? this.db.job.findUnique({ where: { id: rows[0].id } }) : null;
  }

  /** Procesa trabajos hasta vaciar la cola, varios a la vez. Devuelve cuántos procesó. */
  async runOnce(concurrency = CONCURRENCY): Promise<number> {
    const counts = await Promise.all(Array.from({ length: concurrency }, () => this.drain()));
    return counts.reduce((a, b) => a + b, 0);
  }

  private async drain(): Promise<number> {
    let count = 0;
    for (let job = await this.claim(); job; job = await this.claim()) {
      count++;
      const handler = this.handlers.get(job.type);
      try {
        if (!handler) throw new Error(`Tipo de trabajo desconocido: ${job.type}`);
        await handler(job.payload, job);
        await this.db.job.update({ where: { id: job.id }, data: { status: 'DONE', doneAt: new Date(), error: null } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const final = job.attempts >= MAX_ATTEMPTS;
        this.logger.error({ err: error, jobId: job.id, type: job.type }, 'trabajo falló');
        await this.db.job.update({
          where: { id: job.id },
          data: { status: final ? 'FAILED' : 'PENDING', error: message, runAt: new Date(Date.now() + 30_000 * 2 ** job.attempts) },
        });
      }
    }
    return count;
  }

  start(intervalMs = 5000) {
    // Trabajos que quedaron RUNNING por un reinicio vuelven a la cola.
    void this.db.job.updateMany({ where: { status: 'RUNNING' }, data: { status: 'PENDING' } }).catch(() => {});
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch((err: unknown) => this.logger.error({ err }, 'cola de trabajos falló'))
        .finally(() => (this.running = null));
    }, intervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
