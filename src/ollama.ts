import chalk from "chalk";
import { config } from "./config";
import { renderMarkdown } from "./render";
import type { HealthCheck } from "./types";

function ollamaUrl(path: string): string {
  return `${config.ollamaUrl}${path}`;
}

function extractModelName(fullName: string): string {
  return fullName.split(":")[0] ?? fullName;
}

async function fetchAvailableModels(): Promise<string[]> {
  const resp = await fetch(ollamaUrl("/api/tags"));
  if (!resp.ok) throw new Error("Ollama not reachable");
  const data = (await resp.json()) as { models: { name: string }[] };
  return data.models.map((m) => extractModelName(m.name));
}

export async function embed(text: string, model = config.embeddingModel): Promise<number[]> {
  const resp = await fetch(ollamaUrl("/api/embed"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama embed failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  const embedding = data.embeddings[0];
  if (!embedding) throw new Error("Ollama returned empty embedding");
  return embedding;
}

function showSpinner(): { stop: () => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${chalk.cyan(frames[i++ % frames.length])} Thinking...`);
  }, 80);

  return {
    stop() {
      clearInterval(interval);
      process.stdout.write("\r" + " ".repeat(20) + "\r");
    },
  };
}

async function streamToTerminal(resp: Response): Promise<string> {
  let full = "";
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { message?: { content: string }; done: boolean };
        if (parsed.message?.content) {
          full += parsed.message.content;
          process.stdout.write(parsed.message.content);
        }
      } catch {}
    }
  }

  process.stdout.write("\n");
  return full;
}

export async function chat(
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const resp = await fetch(ollamaUrl("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama chat failed (${resp.status}): ${body}`);
  }

  const raw = await streamToTerminal(resp);
  return raw;
}

export async function checkModel(model: string): Promise<HealthCheck> {
  try {
    const available = await fetchAvailableModels();
    const requested = extractModelName(model);

    if (!available.includes(requested)) {
      return {
        ok: false,
        error: `Model "${model}" not found. Available: ${available.join(", ")}. Run: ollama pull ${model}`,
      };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: `Cannot connect to Ollama at ${config.ollamaUrl}. Is it running?` };
  }
}
