import type { SearchResult } from "./types";

function formatContext(results: SearchResult[]): string {
  return results
      .map((r) => `[Source: ${r.pageUrl}]\n${r.content}`)
      .join("\n\n---\n\n");
}

export function buildSystemPrompt(sourceName: string, results: SearchResult[]): string {
  const context = formatContext(results);

  return `You are a documentation assistant for "${sourceName}".
Answer questions based on the provided documentation excerpts below.
Use the documentation as your primary source of truth. You may reason about and synthesize information from multiple excerpts to form a complete answer.
If the documentation excerpts don't contain enough information, say what you did find and note what's missing.
Always cite the source URL when referencing specific information.
Be thorough — if the user asks for a list or overview, include everything relevant from the excerpts.

DOCUMENTATION CONTEXT:
${context}`;
}
