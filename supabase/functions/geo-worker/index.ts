import { createClient } from "npm:@supabase/supabase-js";
import type { GeoPayload } from "../_shared/types.ts";
import { callFunction, queueArchive, queueRead } from "../_shared/utils.ts";

const MAPBOX_GEOCODING_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";

// ── Geo helpers ───────────────────────────────────────────────────────────────

/** Build a Mapbox query string from available location fields.
 *  Returns null only if there is nothing at all to search with. */
function buildGeoQuery(
  venue: string | null,
  address: string | null,
  city: string | null,
  neighborhood: string | null
): string | null {
  const parts: string[] = [];
  if (address) parts.push(address);
  else if (venue) parts.push(venue);
  if (city) parts.push(city);
  else if (neighborhood) parts.push(neighborhood);
  return parts.length > 0 ? parts.join(", ") : null;
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
  const mapboxToken = Deno.env.get("MAPBOX_ACCESS_TOKEN");

  if (!mapboxToken) {
    console.error("[geo-worker] MAPBOX_ACCESS_TOKEN is not set — cannot geocode");
    return new Response("Missing MAPBOX_ACCESS_TOKEN", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const messages = await queueRead<GeoPayload>(supabase, "geo_jobs", 120, 1);

  if (messages.length === 0) {
    console.log("[geo-worker] No messages in geo_jobs — idle");
    return new Response("Idle", { status: 200 });
  }

  const msg = messages[0];
  const { msg_id, message: { id, venue, address, city, neighborhood } } = msg;

  console.log(`[geo-worker] Processing msg ${msg_id} for video ${id}`);
  console.log(`[geo-worker] Location fields — venue: ${venue ?? "null"}, address: ${address ?? "null"}, city: ${city ?? "null"}, neighborhood: ${neighborhood ?? "null"}`);

  // Only include non-null text fields so we never overwrite existing DB values with null
  const textFields: Record<string, string> = {};
  if (venue !== null) textFields.venue = venue;
  if (address !== null) textFields.address = address;
  if (city !== null) textFields.city = city;
  if (neighborhood !== null) textFields.neighborhood = neighborhood;

  try {
    const query = buildGeoQuery(venue, address, city, neighborhood);

    if (!query) {
      console.log(`[geo-worker] No geocodable location data for video ${id} — writing text fields only`);
      if (Object.keys(textFields).length > 0) {
        const { error } = await supabase.from("clipnest_videos").update(textFields).eq("id", id);
        if (error) throw error;
      }
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
        .update({ ...textFields, ...(coords ?? {}) })
        .eq("id", id);
      if (error) throw error;
    }

    await queueArchive(supabase, "geo_jobs", msg_id);
    console.log(`[geo-worker] Done for video ${id}`);

    // Chain-invoke self to drain the queue
    callFunction("geo-worker", {}, supabaseUrl, functionKey).catch((err) => {
      console.error("[geo-worker] Failed to chain-invoke self:", err);
    });

    return new Response("OK", { status: 200 });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[geo-worker] Failed for video ${id} (skipping):`, errorMsg);
    // Best-effort: still write text fields even if Mapbox failed
    if (Object.keys(textFields).length > 0) {
      await supabase.from("clipnest_videos").update(textFields).eq("id", id).catch(() => {});
    }
    // Archive so the job doesn't retry
    await queueArchive(supabase, "geo_jobs", msg_id).catch(() => {});
    return new Response("OK", { status: 200 });
  }
});
