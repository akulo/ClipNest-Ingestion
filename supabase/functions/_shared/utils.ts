import type { VideoData, QueueMessage } from "./types.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";

const SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com";

export function detectPlatform(url: string): VideoData["platform"] {
  if (url.includes("youtube.com/shorts/")) return "youtube_shorts";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("instagram.com")) return "instagram";
  throw new Error(`Unsupported platform for URL: ${url}`);
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function apiFetch(path: string, apiKey: string): Promise<unknown> {
  const response = await fetch(`${SCRAPECREATORS_BASE_URL}${path}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ScrapeCreators API error ${response.status}: ${text}`);
  }
  return response.json();
}

// ── PGMQ helpers ──────────────────────────────────────────────────────────────

export async function queueSend<T>(
  supabase: SupabaseClient,
  queueName: string,
  payload: T
): Promise<number> {
  const { data, error } = await supabase.rpc("queue_send", {
    queue_name: queueName,
    message: payload,
  });
  if (error) throw new Error(`queue_send failed: ${error.message}`);
  return data as number;
}

export async function queueRead<T>(
  supabase: SupabaseClient,
  queueName: string,
  vtSeconds: number,
  qty = 1
): Promise<QueueMessage<T>[]> {
  const { data, error } = await supabase.rpc("queue_read", {
    queue_name: queueName,
    vt_seconds: vtSeconds,
    qty,
  });
  if (error) throw new Error(`queue_read failed: ${error.message}`);
  return (data ?? []) as QueueMessage<T>[];
}

export async function queueArchive(
  supabase: SupabaseClient,
  queueName: string,
  msgId: number
): Promise<void> {
  const { error } = await supabase.rpc("queue_archive", {
    queue_name: queueName,
    msg_id: msgId,
  });
  if (error) throw new Error(`queue_archive failed: ${error.message}`);
}

/** Fire-and-forget inter-function call. Returns the response for optional logging. */
export async function callFunction(
  name: string,
  body: unknown,
  supabaseUrl: string,
  anonKey: string
): Promise<Response> {
  return fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(body),
  });
}
