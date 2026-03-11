export interface DocSource {
  id: number;
  name: string;
  base_url: string;
  created_at: string;
  last_crawled_at: string | null;
}

export interface CrawledPage {
  id?: number;
  source_id: number;
  url: string;
  title: string;
  content: string;
  crawled_at: string;
}

export interface DocChunk {
  id?: number;
  source_id: number;
  page_url: string;
  content: string;
  embedding: number[];
}

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
  links: string[];
}

export interface SearchResult {
  content: string;
  pageUrl: string;
  score: number;
}

export interface HealthCheck {
  ok: boolean;
  error?: string;
}

export interface ChunkRow {
  id: number;
  source_id: number;
  page_url: string;
  content: string;
  embedding: Buffer;
}
