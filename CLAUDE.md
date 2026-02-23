# ClipNest-Ingestion — Claude Instructions

## Project Overview
Supabase Edge Function pipeline that enriches new `clipnest_videos` rows with transcript, metadata, AI analysis, and vector embeddings.

## Architecture

### Edge Functions (`supabase/functions/`)
Multi-function chain triggered by a Supabase Database Webhook on INSERT into `clipnest_videos`:

```
DB Webhook (INSERT)
  └─► ingest-router         — detect platform, fan out to scraper
        ├─► scrape-youtube  — fetch YouTube/Shorts data, call enrich-video
        ├─► scrape-tiktok   — fetch TikTok data, call enrich-video
        └─► scrape-instagram— fetch Instagram data, call enrich-video
                                  └─► enrich-video — OpenAI enrichment + embedding + DB update
```

- `supabase/functions/ingest-router/index.ts` — receives webhook, routes to scraper by platform
- `supabase/functions/scrape-youtube/index.ts` — fetches YouTube/Shorts transcript + metadata
- `supabase/functions/scrape-tiktok/index.ts` — fetches TikTok transcript + metadata
- `supabase/functions/scrape-instagram/index.ts` — fetches Instagram transcript + metadata
- `supabase/functions/enrich-video/index.ts` — OpenAI enrichment, embedding, DB update
- `supabase/functions/_shared/types.ts` — shared interfaces: `VideoData`, `EnrichmentResult`, `ScraperPayload`, `EnricherPayload`
- `supabase/functions/_shared/utils.ts` — shared helpers: `detectPlatform`, `normalizeUrl`, `apiFetch`, `callFunction`
- `supabase/functions/_shared/deno.d.ts` — ambient Deno globals for VS Code IntelliSense
- `supabase/functions/process-video/index.ts` — legacy monolithic function (keep until new chain is verified in production)

Inter-function calls use `fetch` to `${SUPABASE_URL}/functions/v1/<name>` with `Authorization: Bearer <SUPABASE_ANON_KEY>`. Both `SUPABASE_URL` and `SUPABASE_ANON_KEY` are auto-injected.

## Key Conventions
- Edge Function imports use `.ts` extension (Deno requirement)
- ScrapeCreators API header: `x-api-key`
- Embedding stored as `JSON.stringify(number[])` in Supabase `vector` column (1536 dims)
- `npm:` specifiers used for third-party packages (e.g. `npm:openai`, `npm:@supabase/supabase-js`)

## Environment Variables (set via `supabase secrets set`)
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Auto-available in Edge Functions |
| `SUPABASE_ANON_KEY` | Auto-available in Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — used only by `enrich-video` for DB writes |
| `SCRAPECREATORS_API_KEY` | ScrapeCreators API key — used by scraper functions |
| `OPENAI_API_KEY` | OpenAI API key — used by `enrich-video` |

## DB Schema Highlights (`sql/clipnest_videos.sql`)
- `id` (uuid), `video_url`, `platform`, `normalized_url`, `creator`, `title`, `summary`, `sentiment`
- `tags` (text[]), `categories` (text[]), `transcript_text`, `transcript_url`, `transcript_preview`
- `embedding` (extensions.vector — 1536 dims), `published`, `source` (default `'replit'`)

## Deploying Edge Functions

### One-time setup
```bash
supabase link --project-ref <project-ref>
supabase secrets set SCRAPECREATORS_API_KEY=... OPENAI_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=...
```

### Deploy all functions
```bash
npm run deploy
# or directly:
bash supabase/deploy.sh
```

### Deploy a single function
```bash
supabase functions deploy <function-name>
```

### Logs
```bash
npm run logs:router   # tail ingest-router
npm run logs:enrich   # tail enrich-video
supabase functions logs <name> --tail
```

### Webhook target
Point the Supabase Database Webhook to:
`https://<project-ref>.supabase.co/functions/v1/ingest-router`
with header `Authorization: Bearer <anon-key>`.

## Verification
1. Insert a row with a YouTube URL → check logs: `ingest-router`, `scrape-youtube`, `enrich-video`
2. Confirm DB row is fully enriched (transcript, summary, embedding populated)
3. Repeat for TikTok and Instagram URLs
4. Test no-transcript path: use a URL that returns no transcript → partial update only
