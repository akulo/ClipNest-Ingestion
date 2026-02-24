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
  venue: string | null;
  address: string | null;
  city: string | null;
  neighborhood: string | null;
  price: string | null;
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

/** Enricher → geo-worker */
export interface GeoPayload {
  id: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  neighborhood: string | null;
}

export enum ProcessingStatus {
  Pending = "pending",
  Scraping = "scraping",
  Enriching = "enriching",
  Done = "done",
  Failed = "failed",
}

export interface QueueMessage<T> {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: T;
}
