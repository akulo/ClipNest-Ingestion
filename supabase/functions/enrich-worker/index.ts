import { createClient } from "npm:@supabase/supabase-js";
import OpenAI from "npm:openai";
import { ProcessingStatus } from "../_shared/types.ts";
import type { EnricherPayload, EnrichmentResult, GeoPayload, VideoData } from "../_shared/types.ts";
import { callFunction, queueArchive, queueRead, queueSend } from "../_shared/utils.ts";

const POISON_PILL_THRESHOLD = 3;

// ── OpenAI helpers ────────────────────────────────────────────────────────────

async function enrichTranscript(transcript: string, openai: OpenAI): Promise<EnrichmentResult> {
  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an expert food, travel, and lifestyle content analyst. " +
          "Given a video transcript, return a JSON object with exactly these fields:\n\n" +
          '"summary": 2-3 sentence summary of the video.\n' +
          '"sentiment": one of: positive, negative, neutral, mixed.\n' +
          '"tags": array of 5-10 relevant keyword strings.\n' +
          '"categories": array of 1-3 broad topic category strings.\n' +
          '"price": price or price range if mentioned (e.g. "$20" or "$10-$30"), otherwise null.\n\n' +
          "For the location fields below, use a strict priority order:\n" +
          "1. Extract directly from the transcript if explicitly stated.\n" +
          "2. Infer from strong context clues (e.g. area code, landmarks, street names mentioned).\n" +
          "3. Use your training knowledge — if the venue name is well-known (e.g. a famous restaurant, landmark, or chain), you likely know its address, city, and neighborhood. Use that knowledge confidently.\n" +
          "Only return null if you have genuinely no basis to determine the value after trying all three.\n\n" +
          '"venue": the name of the specific restaurant, bar, cafe, shop, or place featured. null if none.\n' +
          '"address": full street address (e.g. "123 Main St"). null if unknown after best effort.\n' +
          '"city": city name (e.g. "New York", "Los Angeles"). null if unknown after best effort.\n' +
          '"neighborhood": neighborhood or district (e.g. "SoHo", "Silver Lake"). null if unknown after best effort.',
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

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const functionKey = Deno.env.get("CLIPNEST_FUNCTION_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const messages = await queueRead<EnricherPayload>(supabase, "enrich_jobs", 300, 1);

  if (messages.length === 0) {
    console.log("[enrich-worker] No messages in enrich_jobs — idle");
    return new Response("Idle", { status: 200 });
  }

  const msg = messages[0];
  const { msg_id, read_ct, message: { id, videoData } } = msg;

  console.log(`[enrich-worker] Processing msg ${msg_id} (read_ct=${read_ct}) for video ${id}`);

  // Poison-pill check
  if (read_ct > POISON_PILL_THRESHOLD) {
    console.error(`[enrich-worker] Poison pill detected for msg ${msg_id} (video ${id})`);
    await supabase
      .from("clipnest_videos")
      .update({
        processing_status: ProcessingStatus.Failed,
        processing_error: `Enrich job exceeded max retries (read_ct=${read_ct})`,
      })
      .eq("id", id);
    await queueArchive(supabase, "enrich_jobs", msg_id);
    return new Response("Poison pill archived", { status: 200 });
  }

  // Mark enriching
  await supabase
    .from("clipnest_videos")
    .update({ processing_status: ProcessingStatus.Enriching })
    .eq("id", id);

  try {
    if (!videoData.transcript_text) {
      // No-transcript path: partial update only
      console.warn(`[enrich-worker] No transcript for ${id}, doing partial update`);
      const { error } = await supabase
        .from("clipnest_videos")
        .update({
          platform: videoData.platform,
          normalized_url: videoData.normalized_url,
          creator: videoData.creator,
          title: videoData.title,
          published: videoData.published,
          transcript_url: videoData.transcript_url,
          processing_status: ProcessingStatus.Done,
        })
        .eq("id", id);
      if (error) throw error;
      await queueArchive(supabase, "enrich_jobs", msg_id);
      console.log(`[enrich-worker] Partial update done for ${id}`);
    } else {
      // Full enrichment path
      const openai = new OpenAI({ apiKey: openaiKey });

      console.log(`[enrich-worker] Starting OpenAI enrichment for ${id}`);
      const enrichment = await enrichTranscript(videoData.transcript_text, openai);
      console.log(`[enrich-worker] Enrichment done for ${id}: sentiment=${enrichment.sentiment}`);

      const embedding = await generateEmbedding(videoData.transcript_text, openai);
      console.log(`[enrich-worker] Embedding done for ${id}: dims=${embedding.length}`);

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
          venue: enrichment.venue,
          address: enrichment.address,
          city: enrichment.city,
          neighborhood: enrichment.neighborhood,
          price: enrichment.price,
          embedding: JSON.stringify(embedding),
          processing_status: ProcessingStatus.Done,
        })
        .eq("id", id);
      if (error) throw error;

      await queueArchive(supabase, "enrich_jobs", msg_id);
      console.log(`[enrich-worker] Successfully enriched row ${id}`);

      // Enqueue geo lookup (best-effort — fire and forget errors)
      const geoPayload: GeoPayload = {
        id,
        venue: enrichment.venue,
        address: enrichment.address,
        city: enrichment.city,
        neighborhood: enrichment.neighborhood,
      };
      await queueSend(supabase, "geo_jobs", geoPayload).catch((err) => {
        console.error("[enrich-worker] Failed to enqueue geo job:", err);
      });
      callFunction("geo-worker", {}, supabaseUrl, functionKey).catch((err) => {
        console.error("[enrich-worker] Failed to wake geo-worker:", err);
      });
    }

    // Chain-invoke self to drain the queue
    callFunction("enrich-worker", {}, supabaseUrl, functionKey).catch((err) => {
      console.error("[enrich-worker] Failed to chain-invoke self:", err);
    });

    return new Response("OK", { status: 200 });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[enrich-worker] Enrichment failed for video ${id}:`, errorMsg);
    // Mark failed — do NOT archive so VT handles retry
    await supabase
      .from("clipnest_videos")
      .update({ processing_status: ProcessingStatus.Failed, processing_error: errorMsg })
      .eq("id", id);
    return new Response("Enrichment failed", { status: 200 });
  }
});
