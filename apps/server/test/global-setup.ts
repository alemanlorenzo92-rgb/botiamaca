import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL } from './db-url.js';

/** Aplica las migraciones sobre la base de pruebas (se crea si no existe). */
export default function setup() {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  execFileSync(fileURLToPath(new URL('../node_modules/.bin/prisma', import.meta.url)), ['migrate', 'deploy'], {
    cwd,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
