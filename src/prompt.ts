import type { SearchResult } from "./types";

function formatContext(results: SearchResult[]): string {
  return results
    .map((r) => `[Source: ${r.pageUrl}]\n${r.content}`)
    .join("\n\n---\n\n");
}

export function buildSystemPrompt(sourceName: string, results: SearchResult[]): string {
  const context = formatContext(results);

  return `You are a documentation assistant for "${sourceName}".
You answer questions ONLY based on the provided documentation excerpts below.
If the answer is not found in the documentation, say "I couldn't find this in the ${sourceName} documentation."
Do NOT use any knowledge outside the provided documentation.
Always cite the source URL when possible.

DOCUMENTATION CONTEXT:
${context}`;
}
