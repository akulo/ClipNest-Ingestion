import { createClient } from "npm:@supabase/supabase-js";
import OpenAI from "npm:openai";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoData {
  transcript_text: string;
  transcript_url: string | null;
  transcript_preview: string;
  title: string | null;
  creator: string | null;
  published: string | null;
  platform: "youtube" | "youtube_shorts" | "tiktok" | "instagram";
  normalized_url: string;
}

interface EnrichmentResult {
  summary: string;
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  tags: string[];
  categories: string[];
}

interface WebhookPayload {
  type: string;
  table: string;
  schema: string;
  record: Record<string, unknown>;
  old_record: Record<string, unknown> | null;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

const SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com";

function detectPlatform(url: string): VideoData["platform"] {
  if (url.includes("youtube.com/shorts/")) return "youtube_shorts";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("instagram.com")) return "instagram";
  throw new Error(`Unsupported platform for URL: ${url}`);
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

async function apiFetch(path: string, apiKey: string): Promise<unknown> {
  const response = await fetch(`${SCRAPECREATORS_BASE_URL}${path}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ScrapeCreators API error ${response.status}: ${text}`);
  }
  return response.json();
}

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

// ── Enricher ──────────────────────────────────────────────────────────────────

async function enrichTranscript(transcript: string, openai: OpenAI): Promise<EnrichmentResult> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a video content analyst. Given a video transcript, return a JSON object with these fields: " +
          '"summary" (2-3 sentence summary), ' +
          '"sentiment" (one of: positive, negative, neutral, mixed), ' +
          '"tags" (array of 5-10 relevant keyword strings), ' +
          '"categories" (array of 1-3 broad topic category strings).',
      },
      {
        role: "user",
        content: `Analyze this transcript:\n\n${transcript}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI enrichment");
  return JSON.parse(content) as EnrichmentResult;
}

async function generateEmbedding(text: string, openai: OpenAI): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) throw new Error("Empty embedding from OpenAI");
  return embedding;
}

// ── Handler ───────────────────────────────────────────────────────────────────

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
      console.log(`[process-video] Skipping row ${id}: no video_url`);
      return new Response("No video_url", { status: 200 });
    }

    if (transcript_text) {
      console.log(`[process-video] Skipping row ${id}: already processed`);
      return new Response("Already processed", { status: 200 });
    }

    // Init clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const scrapeCreatorsKey = Deno.env.get("SCRAPECREATORS_API_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseKey);
    const openai = new OpenAI({ apiKey: openaiKey });

    console.log(`[process-video] Starting pipeline for video ${id} (${video_url})`);

    // Step 1: Fetch transcript + metadata
    const videoData = await fetchVideoData(video_url, scrapeCreatorsKey);
    console.log(`[process-video] Fetched video data for ${id}: platform=${videoData.platform}`);

    if (!videoData.transcript_text) {
      console.warn(`[process-video] No transcript for ${id}, skipping OpenAI enrichment`);
      const { error } = await supabase
        .from("clipnest_videos")
        .update({
          platform: videoData.platform,
          normalized_url: videoData.normalized_url,
          creator: videoData.creator,
          title: videoData.title,
          published: videoData.published,
          transcript_url: videoData.transcript_url,
        })
        .eq("id", id);
      if (error) throw error;
      console.log(`[process-video] Partially updated row ${id} (no transcript)`);
      return new Response("Partial update (no transcript)", { status: 200 });
    }

    // Step 2: Enrich transcript with OpenAI
    const enrichment = await enrichTranscript(videoData.transcript_text, openai);
    console.log(`[process-video] Enrichment complete for ${id}: sentiment=${enrichment.sentiment}`);

    // Step 3: Generate embedding
    const embedding = await generateEmbedding(videoData.transcript_text, openai);
    console.log(`[process-video] Embedding generated for ${id}: dims=${embedding.length}`);

    // Step 4: Update Supabase row
    const { error } = await supabase
      .from("clipnest_videos")
      .update({
        platform: videoData.platform,
        normalized_url: videoData.normalized_url,
        creator: videoData.creator,
        title: videoData.title,
        published: videoData.published,
        transcript_text: videoData.transcript_text,
        transcript_url: videoData.transcript_url,
        transcript_preview: videoData.transcript_preview,
        summary: enrichment.summary,
        sentiment: enrichment.sentiment,
        tags: enrichment.tags,
        categories: enrichment.categories,
        embedding: JSON.stringify(embedding),
      })
      .eq("id", id);

    if (error) throw error;

    console.log(`[process-video] Successfully updated row ${id}`);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[process-video] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
