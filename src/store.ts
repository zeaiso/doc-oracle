import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";
import type { DocSource, CrawledPage, DocChunk } from "./types";

const DATA_DIR = path.join(process.cwd(), ".doc-oracle");
const DB_PATH = path.join(DATA_DIR, "store.db");

const SCHEMA = {
  sources: `
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_crawled_at TEXT
    )`,
  pages: `
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    )`,
  chunks: `
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      page_url TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    )`,
};

function initializeSchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA.sources);
  db.run(SCHEMA.pages);
  db.run(SCHEMA.chunks);
  db.run("CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source_id)");
}

export function getDb(): Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  initializeSchema(db);
  return db;
}

export function upsertSource(db: Database, name: string, baseUrl: string): DocSource {
  const existing = db.query("SELECT * FROM sources WHERE base_url = ?").get(baseUrl) as DocSource | null;
  if (existing) return existing;

  db.query("INSERT INTO sources (name, base_url) VALUES (?, ?)").run(name, baseUrl);
  const { id } = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return db.query("SELECT * FROM sources WHERE id = ?").get(id) as DocSource;
}

export function findSourceByName(db: Database, name: string): DocSource | null {
  return db.query("SELECT * FROM sources WHERE name = ?").get(name) as DocSource | null;
}

export function findSourcesByPrefix(db: Database, prefix: string): DocSource[] {
  return db.query("SELECT * FROM sources WHERE name LIKE ? ORDER BY name").all(`${prefix}@%`) as DocSource[];
}

export function listSources(db: Database): DocSource[] {
  return db.query("SELECT * FROM sources ORDER BY created_at DESC").all() as DocSource[];
}

export function deleteSource(db: Database, sourceId: number): void {
  db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
  db.query("DELETE FROM pages WHERE source_id = ?").run(sourceId);
  db.query("DELETE FROM sources WHERE id = ?").run(sourceId);
}

export function markSourceCrawled(db: Database, sourceId: number): void {
  db.query("UPDATE sources SET last_crawled_at = datetime('now') WHERE id = ?").run(sourceId);
}

export function upsertPage(db: Database, page: Omit<CrawledPage, "id">): void {
  db.query(`
    INSERT INTO pages (source_id, url, title, content, crawled_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET title=excluded.title, content=excluded.content, crawled_at=datetime('now')
  `).run(page.source_id, page.url, page.title, page.content);
}

export function getPages(db: Database, sourceId: number): CrawledPage[] {
  return db.query("SELECT * FROM pages WHERE source_id = ?").all(sourceId) as CrawledPage[];
}

export function countChunks(db: Database, sourceId: number): number {
  const row = db.query("SELECT COUNT(*) as count FROM chunks WHERE source_id = ?").get(sourceId) as { count: number };
  return row.count;
}

export function clearChunks(db: Database, sourceId: number): void {
  db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
}

export function insertChunk(db: Database, chunk: Omit<DocChunk, "id">): void {
  const blob = Buffer.from(new Float64Array(chunk.embedding).buffer);
  db.query("INSERT INTO chunks (source_id, page_url, content, embedding) VALUES (?, ?, ?, ?)")
    .run(chunk.source_id, chunk.page_url, chunk.content, blob);
}

export function getChunkRows(db: Database, sourceId: number) {
  return db.query("SELECT * FROM chunks WHERE source_id = ?").all(sourceId);
}
