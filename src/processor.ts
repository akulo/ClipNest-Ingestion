import { SupabaseClient } from "@supabase/supabase-js";
import { fetchVideoData } from "./scraper.js";
import { enrichTranscript, generateEmbedding } from "./enricher.js";

export async function processVideo(
  supabase: SupabaseClient,
  id: string,
  video_url: string
): Promise<void> {
  console.log(`[processor] Starting pipeline for video ${id} (${video_url})`);

  try {
    // Step 1: Fetch transcript + metadata
    const videoData = await fetchVideoData(video_url);
    console.log(`[processor] Fetched video data for ${id}: platform=${videoData.platform}`);

    if (!videoData.transcript_text) {
      console.warn(`[processor] No transcript for ${id}, skipping OpenAI enrichment`);
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
      console.log(`[processor] Partially updated row ${id} (no transcript)`);
      return;
    }

    // Step 2: Enrich transcript with OpenAI
    const enrichment = await enrichTranscript(videoData.transcript_text);
    console.log(`[processor] Enrichment complete for ${id}: sentiment=${enrichment.sentiment}`);

    // Step 3: Generate embedding
    const embedding = await generateEmbedding(videoData.transcript_text);
    console.log(`[processor] Embedding generated for ${id}: dims=${embedding.length}`);

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

    console.log(`[processor] Successfully updated row ${id}`);
  } catch (err) {
    console.error(`[processor] Error processing video ${id}:`, err);
  }
}
