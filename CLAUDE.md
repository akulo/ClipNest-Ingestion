# ClipNest-Ingestion — Claude Instructions

## Project Overview
TypeScript/Node.js service that monitors `clipnest_videos` Supabase table and enriches new rows with transcript, metadata, AI analysis, and vector embeddings.

## Architecture

### Node.js Service (`src/`)
- `src/types.ts` — `ClipNestVideo`, `VideoData`, `EnrichmentResult` interfaces
- `src/scraper.ts` — ScrapeCreators API client (YouTube, TikTok, Instagram)
- `src/enricher.ts` — OpenAI `gpt-4o-mini` enrichment + `text-embedding-3-small` embeddings
- `src/processor.ts` — Pipeline orchestration per video
- `src/index.ts` — Entry point: startup scan + Supabase Realtime listener + file logging

### Edge Function (`supabase/functions/process-video/`)
- `supabase/functions/process-video/index.ts` — Deno-based Edge Function, all logic self-contained (no multi-file imports)
- Triggered by a Supabase Database Webhook on INSERT into `clipnest_videos`
- Same pipeline as the Node.js service

## Key Conventions
- Package type: ESM (`"type": "module"`) — all imports use `.js` extension
- `tsconfig`: NodeNext module resolution
- Run: `npm start` (uses `--env-file=.env.local`)
- ScrapeCreators API header: `x-api-key`
- Embedding stored as `JSON.stringify(number[])` in Supabase `vector` column (1536 dims)
- On startup: processes rows where `transcript_text IS NULL AND video_url IS NOT NULL`
- Realtime: subscribes to `INSERT` events on `clipnest_videos`; polls every 30s as fallback

## Environment Variables

### Node.js service (`.env.local`)
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Service role key |
| `SCRAPECREATORS_API_KEY` | ScrapeCreators API key |
| `OPENAI_API_KEY` | OpenAI API key |

### Edge Function (set via `supabase secrets set`)
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Auto-available in Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (note: different name from Node.js var) |
| `SCRAPECREATORS_API_KEY` | ScrapeCreators API key |
| `OPENAI_API_KEY` | OpenAI API key |

## DB Schema Highlights (`src/clipnest_videos.sql`)
- `id` (uuid), `video_url`, `platform`, `normalized_url`, `creator`, `title`, `summary`, `sentiment`
- `tags` (text[]), `categories` (text[]), `transcript_text`, `transcript_url`, `transcript_preview`
- `embedding` (extensions.vector — 1536 dims), `published`, `source` (default `'replit'`)

## Deno vs Node.js (Edge Function differences)
| Node.js | Edge Function |
|---|---|
| `process.env.X` | `Deno.env.get("X")` |
| `import ... from "openai"` | `import OpenAI from "npm:openai"` |
| `import { createClient } from "@supabase/supabase-js"` | `import { createClient } from "npm:@supabase/supabase-js"` |
| module entry | `Deno.serve(async (req) => { ... })` |

## Edge Function TypeScript Diagnostics
The VS Code TypeScript errors in `supabase/functions/process-video/index.ts` (`Cannot find name 'Deno'`, `Cannot find module 'npm:...'`) are **false positives** — the Node.js tsconfig doesn't know about Deno. The code is correct and deploys fine. Install the Deno VS Code extension and enable it for `supabase/functions/` to resolve them.

## Deploying the Edge Function
```bash
supabase link --project-ref <project-ref>
supabase functions deploy process-video
supabase secrets set SCRAPECREATORS_API_KEY=... OPENAI_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=...
```
Then create a Database Webhook in the Supabase Dashboard pointing to:
`https://<project-ref>.supabase.co/functions/v1/process-video`
with header `Authorization: Bearer <anon-key>`.
