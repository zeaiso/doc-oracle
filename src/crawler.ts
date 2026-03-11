import * as cheerio from "cheerio";
import { config } from "./config";
import type { CrawlResult } from "./types";

const NOISE_SELECTORS = "script, style, nav, footer, header, .sidebar, .navigation, .breadcrumb, .toc, [role=navigation]";
const CONTENT_SELECTORS = ["main", "article", '[role="main"]', ".content", ".rst-content", ".document", "#content"];
const USER_AGENT = "DocOracle/1.0 (local documentation indexer)";

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isHtmlResponse(resp: Response): boolean {
  return resp.headers.get("content-type")?.includes("text/html") ?? false;
}

function extractTitle($: cheerio.CheerioAPI, fallbackUrl: string): string {
  return $("title").text().trim() || $("h1").first().text().trim() || fallbackUrl;
}

function extractContent($: cheerio.CheerioAPI): string {
  $(NOISE_SELECTORS).remove();

  const contentEl = findMainContent($);
  const textSource = contentEl || $("body");

  return textSource
    .text()
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findMainContent($: cheerio.CheerioAPI): cheerio.Cheerio<any> | null {
  for (const selector of CONTENT_SELECTORS) {
    const el = $(selector);
    if (el.length && el.text().trim().length > 100) return el;
  }
  return null;
}

function extractSameDomainLinks($: cheerio.CheerioAPI, pageUrl: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links: string[] = [];

  $("a[href]").each((_, el) => {
    try {
      const href = $(el).attr("href")!;
      const resolved = new URL(href, pageUrl);

      if (resolved.origin !== base.origin) return;
      if (!resolved.pathname.startsWith(base.pathname)) return;

      resolved.hash = "";
      resolved.search = "";
      const clean = normalizeUrl(resolved.toString());

      if (!links.includes(clean)) links.push(clean);
    } catch {}
  });

  return links;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(config.crawlTimeout),
    });

    if (!resp.ok || !isHtmlResponse(resp)) return null;
    return resp.text();
  } catch {
    return null;
  }
}

export async function crawlPage(url: string, baseUrl: string): Promise<CrawlResult | null> {
  const html = await fetchPage(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const title = extractTitle($, url);
  const content = extractContent($);
  const links = extractSameDomainLinks($, url, baseUrl);

  if (content.length < config.minContentLength) return null;

  return { url, title, content, links };
}

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  onPage?: (url: string, current: number, max: number) => void;
}

export async function crawlSite(baseUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult[]> {
  const maxPages = opts.maxPages ?? config.defaultMaxPages;
  const concurrency = opts.concurrency ?? config.defaultConcurrency;

  const visited = new Set<string>();
  const queue: string[] = [normalizeUrl(baseUrl)];
  const results: CrawlResult[] = [];

  while (queue.length > 0 && results.length < maxPages) {
    const batch = takeBatch(queue, concurrency, visited);
    const pages = await Promise.all(batch.map((u) => crawlPage(u, baseUrl)));

    for (const page of pages) {
      if (!page) continue;

      results.push(page);
      opts.onPage?.(page.url, results.length, maxPages);
      enqueueNewLinks(queue, page.links, visited);
    }
  }

  return results;
}

function takeBatch(queue: string[], size: number, visited: Set<string>): string[] {
  const batch: string[] = [];

  while (batch.length < size && queue.length > 0) {
    const url = normalizeUrl(queue.shift()!);
    if (visited.has(url)) continue;
    visited.add(url);
    batch.push(url);
  }

  return batch;
}

function enqueueNewLinks(queue: string[], links: string[], visited: Set<string>): void {
  for (const link of links) {
    const normalized = normalizeUrl(link);
    if (!visited.has(normalized) && !queue.includes(normalized)) {
      queue.push(normalized);
    }
  }
}
