import type { Database } from "bun:sqlite";
import { config } from "./config";
import { embed } from "./ollama";
import { insertChunk, clearChunks } from "./store";

interface PageInput {
  url: string;
  content: string;
}

interface ChunkEntry {
  pageUrl: string;
  content: string;
}

function findSentenceBoundary(text: string, maxEnd: number): number {
  const slice = text.slice(0, maxEnd);
  const boundaries = [". ", ".\n", "?\n", "!\n"];
  const lastBoundary = Math.max(...boundaries.map((b) => slice.lastIndexOf(b)));

  if (lastBoundary > maxEnd * 0.5) return lastBoundary + 1;
  return maxEnd;
}

export function chunkText(text: string): string[] {
  const { chunkSize, chunkOverlap, minChunkLength } = config;

  if (text.length <= chunkSize) {
    return text.trim().length > 0 ? [text.trim()] : [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    if (end < text.length) {
      end = start + findSentenceBoundary(text.slice(start), chunkSize);
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > minChunkLength) chunks.push(chunk);

    start = end - chunkOverlap;
  }

  return chunks;
}

function flattenPagesToChunks(pages: PageInput[]): ChunkEntry[] {
  return pages.flatMap((page) =>
    chunkText(page.content).map((content) => ({
      pageUrl: page.url,
      content,
    }))
  );
}

async function embedBatch(
  db: Database,
  sourceId: number,
  batch: ChunkEntry[],
  model: string
): Promise<void> {
  const embeddings = await Promise.all(
    batch.map((c) => embed(c.content, model))
  );

  batch.forEach((entry, i) => {
    insertChunk(db, {
      source_id: sourceId,
      page_url: entry.pageUrl,
      content: entry.content,
      embedding: embeddings[i]!,
    });
  });
}

export interface IndexOptions {
  embeddingModel?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function indexSource(
  db: Database,
  sourceId: number,
  pages: PageInput[],
  opts: IndexOptions = {}
): Promise<number> {
  const model = opts.embeddingModel ?? config.embeddingModel;

  clearChunks(db, sourceId);

  const allChunks = flattenPagesToChunks(pages);
  console.log(`  Indexing ${allChunks.length} chunks from ${pages.length} pages...`);

  let processed = 0;

  for (let i = 0; i < allChunks.length; i += config.embeddingBatchSize) {
    const batch = allChunks.slice(i, i + config.embeddingBatchSize);
    await embedBatch(db, sourceId, batch, model);

    processed += batch.length;
    opts.onProgress?.(processed, allChunks.length);
  }

  return allChunks.length;
}
