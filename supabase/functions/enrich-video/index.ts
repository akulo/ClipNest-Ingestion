import { createClient } from "npm:@supabase/supabase-js";
import OpenAI from "npm:openai";
import type { EnricherPayload, EnrichmentResult } from "../_shared/types.ts";

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

Deno.serve(async (req: Request) => {
  try {
    const { id, videoData } = (await req.json()) as EnricherPayload;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    if (!videoData.transcript_text) {
      console.warn(`[enrich-video] No transcript for ${id}, doing partial update`);
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
      console.log(`[enrich-video] Partial update complete for ${id}`);
      return new Response("Partial update (no transcript)", { status: 200 });
    }

    const openai = new OpenAI({ apiKey: openaiKey });

    console.log(`[enrich-video] Starting OpenAI enrichment for ${id}`);
    const enrichment = await enrichTranscript(videoData.transcript_text, openai);
    console.log(`[enrich-video] Enrichment done for ${id}: sentiment=${enrichment.sentiment}`);

    const embedding = await generateEmbedding(videoData.transcript_text, openai);
    console.log(`[enrich-video] Embedding done for ${id}: dims=${embedding.length}`);

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

    console.log(`[enrich-video] Successfully updated row ${id}`);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[enrich-video] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
