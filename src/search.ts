import type { Database } from "bun:sqlite";
import { config } from "./config";
import { embed } from "./ollama";
import { getChunkRows } from "./store";
import type { ChunkRow, SearchResult } from "./types";

function dotProduct(a: Float64Array, b: Float64Array): [number, number, number] {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [i, ai] of a.entries()) {
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  return [dot, normA, normB];
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  const [dot, normA, normB] = dotProduct(a, b);
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function decodeEmbedding(buf: Buffer): Float64Array {
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / Float64Array.BYTES_PER_ELEMENT);
}

function scoreChunk(row: ChunkRow, queryEmbedding: Float64Array): SearchResult {
  return {
    content: row.content,
    pageUrl: row.page_url,
    score: cosineSimilarity(queryEmbedding, decodeEmbedding(row.embedding)),
  };
}

function rankByRelevance(results: SearchResult[], topK: number): SearchResult[] {
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export async function searchChunks(
  db: Database,
  sourceId: number,
  query: string,
  opts: { topK?: number; embeddingModel?: string } = {}
): Promise<SearchResult[]> {
  const topK = opts.topK ?? config.topK;
  const model = opts.embeddingModel ?? config.embeddingModel;

  const queryVector = new Float64Array(await embed(query, model));
  const rows = getChunkRows(db, sourceId) as ChunkRow[];
  const scored = rows.map((row) => scoreChunk(row, queryVector));

  return rankByRelevance(scored, topK);
}
