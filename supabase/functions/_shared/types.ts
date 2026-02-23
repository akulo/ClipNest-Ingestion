export interface VideoData {
  transcript_text: string;
  transcript_url: string | null;
  transcript_preview: string;
  title: string | null;
  creator: string | null;
  published: string | null;
  platform: "youtube" | "youtube_shorts" | "tiktok" | "instagram";
  normalized_url: string;
}

export interface EnrichmentResult {
  summary: string;
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  tags: string[];
  categories: string[];
}

/** Router → scraper */
export interface ScraperPayload {
  id: string;
  video_url: string;
}

/** Scraper → enricher */
export interface EnricherPayload {
  id: string;
  videoData: VideoData;
}
