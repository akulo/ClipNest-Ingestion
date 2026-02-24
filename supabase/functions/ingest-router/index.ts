import { createClient } from "npm:@supabase/supabase-js";
import { ProcessingStatus } from "../_shared/types.ts";
import type { ScraperPayload } from "../_shared/types.ts";
import { detectPlatform, callFunction, queueSend } from "../_shared/utils.ts";

interface WebhookPayload {
  type: string;
  table: string;
  schema: string;
  record: Record<string, unknown>;
  old_record: Record<string, unknown> | null;
}

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
    const existing_status = record.processing_status as string | null;

    if (!video_url) {
      console.log(`[ingest-router] Skipping row ${id}: no video_url`);
      return new Response("No video_url", { status: 200 });
    }

    if (transcript_text) {
      console.log(`[ingest-router] Skipping row ${id}: already processed`);
      return new Response("Already processed", { status: 200 });
    }

    // Idempotency: skip if already in-flight
    if (existing_status === ProcessingStatus.Scraping || existing_status === ProcessingStatus.Enriching) {
      console.log(`[ingest-router] Skipping row ${id}: already ${existing_status}`);
      return new Response("Already in-flight", { status: 200 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const functionKey = Deno.env.get("CLIPNEST_FUNCTION_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let platform: string;
    try {
      platform = detectPlatform(video_url);
    } catch {
      console.error(`[ingest-router] Unsupported platform for ${id}: ${video_url}`);
      await supabase
        .from("clipnest_videos")
        .update({ processing_status: ProcessingStatus.Failed, processing_error: "Unsupported platform" })
        .eq("id", id);
      return new Response("Unsupported platform", { status: 200 });
    }

    // Set status to pending (in case row was inserted without it)
    await supabase
      .from("clipnest_videos")
      .update({ processing_status: ProcessingStatus.Pending })
      .eq("id", id);

    const scraperPayload: ScraperPayload = { id, video_url };
    const msgId = await queueSend(supabase, "scrape_jobs", scraperPayload);
    console.log(`[ingest-router] Queued scrape job ${msgId} for video ${id} (${platform})`);

    // Wake the scrape-worker — awaited so the HTTP call isn't dropped before ingest-router returns
    const wakeRes = await callFunction("scrape-worker", {}, supabaseUrl, functionKey).catch((err) => {
      console.error(`[ingest-router] Failed to wake scrape-worker:`, err);
      return null;
    });
    console.log(`[ingest-router] scrape-worker wake status: ${wakeRes?.status} ${await wakeRes?.text()}`);

    return new Response("Queued", { status: 200 });
  } catch (err) {
    console.error("[ingest-router] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
