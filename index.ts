#!/usr/bin/env bun
import { config } from "./src/config";
import { getDb, upsertSource, findSourceByName, listSources, deleteSource, upsertPage, getPages, countChunks, markSourceCrawled } from "./src/store";
import { crawlSite } from "./src/crawler";
import { indexSource } from "./src/indexer";
import { searchChunks } from "./src/search";
import { chat, checkModel } from "./src/ollama";
import { buildSystemPrompt } from "./src/prompt";
import type { DocSource } from "./src/types";
import type { Database } from "bun:sqlite";
import * as readline from "readline";

function die(message: string): never {
  console.error(`\n  ${message}`);
  process.exit(1);
}

function requireSource(db: Database, name: string): DocSource {
  return findSourceByName(db, name) ?? die(`Source "${name}" not found. Run: bun run index.ts list`);
}

async function requireModel(model: string): Promise<void> {
  const check = await checkModel(model);
  if (!check.ok) die(check.error!);
}

function parseMaxPages(args: string[]): number {
  if (args.includes("--all")) return Infinity;
  const flag = args.find((a) => a.startsWith("--max-pages="));
  return flag ? parseInt(flag.split("=")[1] ?? "") : config.defaultMaxPages;
}

async function cmdCrawl(name: string, url: string, maxPages: number) {
  await requireModel(config.embeddingModel);

  const db = getDb();
  const source = upsertSource(db, name, url);

  const limit = isFinite(maxPages) ? `max ${maxPages} pages` : "all pages";
  console.log(`\n  Crawling "${name}" from ${url} (${limit})...\n`);

  const pages = await crawlSite(url, {
    maxPages,
    concurrency: config.defaultConcurrency,
    onPage(pageUrl, current, max) {
      const counter = isFinite(max) ? `${current}/${max}` : `${current}`;
      process.stdout.write(`\r  [${counter}] ${pageUrl.slice(0, 80).padEnd(80)}`);
    },
  });

  console.log(`\n\n  Crawled ${pages.length} pages. Saving to cache...`);
  persistPages(db, source.id, pages);

  console.log(`  Generating embeddings with ${config.embeddingModel}...`);
  const chunkCount = await indexSource(db, source.id, pages, {
    embeddingModel: config.embeddingModel,
    onProgress(done, total) {
      process.stdout.write(`\r  Embedding chunks: ${done}/${total}`);
    },
  });

  markSourceCrawled(db, source.id);
  console.log(`\n\n  Done! Indexed ${chunkCount} chunks from ${pages.length} pages.`);
  console.log(`  Run: bun run index.ts chat ${name}\n`);
  db.close();
}

function persistPages(db: Database, sourceId: number, pages: { url: string; title: string; content: string }[]) {
  for (const page of pages) {
    upsertPage(db, {
      source_id: sourceId,
      url: page.url,
      title: page.title,
      content: page.content,
      crawled_at: new Date().toISOString(),
    });
  }
}

async function answerFromDocs(db: Database, source: DocSource, question: string): Promise<void> {
  const results = await searchChunks(db, source.id, question, { embeddingModel: config.embeddingModel });

  if (results.length === 0) {
    console.log("  No relevant documentation found for your question.");
    return;
  }

  const systemPrompt = buildSystemPrompt(source.name, results);
  await chat(config.chatModel, systemPrompt, question);
}

async function cmdAsk(name: string, question: string) {
  await requireModel(config.chatModel);

  const db = getDb();
  const source = requireSource(db, name);

  console.log(`\n  [${config.chatModel} | searching ${name} docs]\n`);
  await answerFromDocs(db, source, question);
  db.close();
}

