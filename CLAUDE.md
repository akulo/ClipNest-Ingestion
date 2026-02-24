# ClipNest-Ingestion — Claude Instructions

## Project Overview
Supabase Edge Function pipeline that enriches new `clipnest_videos` rows with transcript, metadata, AI analysis, and vector embeddings.

## Architecture

### Edge Functions (`supabase/functions/`)
PGMQ-backed chain triggered by a Supabase Database Webhook on INSERT into `clipnest_videos`:

```
DB Webhook (INSERT)
  └─► ingest-router   — enqueue to scrape_jobs, wake scrape-worker
        └─► scrape-worker — scrape all platforms inline, enqueue to enrich_jobs, wake enrich-worker
                └─► enrich-worker — OpenAI enrichment + embedding + DB update, enqueue to geo_jobs, wake geo-worker
                        └─► geo-worker — Mapbox geocoding → lat/lng update
```

- `supabase/functions/ingest-router/index.ts` — receives webhook, enqueues to PGMQ, wakes scrape-worker
- `supabase/functions/scrape-worker/index.ts` — reads scrape_jobs, scrapes all platforms, enqueues to enrich_jobs
- `supabase/functions/enrich-worker/index.ts` — reads enrich_jobs, OpenAI enrichment + embedding + DB update, enqueues to geo_jobs
- `supabase/functions/geo-worker/index.ts` — reads geo_jobs, calls Mapbox Geocoding API, updates lat/lng
- `supabase/functions/_shared/types.ts` — shared interfaces: `VideoData`, `EnrichmentResult`, `ScraperPayload`, `EnricherPayload`, `GeoPayload`, `ProcessingStatus`, `QueueMessage`
- `supabase/functions/_shared/utils.ts` — shared helpers: `detectPlatform`, `normalizeUrl`, `apiFetch`, `callFunction`, `queueSend`, `queueRead`, `queueArchive`
- `supabase/functions/_shared/deno.d.ts` — ambient Deno globals for VS Code IntelliSense

Inter-function calls use `fetch` to `${SUPABASE_URL}/functions/v1/<name>` with `Authorization: Bearer <CLIPNEST_FUNCTION_KEY>`.

## Key Conventions
- Edge Function imports use `.ts` extension (Deno requirement)
- ScrapeCreators API header: `x-api-key`
- Embedding stored as `JSON.stringify(number[])` in Supabase `vector` column (1536 dims)
- `npm:` specifiers used for third-party packages (e.g. `npm:openai`, `npm:@supabase/supabase-js`)
- `SUPABASE_ANON_KEY` auto-injected by Supabase is the new `sb_publish_*` format — NOT a valid JWT for function invocation. Use `CLIPNEST_FUNCTION_KEY` (anon JWT) instead.

## Environment Variables (set via `supabase secrets set`)
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Auto-available in Edge Functions |
| `SUPABASE_ANON_KEY` | Auto-available but `sb_publish_*` format — not usable as JWT |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — used by workers for DB writes |
| `CLIPNEST_FUNCTION_KEY` | Anon JWT (`eyJ...`) for inter-function HTTP calls |
| `SCRAPECREATORS_API_KEY` | ScrapeCreators API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `MAPBOX_ACCESS_TOKEN` | Mapbox public token (`pk.eyJ...`) for geocoding |

## DB Schema Highlights (`sql/clipnest_videos.sql`)
- `id` (uuid), `video_url`, `platform`, `normalized_url`, `creator`, `title`, `summary`, `sentiment`
- `tags` (text[]), `categories` (text[]), `transcript_text`, `transcript_url`, `transcript_preview`
- `embedding` (extensions.vector — 1536 dims), `published`, `source` (default `'replit'`)
- `processing_status` (text) — `pending | scraping | enriching | done | failed`
- `processing_error` (text) — error message if failed
- `lat`, `lng` (double precision) — Mapbox geocoding result (nullable)

## Deploying Edge Functions

### One-time setup
```bash
supabase link --project-ref <project-ref>
supabase secrets set \
  SCRAPECREATORS_API_KEY=... \
  OPENAI_API_KEY=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  CLIPNEST_FUNCTION_KEY=eyJ...   # anon JWT from Dashboard → Project Settings → API
  MAPBOX_ACCESS_TOKEN=pk.eyJ...  # Mapbox public token
```

Also run `sql/pgmq_migration.sql` in the Supabase SQL Editor.

### Deploy all functions
```bash
npm run deploy
```

### Deploy a single function
```bash
supabase functions deploy <function-name>
```

### Logs
```bash
npm run logs:router   # tail ingest-router
npm run logs:scraper  # tail scrape-worker
npm run logs:enrich   # tail enrich-worker
npm run logs:geo      # tail geo-worker
supabase functions logs <name> --tail
```

### Webhook target
Point the Supabase Database Webhook to:
`https://<project-ref>.supabase.co/functions/v1/ingest-router`
with header `Authorization: Bearer <anon-key>`.

## Verification
1. Insert a row with a YouTube URL → check logs: `ingest-router`, `scrape-worker`, `enrich-worker`, `geo-worker`
2. Watch `processing_status`: `pending → scraping → enriching → done`
3. Confirm DB row is fully enriched (transcript, summary, embedding populated)
4. Check `lat`/`lng` populated if the video content mentions a specific venue/address
5. Test failure: bad URL → row shows `failed` + `processing_error`
