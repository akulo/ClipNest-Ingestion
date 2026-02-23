# ClipNest-Ingestion

A TypeScript/Node.js service that monitors the `clipnest_videos` Supabase table for new rows and automatically enriches them with transcript, metadata, AI analysis, and vector embeddings.

Two deployment modes are available — a long-running Node.js process and a serverless Supabase Edge Function.

## How It Works

1. **Startup**: Scans for existing rows with `transcript_text IS NULL` and processes them.
2. **Realtime**: Subscribes to Supabase Postgres CDC for `INSERT` events on `clipnest_videos`.
3. **Pipeline** (per video):
   - Fetches transcript + metadata via [ScrapeCreators](https://scrapecreators.com) (YouTube, TikTok, Instagram)
   - Enriches with OpenAI `gpt-4o-mini`: summary, sentiment, tags, categories
   - Generates a 1536-dim vector embedding via `text-embedding-3-small`
   - Updates all columns in the Supabase row

## Project Structure

```
src/
  index.ts        — Entry point: startup scan + Supabase Realtime listener
  processor.ts    — Pipeline orchestration per video
  scraper.ts      — ScrapeCreators API client (YouTube, TikTok, Instagram)
  enricher.ts     — OpenAI enrichment + embeddings
  types.ts        — Shared interfaces
  clipnest_videos.sql — DB schema reference

supabase/
  functions/
    process-video/
      index.ts    — Deno Edge Function (same pipeline, triggered by Database Webhook)
```

## Option A — Node.js Long-Running Process

### Prerequisites

- Node.js 18+
- A Supabase project with the `clipnest_videos` table (see `src/clipnest_videos.sql`)
- API keys for Supabase, ScrapeCreators, and OpenAI

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.local.example .env.local
# Fill in your keys

# 3. Run
npm start
```

### Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (bypasses RLS) |
| `SCRAPECREATORS_API_KEY` | ScrapeCreators API key |
| `OPENAI_API_KEY` | OpenAI API key |

The service logs progress per video and runs indefinitely until interrupted with `Ctrl+C`. Logs are also written to `logs/app-YYYY-MM-DD.log`.

---

## Option B — Supabase Edge Function (Serverless)

The Edge Function `supabase/functions/process-video/index.ts` runs the same pipeline serverlessly, triggered by a Supabase Database Webhook on every INSERT into `clipnest_videos`. No process needs to stay running.

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- Logged in: `supabase login` (get your access token from [supabase.com](https://supabase.com) → Account → Access Tokens)

### Deploy

```bash
# Link to your Supabase project (first time only)
supabase link --project-ref <your-project-ref>

# Deploy the function
supabase functions deploy process-video

# Set required secrets
supabase secrets set \
  SCRAPECREATORS_API_KEY=<your-key> \
  OPENAI_API_KEY=<your-key> \
  SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

### Configure the Database Webhook

In the Supabase Dashboard → **Database → Webhooks → Create a new hook**:

| Field | Value |
|---|---|
| Name | `process-video` |
| Table | `clipnest_videos` |
| Events | INSERT |
| Type | HTTP Request (POST) |
| URL | `https://<project-ref>.supabase.co/functions/v1/process-video` |
| Header: `Authorization` | `Bearer <your-anon-key>` |

Find your values:
- **Project ref**: Dashboard → Settings → General → Reference ID
- **Anon key**: Dashboard → Settings → API → `anon public`

### Verify

1. Insert a test row into `clipnest_videos` with a `video_url` and `transcript_text = null`
2. Check logs: Dashboard → Edge Functions → `process-video` → Logs
3. Confirm the row is updated with transcript, summary, sentiment, tags, categories, and embedding

---

## Supported Platforms

| Platform | URL pattern |
|---|---|
| YouTube | `youtube.com/watch`, `youtu.be` |
| YouTube Shorts | `youtube.com/shorts/` |
| TikTok | `tiktok.com` |
| Instagram | `instagram.com` |
