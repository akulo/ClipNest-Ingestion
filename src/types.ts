export interface ClipNestVideo {
  id: string;
  row_number: number | null;
  platform: string | null;
  video_url: string | null;
  normalized_url: string | null;
  creator: string | null;
  title: string | null;
  summary: string | null;
  sentiment: string | null;
  tags: string[] | null;
  categories: string[] | null;
  transcript_url: string | null;
  transcript_preview: string | null;
  embedding: number[] | null;
  created_at: string | null;
  published: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  price: string | null;
  transcript_text: string | null;
  source: string | null;
}

export interface VideoData {
  transcript_text: string;
  transcript_url: string | null;
  transcript_preview: string;
  title: string | null;
  creator: string | null;
  published: string | null;
  platform: string;
  normalized_url: string;
}

export interface EnrichmentResult {
  summary: string;
  sentiment: string;
  tags: string[];
  categories: string[];
}
