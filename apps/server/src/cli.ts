import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { AuditService } from './core/audit.js';
import { CatalogAdminService } from './catalog/catalog-admin.service.js';
import { ServicesService } from './catalog/services.service.js';
import { AuthService, DEFAULT_ROLES } from './http/auth.js';

export const DEFAULT_AI_SETTINGS = {
  personality:
    'Sos cordial, cercano y profesional. Hablás en español rioplatense, con mensajes cortos y claros, como una persona del equipo de ventas por WhatsApp.',
  instructions: '',
  handoffMessage: 'Te paso con una persona del equipo para que te ayude. Te escribimos por acá en cuanto puedan.',
  errorMessage: 'Perdón, tuve un problema para responderte. Ya le avisé al equipo para que te escriban.',
};

/** Seed idempotente: roles y `ai_settings` id=1. Las claves de negocio quedan sin cargar (= "sin dato"). */
export async function seed(db: PrismaClient) {
  for (const role of DEFAULT_ROLES) {
    await db.role.upsert({
      where: { code: role.code },
      create: role,
      update: { name: role.name, permissions: role.permissions },
    });
  }
  await db.aiSetting.upsert({ where: { id: 1 }, create: { id: 1, ...DEFAULT_AI_SETTINGS }, update: {} });
  await new ServicesService(db).ensureDefaults();
  await new CatalogAdminService(db).ensurePriceLists();
}

function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const USAGE = `Uso:
  pnpm cli seed
  pnpm cli user:create --email <email> --name <nombre> [--role admin|agent]
    (la contraseña se pide por teclado o se toma de CLI_PASSWORD)`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const db = new PrismaClient();
  try {
    if (command === 'seed') {
      await seed(db);
      console.log('Seed aplicado: roles y configuración de IA.');
      return;
    }
    if (command === 'user:create') {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin' } },
      });
      if (!values.email || !values.name) throw new Error(USAGE);
      const password = process.env.CLI_PASSWORD ?? (await askHidden('Contraseña (mín. 10 caracteres): '));
      if (password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
      await seed(db);
      const auth = new AuthService(db, new AuditService(db));
      const user = await auth.createUser({ email: values.email, name: values.name, password, roleCode: values.role ?? 'admin' });
      console.log(`Usuario creado: ${user.email} (${user.role.name})`);
      return;
    }
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
