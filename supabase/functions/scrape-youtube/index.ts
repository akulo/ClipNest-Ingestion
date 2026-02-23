import type { ScraperPayload, VideoData, EnricherPayload } from "../_shared/types.ts";
import { apiFetch, normalizeUrl, callFunction } from "../_shared/utils.ts";

Deno.serve(async (req: Request) => {
  try {
    const { id, video_url } = (await req.json()) as ScraperPayload;

    const scrapeCreatorsKey = Deno.env.get("SCRAPECREATORS_API_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const platform = video_url.includes("youtube.com/shorts/") ? "youtube_shorts" : "youtube";

    console.log(`[scrape-youtube] Fetching data for video ${id} (${platform})`);

    const encodedUrl = encodeURIComponent(video_url);
    const [transcriptData, metaData] = await Promise.all([
      apiFetch(`/v1/youtube/video/transcript?url=${encodedUrl}`, scrapeCreatorsKey) as Promise<any>,
      apiFetch(`/v1/youtube/video?url=${encodedUrl}`, scrapeCreatorsKey) as Promise<any>,
    ]);

    const rawTranscript = transcriptData?.transcript ?? transcriptData?.text ?? "";
    const transcript_text: string = Array.isArray(rawTranscript)
      ? rawTranscript.map((s: any) => s.text ?? "").join(" ")
      : String(rawTranscript ?? "");

    const videoData: VideoData = {
      transcript_text,
      transcript_url: transcriptData?.url ?? null,
      transcript_preview: transcript_text.slice(0, 500),
      title: metaData?.title ?? transcriptData?.title ?? null,
      creator: metaData?.channel?.title ?? metaData?.channelTitle ?? metaData?.author ?? null,
      published: metaData?.publishedAt ?? metaData?.published ?? null,
      platform,
      normalized_url: normalizeUrl(video_url),
    };

    console.log(`[scrape-youtube] Scraped video ${id}: transcript_len=${transcript_text.length}`);

    const enricherPayload: EnricherPayload = { id, videoData };

    // Call enrich-video and await to surface errors in logs, but don't block the webhook
    const enrichRes = await callFunction("enrich-video", enricherPayload, supabaseUrl, anonKey);
    if (!enrichRes.ok) {
      const body = await enrichRes.text();
      console.error(`[scrape-youtube] enrich-video responded ${enrichRes.status}: ${body}`);
    } else {
      console.log(`[scrape-youtube] Handed off video ${id} to enrich-video`);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[scrape-youtube] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
