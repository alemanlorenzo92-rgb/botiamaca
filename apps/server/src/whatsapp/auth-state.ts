import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from 'baileys';
import type { PrismaClient } from '@prisma/client';
import type { Cipher } from '../core/crypto.js';

/** Estado de autenticación de Baileys guardado cifrado en Postgres (nada en disco). */
export async function usePostgresAuthState(db: PrismaClient, cipher: Cipher) {
  const encode = (value: unknown) => cipher.encrypt(JSON.stringify(value, BufferJSON.replacer));
  const decode = (value: string): unknown => JSON.parse(cipher.decrypt(value), BufferJSON.reviver);

  const credsRow = await db.waAuthKey.findUnique({ where: { key: 'creds' } });
  const creds: AuthenticationCreds = credsRow ? (decode(credsRow.value) as AuthenticationCreds) : initAuthCreds();

  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const rows = await db.waAuthKey.findMany({ where: { key: { in: ids.map((id) => `${type}-${id}`) } } });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const raw = byKey.get(`${type}-${id}`);
        if (!raw) continue;
        let value = decode(raw);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
        }
        result[id] = value as SignalDataTypeMap[T];
      }
      return result;
    },
    async set(data) {
      const writes: Promise<unknown>[] = [];
      for (const [category, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries ?? {})) {
          const key = `${category}-${id}`;
          writes.push(
            value
              ? db.waAuthKey.upsert({ where: { key }, create: { key, value: encode(value) }, update: { value: encode(value) } })
              : db.waAuthKey.deleteMany({ where: { key } }),
          );
        }
      }
      await Promise.all(writes);
    },
    async clear() {
      await db.waAuthKey.deleteMany({ where: { key: { not: 'creds' } } });
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await db.waAuthKey.upsert({
        where: { key: 'creds' },
        create: { key: 'creds', value: encode(creds) },
        update: { value: encode(creds) },
      });
    },
  };
}

export async function clearAuthState(db: PrismaClient): Promise<void> {
  await db.waAuthKey.deleteMany({});
}
