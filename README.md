# doc-oracle

A local documentation RAG (Retrieval-Augmented Generation) tool. Crawl any documentation website, index it locally, and ask a local LLM questions that it answers **only** from that documentation — no hallucinations from general training data.

Everything runs on your machine. No API keys. No cloud. No data leaves your system.

## How it works

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Crawl   │────>│  Cache   │────>│  Embed   │────>│  Query   │
│  website │     │  pages   │     │  chunks  │     │  with AI │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                   SQLite           Ollama            Ollama
```

1. **Crawl** — Fetches all pages from a documentation site, staying within the same domain and path prefix. Extracts clean text content, strips navigation/headers/footers.
2. **Cache** — Stores every crawled page in a local SQLite database. Re-crawling updates the cache.
3. **Embed** — Splits page content into overlapping text chunks and generates vector embeddings via Ollama.
4. **Query** — Finds the most relevant chunks using cosine similarity, then passes only those to the LLM with strict instructions to answer solely from the provided documentation.

## Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [Ollama](https://ollama.com) running locally

### Install Ollama and pull models

You need **two** models: one for chat (answering questions) and one for embeddings (indexing docs). Both are required.

```bash
# macOS
brew install ollama

# Start the Ollama server
ollama serve

# Pull BOTH models (in another terminal) — both are required
ollama pull llama3.2          # Chat model for answering questions (~2GB)
ollama pull nomic-embed-text  # Embedding model for indexing docs (~274MB)
```

> **Important:** `nomic-embed-text` is only used for generating embeddings — it cannot answer questions. You need `llama3.2` (or another chat model) for the `ask` and `chat` commands. Without it you'll get a "Model not found" error.

You can swap these for any Ollama-compatible models. See [Configuration](#configuration) below.

## Getting started

```bash
# Install
bun install

# Crawl a documentation site
bun run index.ts crawl nextjs https://nextjs.org/docs

# Ask a single question
bun run index.ts ask nextjs "How do I set up dynamic routes?"

# Or start an interactive chat session
bun run index.ts chat nextjs
```

## Commands

| Command | Description |
|---------|-------------|
| `crawl <name> <url> [--max-pages=N\|--all]` | Crawl a documentation site and index it |
| `ask <name> <question>` | Ask a one-off question against indexed docs |
| `chat <name>` | Interactive chat session with a doc source |
| `list` | List all indexed documentation sources |
| `status <name>` | Show detailed stats for a source |
| `delete <name>` | Delete a source and all its cached data |
| `recrawl <name>` | Re-crawl and re-index an existing source |

## Examples

Index any documentation site you work with — each source is completely isolated, so the AI only answers from that specific source's docs.

```bash
# Frontend frameworks
bun run index.ts crawl nextjs https://nextjs.org/docs
bun run index.ts crawl react https://react.dev/reference/
bun run index.ts crawl vue https://vuejs.org/guide/
bun run index.ts crawl svelte https://svelte.dev/docs
bun run index.ts crawl angular https://angular.dev/overview

# CSS frameworks
bun run index.ts crawl tailwind https://tailwindcss.com/docs/

# Backend frameworks
bun run index.ts crawl laravel https://laravel.com/docs/
bun run index.ts crawl django https://docs.djangoproject.com/en/5.1/
bun run index.ts crawl nestjs https://docs.nestjs.com/

# CMS platforms
bun run index.ts crawl drupal https://www.drupal.org/docs/
bun run index.ts crawl typo3 https://docs.typo3.org/
bun run index.ts crawl wordpress https://developer.wordpress.org/

# Infrastructure & tools
bun run index.ts crawl docker https://docs.docker.com/
bun run index.ts crawl kubernetes https://kubernetes.io/docs/
bun run index.ts crawl terraform https://developer.hashicorp.com/terraform/docs

# Crawl everything on larger doc sites
bun run index.ts crawl laravel https://laravel.com/docs/ --all
```

```bash
# Ask questions scoped to a specific source
bun run index.ts ask nextjs "How does the App Router work?"
bun run index.ts ask laravel "How do I define a many-to-many relationship?"
bun run index.ts ask tailwind "How do I customize the color palette?"
bun run index.ts ask drupal "How do I create a custom module?"
bun run index.ts ask docker "What is the difference between CMD and ENTRYPOINT?"

# Interactive chat
bun run index.ts chat django

# Manage your sources
bun run index.ts list
bun run index.ts status laravel
bun run index.ts recrawl nextjs
bun run index.ts delete vue
```

## Configuration

All configuration is done via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DOC_ORACLE_MODEL` | `llama3.2` | Ollama model for chat responses |
| `DOC_ORACLE_EMBED_MODEL` | `nomic-embed-text` | Ollama model for embeddings |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |

```bash
# Use a different chat model
DOC_ORACLE_MODEL=mistral bun run index.ts chat laravel

# Use a remote Ollama instance
OLLAMA_URL=http://192.168.1.100:11434 bun run index.ts chat nextjs
```

### Recommended models

| Model | Size | Notes |
|-------|------|-------|
| `llama3.2` | ~2GB | Good balance of speed and quality (default) |
| `llama3.2:1b` | ~1.3GB | Faster, lower quality |
| `mistral` | ~4GB | Strong reasoning |
| `gemma2` | ~5GB | Good for technical docs |
| `qwen2.5` | ~4.7GB | Strong multilingual support |

## Project structure

```
src/
  config.ts     Configuration constants
  types.ts      Shared type definitions
  crawler.ts    Web crawler — fetches pages, extracts text, follows links
  store.ts      SQLite storage layer — pages, chunks, embeddings
  indexer.ts    Text chunking and embedding generation
  search.ts     Vector similarity search over stored embeddings
  ollama.ts     Ollama API client — embeddings and chat
  prompt.ts     System prompt construction for the LLM
index.ts        CLI entry point and command routing
```

## How the RAG pipeline works

### Crawling

The crawler starts from the given URL and follows links that stay within the same origin and path prefix. For example, crawling `https://laravel.com/docs/` will only follow links under that path — it won't wander into the Laravel marketing site or blog.

It uses [cheerio](https://cheerio.js.org/) to parse HTML and extracts the main content area (looking for `<main>`, `<article>`, `[role="main"]`, `.content`, etc.), stripping out navigation, sidebars, footers, and other noise.

### Chunking

Each page's text content is split into overlapping chunks (~1000 characters with 200 character overlap). The chunker tries to break at sentence boundaries to preserve context. This overlap ensures that information spanning chunk boundaries isn't lost.

### Embedding & Search

Each chunk is converted to a vector embedding using Ollama's embedding API (`nomic-embed-text` by default). When you ask a question, your question is also embedded, and the system finds the most similar chunks using cosine similarity. The top 8 most relevant chunks are passed as context to the LLM.

### Answering

The LLM receives a system prompt that strictly constrains it to answer only from the provided documentation excerpts. It will say "I couldn't find this in the documentation" if the answer isn't in the provided context, and cites source URLs when possible.

## Data storage

All data is stored locally in `.doc-oracle/store.db` (SQLite). This directory is created in your current working directory. Add `.doc-oracle` to your `.gitignore`.

The database contains:
- **sources** — Registered documentation endpoints (name, URL, timestamps)
- **pages** — Cached HTML content for each crawled page
- **chunks** — Text chunks with their vector embeddings (stored as BLOBs)

## License

MIT
