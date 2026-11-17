import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Dónde viven los archivos de la biblioteca. Hoy disco local (volumen); mañana puede ser S3/R2. */
export interface MediaStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

export class LocalMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Clave de archivo inválida');
    return full;
  }

  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string) {
    return readFile(this.resolve(key));
  }

  async exists(key: string) {
    try {
      return (await stat(this.resolve(key))).isFile();
    } catch {
      return false;
    }
  }

  async remove(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}
