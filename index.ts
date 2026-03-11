#!/usr/bin/env bun
import { config } from "./src/config";
import { getDb, upsertSource, findSourceByName, findSourcesByPrefix, listSources, deleteSource, upsertPage, getPages, countChunks, markSourceCrawled } from "./src/store";
import { crawlSite } from "./src/crawler";
import { indexSource } from "./src/indexer";
import { searchChunks, searchChunksMulti } from "./src/search";
import { chat, checkModel } from "./src/ollama";
import { buildSystemPrompt } from "./src/prompt";
import { discoverVersions, buildVersionUrl } from "./src/versions";
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

function parseVersion(args: string[]): string | undefined {
  const flag = args.find((a) => a.startsWith("--version=") || a.startsWith("--version "));
  if (flag) return flag.split("=")[1];
  const idx = args.indexOf("--version");
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function parseVersionsList(args: string[]): string[] | "all" | undefined {
  const flag = args.find((a) => a.startsWith("--versions="));
  if (flag) {
    const val = flag.split("=")[1]!;
    return val === "all" ? "all" : val.split(",");
  }
  const idx = args.indexOf("--versions");
  if (idx !== -1 && args[idx + 1]) {
    const val = args[idx + 1]!;
    return val === "all" ? "all" : val.split(",");
  }
  return undefined;
}

function resolveSources(db: Database, name: string, version?: string): DocSource[] {
  if (version) {
    const source = findSourceByName(db, `${name}@${version}`);
    if (source) return [source];
    die(`Source "${name}@${version}" not found. Run: bun run index.ts list`);
  }

  const exact = findSourceByName(db, name);
  if (exact) return [exact];

  const versioned = findSourcesByPrefix(db, name);
  if (versioned.length > 0) return versioned;

  die(`Source "${name}" not found. Run: bun run index.ts list`);
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

async function answerFromDocs(db: Database, sources: DocSource[], question: string): Promise<void> {
  const sourceIds = sources.map((s) => s.id);
  const results = await searchChunksMulti(db, sourceIds, question, { embeddingModel: config.embeddingModel });

  if (results.length === 0) {
    console.log("  No relevant documentation found for your question.");
    return;
  }

  const displayName = sources.length === 1 ? sources[0]!.name : sources[0]!.name.split("@")[0]!;
  const systemPrompt = buildSystemPrompt(displayName, results);
  await chat(config.chatModel, systemPrompt, question);
}

async function cmdAsk(name: string, question: string, version?: string) {
  await requireModel(config.chatModel);

  const db = getDb();
  const sources = resolveSources(db, name, version);
  const label = version ? `${name}@${version}` : name;

  console.log(`\n  [${config.chatModel} | searching ${label} docs (${sources.length} source${sources.length > 1 ? "s" : ""})]\n`);
  await answerFromDocs(db, sources, question);
  db.close();
}

async function cmdChat(name: string, version?: string) {
  await requireModel(config.chatModel);

  const db = getDb();
  const sources = resolveSources(db, name, version);
  const totalPages = sources.reduce((sum, s) => sum + getPages(db, s.id).length, 0);
  const label = version ? `${name}@${version}` : name;
  const versionInfo = sources.length > 1 ? ` across ${sources.length} versions` : "";

  console.log(`\n  Chat with "${label}" docs (${totalPages} pages indexed${versionInfo})`);
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

      console.log();
      await answerFromDocs(db, sources, question);
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

async function cmdCrawlVersions(name: string, url: string, versions: string[] | "all" | undefined, maxPages: number) {
  const allVersions = await discoverVersions(url);

  if (allVersions.length === 0) {
    die("Could not discover versions. This command currently supports docs.typo3.org URLs.");
  }

  if (!versions) {
    console.log(`\n  Available versions for ${name}:\n`);
    for (const v of allVersions) {
      console.log(`    ${v.version.padEnd(10)} ${v.url}`);
    }
    console.log(`\n  To crawl, run:`);
    console.log(`    bun run index.ts crawl-versions ${name} ${url} --versions all`);
    console.log(`    bun run index.ts crawl-versions ${name} ${url} --versions main,12.2,11.0\n`);
    return;
  }

  const selected = versions === "all"
    ? allVersions
    : allVersions.filter((v) => versions.includes(v.version));

  if (selected.length === 0) {
    const available = allVersions.map((v) => v.version).join(", ");
    die(`No matching versions found. Available: ${available}`);
  }

  console.log(`\n  Crawling ${selected.length} version${selected.length > 1 ? "s" : ""} of "${name}"...\n`);

  for (const v of selected) {
    const sourceName = `${name}@${v.version}`;
    console.log(`  --- ${sourceName} ---`);
    await cmdCrawl(sourceName, v.url, maxPages);
  }

  console.log(`  All done! ${selected.length} versions crawled.`);
  console.log(`  Run: bun run index.ts chat ${name}\n`);
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
    crawl <name> <url> [--max-pages=N|--all]      Crawl & index a documentation site
    crawl-versions <name> <url> [--versions ...]   Crawl multiple versions (TYPO3 docs)
    ask <name> <question> [--version X]            Ask a question about indexed docs
    chat <name> [--version X]                      Interactive chat mode
    list                                           List all indexed sources
    status <name>                                  Show stats for a source
    delete <name>                                  Delete a source and its cache
    recrawl <name>                                 Re-crawl and re-index a source

  Environment:
    DOC_ORACLE_MODEL          LLM model (default: llama3.2)
    DOC_ORACLE_EMBED_MODEL    Embedding model (default: nomic-embed-text)
    OLLAMA_URL                Ollama base URL (default: http://localhost:11434)

  Examples:
    bun run index.ts crawl typo3-news https://docs.typo3.org/p/georgringer/news/main/en-us/ --all
    bun run index.ts crawl-versions typo3-news https://docs.typo3.org/p/georgringer/news/main/en-us/ --versions all
    bun run index.ts crawl-versions typo3-news https://docs.typo3.org/p/georgringer/news/main/en-us/ --versions main,12.2
    bun run index.ts chat typo3-news                        Search all versions
    bun run index.ts chat typo3-news --version 12.2         Search only v12.2
    bun run index.ts ask typo3-news "How do plugins work?" --version main
`);
}

const args = process.argv.slice(2);
const command = args[0];

const commands: Record<string, () => Promise<void>> = {
  crawl: async () => {
    if (!args[1] || !args[2]) die("Usage: bun run index.ts crawl <name> <url> [--max-pages=N]");
    await cmdCrawl(args[1], args[2], parseMaxPages(args));
  },
  "crawl-versions": async () => {
    if (!args[1] || !args[2]) die("Usage: bun run index.ts crawl-versions <name> <url> [--versions all|v1,v2,...]");
    await cmdCrawlVersions(args[1], args[2], parseVersionsList(args), parseMaxPages(args));
  },
  ask: async () => {
    const version = parseVersion(args);
    const questionArgs = args.slice(2).filter((a) => !a.startsWith("--version"));
    const question = questionArgs.join(" ");
    if (!args[1] || !question) die("Usage: bun run index.ts ask <name> <question> [--version X]");
    await cmdAsk(args[1], question, version);
  },
  chat: async () => {
    if (!args[1]) die("Usage: bun run index.ts chat <name> [--version X]");
    await cmdChat(args[1], parseVersion(args));
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
