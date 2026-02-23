import OpenAI from "openai";
import { EnrichmentResult } from "./types.js";

let _openai: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export async function enrichTranscript(transcript: string): Promise<EnrichmentResult> {
  const response = await getClient().chat.completions.create({
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

  const parsed = JSON.parse(content) as EnrichmentResult;
  return parsed;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) throw new Error("Empty embedding from OpenAI");

  return embedding;
}
