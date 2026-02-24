import { createClient } from "npm:@supabase/supabase-js";
import { ProcessingStatus } from "../_shared/types.ts";
import type { ScraperPayload, VideoData } from "../_shared/types.ts";
import {
  apiFetch,
  callFunction,
  detectPlatform,
  normalizeUrl,
  queueArchive,
  queueRead,
  queueSend,
} from "../_shared/utils.ts";

const POISON_PILL_THRESHOLD = 3;

// ── Platform scrapers ─────────────────────────────────────────────────────────

async function fetchYouTubeData(
  url: string,
  platform: "youtube" | "youtube_shorts",
  apiKey: string
): Promise<VideoData> {
  const encodedUrl = encodeURIComponent(url);
  const [transcriptData, metaData] = await Promise.all([
    apiFetch(`/v1/youtube/video/transcript?url=${encodedUrl}`, apiKey) as Promise<any>,
    apiFetch(`/v1/youtube/video?url=${encodedUrl}`, apiKey) as Promise<any>,
  ]);

  const rawTranscript = transcriptData?.transcript ?? transcriptData?.text ?? "";
  const transcript_text: string = Array.isArray(rawTranscript)
    ? rawTranscript.map((s: any) => s.text ?? "").join(" ")
    : String(rawTranscript ?? "");

  return {
    transcript_text,
    transcript_url: transcriptData?.url ?? null,
    transcript_preview: transcript_text.slice(0, 500),
    title: metaData?.title ?? transcriptData?.title ?? null,
    creator: metaData?.channel?.title ?? metaData?.channelTitle ?? metaData?.author ?? null,
    published: metaData?.publishedAt ?? metaData?.published ?? null,
    platform,
    normalized_url: normalizeUrl(url),
  };
}

async function fetchTikTokData(url: string, apiKey: string): Promise<VideoData> {
  const encodedUrl = encodeURIComponent(url);
  const data = (await apiFetch(`/v1/tiktok/video/transcript?url=${encodedUrl}`, apiKey)) as any;
  const transcript_text: string = data?.transcript ?? data?.text ?? "";

  return {
    transcript_text,
    transcript_url: data?.url ?? null,
    transcript_preview: transcript_text.slice(0, 500),
    title: data?.title ?? null,
    creator: data?.author ?? data?.username ?? null,
    published: data?.published ?? null,
    platform: "tiktok",
    normalized_url: normalizeUrl(url),
  };
}

async function fetchInstagramData(url: string, apiKey: string): Promise<VideoData> {
  const encodedUrl = encodeURIComponent(url);
  const data = (await apiFetch(`/v1/instagram/media/transcript?url=${encodedUrl}`, apiKey)) as any;
  const transcript_text: string = data?.transcript ?? data?.text ?? "";

  return {
    transcript_text,
    transcript_url: data?.url ?? null,
    transcript_preview: transcript_text.slice(0, 500),
    title: data?.title ?? null,
    creator: data?.author ?? data?.username ?? null,
    published: data?.published ?? null,
    platform: "instagram",
    normalized_url: normalizeUrl(url),
  };
}

async function fetchVideoData(video_url: string, apiKey: string): Promise<VideoData> {
  const platform = detectPlatform(video_url);
  switch (platform) {
    case "youtube":
      return fetchYouTubeData(video_url, "youtube", apiKey);
    case "youtube_shorts":
      return fetchYouTubeData(video_url, "youtube_shorts", apiKey);
    case "tiktok":
      return fetchTikTokData(video_url, apiKey);
    case "instagram":
      return fetchInstagramData(video_url, apiKey);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const functionKey = Deno.env.get("CLIPNEST_FUNCTION_KEY")!;
  const scrapeKey = Deno.env.get("SCRAPECREATORS_API_KEY")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const messages = await queueRead<ScraperPayload>(supabase, "scrape_jobs", 120, 1);

  if (messages.length === 0) {
    console.log("[scrape-worker] No messages in scrape_jobs — idle");
    return new Response("Idle", { status: 200 });
  }

  const msg = messages[0];
  const { msg_id, read_ct, message: { id, video_url } } = msg;

  console.log(`[scrape-worker] Processing msg ${msg_id} (read_ct=${read_ct}) for video ${id}`);

  // Poison-pill check
  if (read_ct > POISON_PILL_THRESHOLD) {
    console.error(`[scrape-worker] Poison pill detected for msg ${msg_id} (video ${id})`);
    await supabase
      .from("clipnest_videos")
      .update({
        processing_status: ProcessingStatus.Failed,
        processing_error: `Scrape job exceeded max retries (read_ct=${read_ct})`,
      })
      .eq("id", id);
    await queueArchive(supabase, "scrape_jobs", msg_id);
    return new Response("Poison pill archived", { status: 200 });
  }

  // Mark scraping
  await supabase
    .from("clipnest_videos")
    .update({ processing_status: ProcessingStatus.Scraping })
    .eq("id", id);

  try {
    console.log(`[scrape-worker] Scraping ${video_url}`);
    const videoData = await fetchVideoData(video_url, scrapeKey);
    console.log(`[scrape-worker] Scraped video ${id}: platform=${videoData.platform}`);

    // Enqueue enrich job
    const enrichMsgId = await queueSend(supabase, "enrich_jobs", { id, videoData });
    console.log(`[scrape-worker] Enqueued enrich job ${enrichMsgId} for video ${id}`);

    // Archive the scrape message (success)
    await queueArchive(supabase, "scrape_jobs", msg_id);

    // Wake enrich-worker
    await callFunction("enrich-worker", {}, supabaseUrl, functionKey).catch((err) => {
      console.error("[scrape-worker] Failed to wake enrich-worker:", err);
    });

    // Chain-invoke self to drain the queue
    callFunction("scrape-worker", {}, supabaseUrl, functionKey).catch((err) => {
      console.error("[scrape-worker] Failed to chain-invoke self:", err);
    });

    return new Response("OK", { status: 200 });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[scrape-worker] Scrape failed for video ${id}:`, errorMsg);
    // Mark failed — do NOT archive so VT handles retry
    await supabase
      .from("clipnest_videos")
      .update({ processing_status: ProcessingStatus.Failed, processing_error: errorMsg })
      .eq("id", id);
    return new Response("Scrape failed", { status: 200 });
  }
});
