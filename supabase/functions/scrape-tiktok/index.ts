import type { ScraperPayload, VideoData, EnricherPayload } from "../_shared/types.ts";
import { apiFetch, normalizeUrl, callFunction } from "../_shared/utils.ts";

Deno.serve(async (req: Request) => {
  try {
    const { id, video_url } = (await req.json()) as ScraperPayload;

    const scrapeCreatorsKey = Deno.env.get("SCRAPECREATORS_API_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    console.log(`[scrape-tiktok] Fetching data for video ${id}`);

    const encodedUrl = encodeURIComponent(video_url);
    const data = (await apiFetch(`/v1/tiktok/video/transcript?url=${encodedUrl}`, scrapeCreatorsKey)) as any;

    const transcript_text: string = data?.transcript ?? data?.text ?? "";

    const videoData: VideoData = {
      transcript_text,
      transcript_url: data?.url ?? null,
      transcript_preview: transcript_text.slice(0, 500),
      title: data?.title ?? null,
      creator: data?.author ?? data?.username ?? null,
      published: data?.published ?? null,
      platform: "tiktok",
      normalized_url: normalizeUrl(video_url),
    };

    console.log(`[scrape-tiktok] Scraped video ${id}: transcript_len=${transcript_text.length}`);

    const enricherPayload: EnricherPayload = { id, videoData };

    const enrichRes = await callFunction("enrich-video", enricherPayload, supabaseUrl, anonKey);
    if (!enrichRes.ok) {
      const body = await enrichRes.text();
      console.error(`[scrape-tiktok] enrich-video responded ${enrichRes.status}: ${body}`);
    } else {
      console.log(`[scrape-tiktok] Handed off video ${id} to enrich-video`);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[scrape-tiktok] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
