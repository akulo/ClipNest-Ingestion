import { createWriteStream, mkdirSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { processVideo } from "./processor.js";

// File logging — appends to logs/app-YYYY-MM-DD.log
mkdirSync("logs", { recursive: true });
const logStream = createWriteStream(
  join("logs", `app-${new Date().toISOString().slice(0, 10)}.log`),
  { flags: "a" }
);

function writeLine(level: string, ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logStream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
}

const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
console.log = (...args) => { _log(...args); writeLine("LOG", ...args); };
console.warn = (...args) => { _warn(...args); writeLine("WARN", ...args); };
console.error = (...args) => { _error(...args); writeLine("ERROR", ...args); };

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;
console.log("[init] SUPABASE_URL:", supabaseUrl);
console.log("[init] SUPABASE_SERVICE_KEY:", supabaseKey?.slice(0, 20) + "...");

const supabase = createClient(supabaseUrl, supabaseKey);

const processingIds = new Set<string>();

async function processUnhandledRows(): Promise<void> {
  console.log("[index] Checking for unprocessed rows...");

  // Debug: log all rows
  const { data: allRows, error: allError } = await supabase
    .from("clipnest_videos")
    .select("id, video_url, transcript_text");
  console.log("[debug] error:", allError);
  console.log("[debug] row count:", allRows?.length);
  allRows?.forEach((r) =>
    console.log(`[debug] row ${r.id}: video_url=${r.video_url}, transcript_text=${JSON.stringify(r.transcript_text)}`)
  );

  const { data, error } = await supabase
    .from("clipnest_videos")
    .select("id, video_url")
    .is("transcript_text", null);

  if (error) {
    console.error("[index] Failed to fetch unprocessed rows:", error);
    return;
  }

  if (!data || data.length === 0) {
    console.log("[index] No unprocessed rows found.");
    return;
  }

  console.log(`[index] Found ${data.length} unprocessed row(s). Processing...`);
  for (const row of data) {
    if (!row.video_url) {
      console.warn(`[index] Row ${row.id} has no video_url, skipping.`);
      continue;
    }
    if (processingIds.has(row.id)) continue;
    processingIds.add(row.id);
    processVideo(supabase, row.id, row.video_url).finally(() =>
      processingIds.delete(row.id)
    );
  }
}

async function startRealtimeListener(): Promise<void> {
  const channel = supabase
    .channel("clipnest_videos_inserts")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "clipnest_videos" },
      (payload) => {
        console.log("[index] Realtime INSERT received:", payload.new);
        const { id, video_url } = payload.new as { id: string; video_url: string | null };
        if (!video_url) {
          console.warn(`[index] INSERT event for row ${id} has no video_url, skipping.`);
          return;
        }
        if (processingIds.has(id)) return;
        processingIds.add(id);
        processVideo(supabase, id, video_url).finally(() => processingIds.delete(id));
      }
    )
    .subscribe((status, err) => {
      console.log(`[index] Realtime status: ${status}`, err ?? "");
      if (status === "SUBSCRIBED") {
        console.log("[index] Listening for new clipnest_videos...");
      }
    });

  // Poll every 30s as a fallback in case Realtime misses events
  const pollInterval = setInterval(processUnhandledRows, 30_000);

  process.on("SIGINT", async () => {
    console.log("\n[index] Shutting down...");
    clearInterval(pollInterval);
    await supabase.removeChannel(channel);
    process.exit(0);
  });
}

async function main(): Promise<void> {
  await processUnhandledRows();
  await startRealtimeListener();
}

main().catch((err) => {
  console.error("[index] Fatal error:", err);
  process.exit(1);
});
