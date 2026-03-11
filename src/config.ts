export const config = {
  chatModel: process.env.DOC_ORACLE_MODEL || "llama3.2",
  embeddingModel: process.env.DOC_ORACLE_EMBED_MODEL || "nomic-embed-text",
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  defaultMaxPages: 200,
  defaultConcurrency: 5,
  chunkSize: 1000,
  chunkOverlap: 200,
  topK: 8,
  embeddingBatchSize: 10,
  crawlTimeout: 15_000,
  minContentLength: 50,
  minChunkLength: 20,
} as const;
