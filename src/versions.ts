import * as cheerio from "cheerio";

const USER_AGENT = "DocOracle/1.0 (local documentation indexer)";

export interface VersionInfo {
  version: string;
  url: string;
}

interface Typo3DocsPath {
  origin: string;
  vendor: string;
  package: string;
  version: string;
  locale: string;
}

function parseTypo3DocsUrl(baseUrl: string): Typo3DocsPath | null {
  try {
    const url = new URL(baseUrl);
    if (!url.hostname.endsWith("docs.typo3.org")) return null;

    const match = url.pathname.match(/^\/p\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!match) return null;

    return { origin: url.origin, vendor: match[1]!, package: match[2]!, version: match[3]!, locale: match[4]! };
  } catch {
    return null;
  }
}

export function buildVersionUrl(baseUrl: string, version: string): string | null {
  const parsed = parseTypo3DocsUrl(baseUrl);
  if (!parsed) return null;
  return `${parsed.origin}/p/${parsed.vendor}/${parsed.package}/${version}/${parsed.locale}/`;
}

export async function discoverVersions(baseUrl: string): Promise<VersionInfo[]> {
  const parsed = parseTypo3DocsUrl(baseUrl);
  if (!parsed) return [];

  const apiUrl = `${parsed.origin}/services/ajaxversions.php?url=/p/${parsed.vendor}/${parsed.package}/${parsed.version}/${parsed.locale}/`;

  try {
    const resp = await fetch(apiUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return [];

    const html = await resp.text();
    const $ = cheerio.load(html);
    const versions: VersionInfo[] = [];
    const pattern = new RegExp(`^/p/${parsed.vendor}/${parsed.package}/([^/]+)/${parsed.locale}/?$`);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")!;
      if (href.includes("singlehtml")) return;

      const m = href.match(pattern);
      if (m) {
        versions.push({
          version: m[1]!,
          url: `${parsed.origin}${href.replace(/\/?$/, "/")}`,
        });
      }
    });

    return versions;
  } catch {
    return [];
  }
}