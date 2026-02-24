# ClipNest-Ingestion

Supabase Edge Function pipeline that automatically enriches new `clipnest_videos` rows with transcript, metadata, AI analysis, and vector embeddings — triggered by a Database Webhook on every INSERT.

## Flow

```mermaid
flowchart TD
    DB[("clipnest_videos<br/>INSERT")]
    DB -->|Database Webhook| IR["ingest-router<br/>enqueue to scrape_jobs"]
    IR -->|wake| SW["scrape-worker<br/>ScrapeCreators API"]

    SW -->|youtube / shorts / tiktok / instagram| SC["Fetch transcript<br/>+ metadata"]
    SC -->|enqueue to enrich_jobs| EW["enrich-worker"]

    EW --> Q{"transcript<br/>found?"}
    Q -->|no| PU["Partial update<br/>status = done"]
    Q -->|yes| OAI["OpenAI gpt-4o-mini<br/>text-embedding-3-small"]
    OAI --> FU["Full update<br/>status = done"]

    classDef db        fill:#1e3a5f,stroke:#3b82f6,color:#fff
    classDef router    fill:#4c1d95,stroke:#8b5cf6,color:#fff
    classDef worker    fill:#134e4a,stroke:#14b8a6,color:#fff
    classDef enricher  fill:#7c2d12,stroke:#f97316,color:#fff
    classDef ai        fill:#713f12,stroke:#eab308,color:#fff
    classDef partial   fill:#374151,stroke:#9ca3af,color:#fff
    classDef full      fill:#14532d,stroke:#22c55e,color:#fff

    class DB db
    class IR router
    class SW,SC worker
    class EW,Q enricher
    class OAI ai
    class PU partial
    class FU full
```

## Functions

| Function | Responsibility |
|---|---|
| `ingest-router` | Validates INSERT webhook, enqueues to `scrape_jobs`, wakes `scrape-worker` |
| `scrape-worker` | Reads `scrape_jobs`, fetches transcript + metadata for all platforms, enqueues to `enrich_jobs` |
| `enrich-worker` | Reads `enrich_jobs`, runs OpenAI enrichment + 1536-dim embedding + DB update |

See [QUEUE.md](./QUEUE.md) for full queue architecture and status tracking details.

## Supported Platforms

| Platform | URL pattern |
|---|---|
| YouTube | `youtube.com/watch`, `youtu.be` |
| YouTube Shorts | `youtube.com/shorts/` |
| TikTok | `tiktok.com` |
| Instagram | `instagram.com` |

## Deploy

### One-time setup
```bash
supabase login
supabase link --project-ref <project-ref>
supabase secrets set \
  SCRAPECREATORS_API_KEY=<key> \
  OPENAI_API_KEY=<key> \
  SUPABASE_SERVICE_ROLE_KEY=<key> \
  CLIPNEST_FUNCTION_KEY=<anon-jwt>   # eyJ... from Dashboard → Project Settings → API
```

Also run `sql/pgmq_migration.sql` in the Supabase SQL Editor.

### Deploy all functions
```bash
npm run deploy
```

### Configure the Database Webhook
In the Supabase Dashboard → **Database → Webhooks → Create a new hook**:

| Field | Value |
|---|---|
| Table | `clipnest_videos` |
| Events | INSERT |
| URL | `https://<project-ref>.supabase.co/functions/v1/ingest-router` |
| Header: `Authorization` | `Bearer <anon-key>` |

## Logs
```bash
npm run logs:router   # tail ingest-router
npm run logs:enrich   # tail enrich-worker
supabase functions logs <name> --tail
```

## Project Structure

```
supabase/
  functions/
    ingest-router/      — webhook entry point
    scrape-worker/      — all-platform scraper (YouTube, TikTok, Instagram)
    enrich-worker/      — OpenAI enrichment + DB update
    _shared/
      types.ts          — shared interfaces + ProcessingStatus enum
      utils.ts          — shared helpers + queue helpers
      deno.d.ts         — Deno ambient types for VS Code
scripts/
  deploy.sh             — deploys all functions
sql/
  clipnest_videos.sql   — DB schema reference
  pgmq_migration.sql    — PGMQ queues + status columns migration
```
