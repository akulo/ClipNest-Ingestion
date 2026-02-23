# ClipNest-Ingestion

A TypeScript/Node.js service that monitors the `clipnest_videos` Supabase table for new rows and automatically enriches them with transcript, metadata, AI analysis, and vector embeddings.

## How It Works

1. **Startup**: Scans for existing rows with `transcript_text IS NULL` and processes them.
2. **Realtime**: Subscribes to Supabase Postgres CDC for `INSERT` events on `clipnest_videos`.
3. **Pipeline** (per video):
   - Fetches transcript + metadata via [ScrapeCreators](https://scrapecreators.com) (YouTube, TikTok, Instagram)
   - Enriches with OpenAI `gpt-4o-mini`: summary, sentiment, tags, categories
   - Generates a 1536-dim vector embedding via `text-embedding-3-small`
   - Updates all columns in the Supabase row

## Prerequisites

- Node.js 18+
- A Supabase project with the `clipnest_videos` table (see `src/clipnest_videos.sql`)
- API keys for Supabase, ScrapeCreators, and OpenAI

## Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd ClipNest-Ingestion
npm install

# 2. Configure environment
cp .env.local .env
# Fill in your keys in .env

# 3. Run
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (bypasses RLS) |
| `SCRAPECREATORS_API_KEY` | ScrapeCreators API key |
| `OPENAI_API_KEY` | OpenAI API key |

## Running

```bash
npm start
# or directly:
npx tsx src/index.ts
```

The service logs progress per video and runs indefinitely until interrupted with `Ctrl+C`.
