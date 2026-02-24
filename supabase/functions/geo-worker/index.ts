import { createClient } from "npm:@supabase/supabase-js";
import type { GeoPayload } from "../_shared/types.ts";
import { callFunction, queueArchive, queueRead } from "../_shared/utils.ts";

const MAPBOX_GEOCODING_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";

// ── Geo helpers ───────────────────────────────────────────────────────────────

/** Build a Mapbox query string from available location fields.
 *  Returns null if there's not enough specificity to geocode reliably. */
function buildGeoQuery(
  venue: string | null,
  address: string | null,
  city: string | null,
  neighborhood: string | null
): string | null {
  // Prefer address over venue for the place part
  const place = address ?? venue;
  const geo = city ?? neighborhood;

  if (place && geo) return `${place}, ${geo}`;
  // venue + city is enough; bare city or bare venue is too vague
  return null;
}

interface MapboxFeature {
  center: [number, number]; // [longitude, latitude]
  place_name: string;
}

interface MapboxResponse {
  features: MapboxFeature[];
}

async function geocode(
  query: string,
  accessToken: string
): Promise<{ lat: number; lng: number } | null> {
  const url = `${MAPBOX_GEOCODING_URL}/${encodeURIComponent(query)}.json?access_token=${accessToken}&limit=1`;
  // Log the URL with the token redacted
  const redactedUrl = url.replace(accessToken, accessToken.slice(0, 8) + "...");
  console.log(`[geo-worker] Mapbox request: GET ${redactedUrl}`);

  const res = await fetch(url);
  console.log(`[geo-worker] Mapbox response: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[geo-worker] Mapbox error body: ${errBody}`);
    throw new Error(`Mapbox API error: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as MapboxResponse;
  console.log(`[geo-worker] Mapbox features count: ${body.features.length}`);

  const feature = body.features[0];
  if (!feature) return null;

  console.log(`[geo-worker] Mapbox top result: "${feature.place_name}" center=${JSON.stringify(feature.center)}`);
  const [lng, lat] = feature.center;
  return { lat, lng };
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const functionKey = Deno.env.get("CLIPNEST_FUNCTION_KEY")!;
  const mapboxToken = Deno.env.get("MAPBOX_ACCESS_TOKEN")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const messages = await queueRead<GeoPayload>(supabase, "geo_jobs", 120, 1);

  if (messages.length === 0) {
    console.log("[geo-worker] No messages in geo_jobs — idle");
    return new Response("Idle", { status: 200 });
  }

  const msg = messages[0];
  const { msg_id, message: { id, venue, address, city, neighborhood } } = msg;

  console.log(`[geo-worker] Processing msg ${msg_id} for video ${id}`);

  try {
    const query = buildGeoQuery(venue, address, city, neighborhood);

    if (!query) {
      console.log(`[geo-worker] No geocodable location data for video ${id} — writing text fields only`);
      const { error: textError } = await supabase
        .from("clipnest_videos")
        .update({ venue, address, city, neighborhood })
        .eq("id", id);
      if (textError) throw textError;
      await queueArchive(supabase, "geo_jobs", msg_id);
    } else {
      console.log(`[geo-worker] Geocoding "${query}" for video ${id}`);
      const coords = await geocode(query, mapboxToken);

      if (!coords) {
        console.warn(`[geo-worker] No results from Mapbox for "${query}" (video ${id})`);
      } else {
        console.log(`[geo-worker] Got coords for ${id}: lat=${coords.lat}, lng=${coords.lng}`);
      }

      const { error } = await supabase
        .from("clipnest_videos")
        .update({ venue, address, city, neighborhood, ...(coords ?? {}) })
        .eq("id", id);
      if (error) throw error;

      await queueArchive(supabase, "geo_jobs", msg_id);
      console.log(`[geo-worker] Done for video ${id}`);
    }

    // Chain-invoke self to drain the queue
    callFunction("geo-worker", {}, supabaseUrl, functionKey).catch((err) => {
      console.error("[geo-worker] Failed to chain-invoke self:", err);
    });

    return new Response("OK", { status: 200 });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[geo-worker] Geocoding failed for video ${id} (skipping):`, errorMsg);
    // Best-effort — archive anyway so the job doesn't retry
    await queueArchive(supabase, "geo_jobs", msg_id).catch(() => {});
    return new Response("OK", { status: 200 });
  }
});
