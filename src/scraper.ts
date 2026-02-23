import { VideoData } from "./types.js";

const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY!;
const BASE_URL = "https://api.scrapecreators.com";

type Platform = "youtube" | "youtube_shorts" | "tiktok" | "instagram";

function detectPlatform(url: string): Platform {
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

async function apiFetch(path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": SCRAPECREATORS_API_KEY },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ScrapeCreators API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function fetchYouTubeData(url: string, platform: "youtube" | "youtube_shorts" = "youtube"): Promise<VideoData> {
  const encodedUrl = encodeURIComponent(url);

  const [transcriptData, metaData] = await Promise.all([
    apiFetch(`/v1/youtube/video/transcript?url=${encodedUrl}`) as Promise<any>,
    apiFetch(`/v1/youtube/video?url=${encodedUrl}`) as Promise<any>,
  ]);

  const rawTranscript = transcriptData?.transcript ?? transcriptData?.text ?? "";
  const transcript_text: string = Array.isArray(rawTranscript)
    ? rawTranscript.map((s: any) => s.text ?? "").join(" ")
    : String(rawTranscript ?? "");
  const transcript_url: string | null = transcriptData?.url ?? null;

  return {
    transcript_text,
    transcript_url,
    transcript_preview: transcript_text.slice(0, 500),
    title: metaData?.title ?? transcriptData?.title ?? null,
    creator: metaData?.channel?.title ?? metaData?.channelTitle ?? metaData?.author ?? null,
    published: metaData?.publishedAt ?? metaData?.published ?? null,
    platform,
    normalized_url: normalizeUrl(url),
  };
}

async function fetchTikTokData(url: string): Promise<VideoData> {
  const encodedUrl = encodeURIComponent(url);
  const data = (await apiFetch(`/v1/tiktok/video/transcript?url=${encodedUrl}`)) as any;

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

async function fetchInstagramData(url: string): Promise<VideoData> {
  const encodedUrl = encodeURIComponent(url);
  const data = (await apiFetch(`/v1/instagram/media/transcript?url=${encodedUrl}`)) as any;

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

export async function fetchVideoData(video_url: string): Promise<VideoData> {
  const platform = detectPlatform(video_url);
  switch (platform) {
    case "youtube":
      return fetchYouTubeData(video_url, "youtube");
    case "youtube_shorts":
      return fetchYouTubeData(video_url, "youtube_shorts");
    case "tiktok":
      return fetchTikTokData(video_url);
    case "instagram":
      return fetchInstagramData(video_url);
  }
}
