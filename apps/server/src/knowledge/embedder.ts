import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { normalize } from '../core/text.js';

export const EMBEDDING_DIMENSIONS = 1536;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export function openAiEmbedder(client: OpenAI, model: string): Embedder {
  return {
    async embed(texts) {
      if (!texts.length) return [];
      const res = await client.embeddings.create({ model, input: texts.map((t) => t.slice(0, 8000)), dimensions: EMBEDDING_DIMENSIONS });
      return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

/**
 * Embedder local sin red (bolsa de palabras con hashing). Se usa en tests y cuando no hay OPENAI_API_KEY:
 * la búsqueda sigue funcionando por coincidencia de palabras, con menor calidad semántica.
 */
export const localEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of normalize(text).split(' ').filter((w) => w.length > 2)) {
        const stem = word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
        const h = createHash('sha1').update(stem).digest();
        v[h.readUInt32BE(0) % EMBEDDING_DIMENSIONS]! += 1;
      }
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
}