async function cmdChat(name: string) {
  await requireModel(config.chatModel);

  const db = getDb();
  const source = requireSource(db, name);
  const pageCount = getPages(db, source.id).length;

  console.log(`\n  Chat with "${name}" docs (${pageCount} pages indexed)`);
  console.log(`  Model: ${config.chatModel} | Type "exit" to quit\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const loop = () => {
    rl.question("You: ", async (input) => {
      const question = input.trim();

      if (!question || question === "exit" || question === "quit") {
        console.log("\n  Goodbye!\n");
        rl.close();
        db.close();
        return;
      }

      process.stdout.write("\nAssistant: ");
      await answerFromDocs(db, source, question);
      console.log();
      loop();
    });
  };

  loop();
}

async function cmdList() {
  const db = getDb();
  const sources = listSources(db);

  if (sources.length === 0) {
    console.log("\n  No documentation sources indexed yet.");
    console.log("  Run: bun run index.ts crawl <name> <url>\n");
    db.close();
    return;
  }

  console.log("\n  Indexed documentation sources:\n");
  for (const src of sources) {
    const pageCount = getPages(db, src.id).length;
    const chunkCount = countChunks(db, src.id);
    console.log(`  ${src.name}`);
    console.log(`    URL:     ${src.base_url}`);
    console.log(`    Pages:   ${pageCount}`);
    console.log(`    Chunks:  ${chunkCount}`);
    console.log(`    Crawled: ${src.last_crawled_at || "never"}\n`);
  }
  db.close();
}

async function cmdStatus(name: string) {
  const db = getDb();
  const source = requireSource(db, name);
  const pages = getPages(db, source.id);
  const chunkCount = countChunks(db, source.id);
  const totalKb = pages.reduce((sum, p) => sum + p.content.length, 0) / 1024;

  console.log(`\n  Source:        ${source.name}`);
  console.log(`  URL:           ${source.base_url}`);
  console.log(`  Pages:         ${pages.length}`);
  console.log(`  Chunks:        ${chunkCount}`);
  console.log(`  Total content: ${totalKb.toFixed(0)} KB`);
  console.log(`  Last crawled:  ${source.last_crawled_at || "never"}`);
  console.log(`  Created:       ${source.created_at}\n`);
  db.close();
}

async function cmdDelete(name: string) {
  const db = getDb();
  const source = requireSource(db, name);
  deleteSource(db, source.id);
  console.log(`\n  Deleted "${name}" and all cached data.\n`);
  db.close();
}

async function cmdRecrawl(name: string, maxPages: number) {
  const db = getDb();
  const source = requireSource(db, name);
  db.close();
  await cmdCrawl(name, source.base_url, maxPages);
}

function printHelp() {
  console.log(`
  doc-oracle — Local documentation AI

  Usage:
    bun run index.ts <command> [options]

  Commands:
    crawl <name> <url> [--max-pages=N|--all]  Crawl & index a documentation site
    ask <name> <question>                Ask a question about indexed docs
    chat <name>                          Interactive chat mode
    list                                 List all indexed sources
    status <name>                        Show stats for a source
    delete <name>                        Delete a source and its cache
    recrawl <name>                       Re-crawl and re-index a source

  Environment:
    DOC_ORACLE_MODEL          LLM model (default: llama3.2)
    DOC_ORACLE_EMBED_MODEL    Embedding model (default: nomic-embed-text)
    OLLAMA_URL                Ollama base URL (default: http://localhost:11434)

  Examples:
    bun run index.ts crawl typo3 https://docs.typo3.org/
    bun run index.ts ask typo3 "How do I create a custom content element?"
    bun run index.ts chat typo3
`);
}

const args = process.argv.slice(2);
const command = args[0];

const commands: Record<string, () => Promise<void>> = {
  crawl: async () => {
    if (!args[1] || !args[2]) die("Usage: bun run index.ts crawl <name> <url> [--max-pages=N]");
    await cmdCrawl(args[1], args[2], parseMaxPages(args));
  },
  ask: async () => {
    const question = args.slice(2).join(" ");
    if (!args[1] || !question) die("Usage: bun run index.ts ask <name> <question>");
    await cmdAsk(args[1], question);
  },
  chat: async () => {
    if (!args[1]) die("Usage: bun run index.ts chat <name>");
    await cmdChat(args[1]);
  },
  list: cmdList,
  status: async () => {
    if (!args[1]) die("Usage: bun run index.ts status <name>");
    await cmdStatus(args[1]);
  },
  delete: async () => {
    if (!args[1]) die("Usage: bun run index.ts delete <name>");
    await cmdDelete(args[1]);
  },
  recrawl: async () => {
    if (!args[1]) die("Usage: bun run index.ts recrawl <name>");
    await cmdRecrawl(args[1], parseMaxPages(args));
  },
};

const handler = commands[command ?? ""];
if (handler) {
  await handler();
} else {
  printHelp();
}
