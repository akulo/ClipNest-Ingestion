import type { ScraperPayload } from "../_shared/types.ts";
import { detectPlatform, callFunction } from "../_shared/utils.ts";

interface WebhookPayload {
  type: string;
  table: string;
  schema: string;
  record: Record<string, unknown>;
  old_record: Record<string, unknown> | null;
}

const PLATFORM_TO_FUNCTION: Record<string, string> = {
  youtube: "scrape-youtube",
  youtube_shorts: "scrape-youtube",
  tiktok: "scrape-tiktok",
  instagram: "scrape-instagram",
};

Deno.serve(async (req: Request) => {
  try {
    const payload = (await req.json()) as WebhookPayload;

    if (payload.type !== "INSERT") {
      return new Response("Not an INSERT event", { status: 200 });
    }

    const record = payload.record;
    const id = record.id as string;
    const video_url = record.video_url as string | null;
    const transcript_text = record.transcript_text as string | null;

    if (!video_url) {
      console.log(`[ingest-router] Skipping row ${id}: no video_url`);
      return new Response("No video_url", { status: 200 });
    }

    if (transcript_text) {
      console.log(`[ingest-router] Skipping row ${id}: already processed`);
      return new Response("Already processed", { status: 200 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    let platform: string;
    try {
      platform = detectPlatform(video_url);
    } catch (err) {
      console.error(`[ingest-router] Unsupported platform for ${id}: ${video_url}`);
      return new Response("Unsupported platform", { status: 200 });
    }

    const scraperFn = PLATFORM_TO_FUNCTION[platform];
    if (!scraperFn) {
      console.error(`[ingest-router] No scraper mapped for platform "${platform}"`);
      return new Response("No scraper for platform", { status: 200 });
    }

    const scraperPayload: ScraperPayload = { id, video_url };

    console.log(`[ingest-router] Routing video ${id} (${platform}) → ${scraperFn}`);

    // Fan out asynchronously — do not await so the webhook returns immediately
    callFunction(scraperFn, scraperPayload, supabaseUrl, anonKey).catch((err) => {
      console.error(`[ingest-router] Failed to call ${scraperFn} for ${id}:`, err);
    });

    return new Response("Routed", { status: 200 });
  } catch (err) {
    console.error("[ingest-router] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
