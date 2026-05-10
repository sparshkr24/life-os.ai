/**
 * Reverse geocoder — Nominatim (OpenStreetMap) wrapper.
 *
 * Called by the geocode worker once a `place_visit` row has been written
 * with status='pending_geocode'. We:
 *
 *   1. Quantize (lat, lng) to ~11m and look up `geocode_cache`. If found
 *      and < 24h old, return the cached result.
 *   2. Otherwise GET https://nominatim.openstreetmap.org/reverse with the
 *      Nominatim-mandated User-Agent that includes a per-install UUID so
 *      our 1 req/sec & 10k/day budget is per-user, not per-app-build.
 *   3. Map the response's class/type pair to our coarse vocabulary
 *      (cafe, restaurant, shop_alcohol, ...) and assign a confidence
 *      score per docs/CLAUDE.md §6.4.
 *   4. Cache and return.
 *
 * Local-first: nothing leaves the phone except the single GET; we extract
 * our schema fields and discard the rest of the response.
 */
import { withDb } from '../db';
import type { GeocodeCacheRow } from '../db/schema';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const CACHE_TTL_MS = 24 * 3600_000;
/** Nominatim TOS: 1 req/sec hard limit. We serialize calls with this gap. */
const MIN_REQUEST_GAP_MS = 1100;
let lastRequestMs = 0;

export interface GeocodeResult {
  name: string | null;
  category: string | null;
  confidence: number;
  cached: boolean;
}

/**
 * Per-install UUID, persisted in `schema_meta`. Sent in the Nominatim
 * `User-Agent` so each user has their own 10k/day quota — a single shared
 * UA across all our installs would be one big bucket the OSM ops team
 * could (rightfully) rate-limit collectively.
 */
const META_INSTALL_ID = 'install_id';
let cachedInstallId: string | null = null;

export async function getInstallId(): Promise<string> {
  if (cachedInstallId) return cachedInstallId;
  const row = await withDb((db) =>
    db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = ?`,
      [META_INSTALL_ID],
    ),
  );
  if (row?.value) {
    cachedInstallId = row.value;
    return cachedInstallId;
  }
  const fresh = generateUuid();
  await withDb((db) =>
    db.runAsync(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_INSTALL_ID, fresh],
    ),
  );
  cachedInstallId = fresh;
  return fresh;
}

function generateUuid(): string {
  // Lightweight RFC4122-ish v4. We don't depend on `crypto` to keep this
  // portable across the RN/Hermes runtime; a 32-hex random string with
  // dashes is enough for an install identifier.
  const r = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  return `${r()}-${r().slice(0, 4)}-4${r().slice(0, 3)}-a${r().slice(0, 3)}-${r()}${r().slice(0, 4)}`;
}

function quantize(coord: number): number {
  return Math.round(coord * 10000);
}

async function readCache(lat: number, lng: number): Promise<GeocodeResult | null> {
  const lat_q = quantize(lat);
  const lng_q = quantize(lng);
  const row = await withDb((db) =>
    db.getFirstAsync<GeocodeCacheRow>(
      `SELECT * FROM geocode_cache WHERE lat_q = ? AND lng_q = ?`,
      [lat_q, lng_q],
    ),
  );
  if (!row) return null;
  if (Date.now() - row.cached_ts > CACHE_TTL_MS) return null;
  return {
    name: row.name,
    category: row.category,
    confidence: row.confidence ?? 0,
    cached: true,
  };
}

async function writeCache(
  lat: number,
  lng: number,
  result: GeocodeResult,
  raw: string,
): Promise<void> {
  const lat_q = quantize(lat);
  const lng_q = quantize(lng);
  await withDb((db) =>
    db.runAsync(
      `INSERT INTO geocode_cache (lat_q, lng_q, name, category, confidence, raw_response, cached_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lat_q, lng_q) DO UPDATE SET
         name = excluded.name,
         category = excluded.category,
         confidence = excluded.confidence,
         raw_response = excluded.raw_response,
         cached_ts = excluded.cached_ts`,
      [lat_q, lng_q, result.name, result.category, result.confidence, raw, Date.now()],
    ),
  );
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  const cached = await readCache(lat, lng);
  if (cached) return cached;

  // Serialize requests to obey Nominatim's 1 req/sec.
  const wait = Math.max(0, lastRequestMs + MIN_REQUEST_GAP_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const installId = await getInstallId();
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: lat.toFixed(6),
    lon: lng.toFixed(6),
    zoom: '18',
    addressdetails: '1',
    extratags: '1',
    namedetails: '1',
  });
  const url = `${NOMINATIM_URL}?${params.toString()}`;

  let raw = '';
  try {
    lastRequestMs = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': `AILifeOS/1.0 (sideload; install=${installId})`,
        'Accept-Language': 'en',
      },
    });
    if (!res.ok) {
      console.warn(`[geocoder] nominatim ${res.status} for ${lat},${lng}`);
      return { name: null, category: null, confidence: 0, cached: false };
    }
    raw = await res.text();
    const parsed = parseNominatim(raw);
    await writeCache(lat, lng, parsed, raw);
    return parsed;
  } catch (e) {
    console.error(
      '[geocoder] fetch failed:',
      e instanceof Error ? e.message : String(e),
    );
    return { name: null, category: null, confidence: 0, cached: false };
  }
}

interface NominatimResponse {
  name?: string;
  display_name?: string;
  class?: string;
  type?: string;
  address?: Record<string, string | undefined>;
  extratags?: Record<string, string | undefined>;
  namedetails?: Record<string, string | undefined>;
}

/**
 * Map Nominatim class/type to our coarse vocabulary, and compute
 * confidence. Single distinct POI within 50m → 0.9; address-only → 0.3.
 *
 * Nominatim's reverse endpoint always returns ONE result (the closest
 * feature), so we don't get a "how many candidates" signal directly.
 * Confidence comes from the strength of the class/type match and whether
 * the result has a real `name` (POI) vs only an address.
 */
function parseNominatim(raw: string): GeocodeResult {
  let json: NominatimResponse;
  try {
    json = JSON.parse(raw) as NominatimResponse;
  } catch {
    return { name: null, category: null, confidence: 0, cached: false };
  }
  const name =
    pickName(json.namedetails?.name) ||
    pickName(json.name) ||
    pickName(json.address?.amenity) ||
    pickName(json.address?.shop) ||
    pickName(json.address?.tourism) ||
    pickName(json.address?.leisure) ||
    null;
  const category = mapCategory(json.class, json.type);
  const hasName = !!name;
  const hasCategory = !!category;

  let confidence = 0.3;
  if (hasName && hasCategory) confidence = 0.85;
  else if (hasName || hasCategory) confidence = 0.55;

  // If we couldn't even synthesize a label, fall back to a road / address
  // string from `display_name` (first comma-separated chunk) so the user
  // gets *something* in the timeline.
  let displayName: string | null = name;
  if (!displayName && json.display_name) {
    const first = json.display_name.split(',')[0]?.trim();
    if (first) displayName = first;
  }

  return {
    name: displayName,
    category,
    confidence,
    cached: false,
  };
}

function pickName(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s.slice(0, 80) : null;
}

/**
 * Vocabulary from docs/CLAUDE.md §6.4. Order matters \u2014 first match wins.
 */
function mapCategory(klass: string | undefined, type: string | undefined): string | null {
  const c = (klass ?? '').toLowerCase();
  const t = (type ?? '').toLowerCase();
  if (c === 'amenity') {
    if (t === 'cafe' || t === 'coffee_shop') return 'cafe';
    if (t === 'restaurant' || t === 'fast_food' || t === 'food_court') return 'restaurant';
    if (t === 'bar' || t === 'pub' || t === 'nightclub') return 'restaurant';
    if (t === 'hospital' || t === 'clinic' || t === 'pharmacy' || t === 'doctors') return 'health';
    if (t === 'school' || t === 'university' || t === 'college' || t === 'library') return 'education';
    if (t === 'place_of_worship') return 'worship';
    if (t === 'fuel') return 'fuel';
    if (t === 'bank' || t === 'atm') return 'finance';
  }
  if (c === 'shop') {
    if (t === 'alcohol' || t === 'wine' || t === 'beverages') return 'shop_alcohol';
    if (t === 'supermarket' || t === 'convenience' || t === 'grocery') return 'shop_grocery';
    return 'shop_other';
  }
  if (c === 'leisure') {
    if (t === 'fitness_centre' || t === 'sports_centre') return 'gym';
    if (t === 'park' || t === 'garden') return 'leisure';
    return 'leisure';
  }
  if (c === 'tourism') return 'leisure';
  if (c === 'office') return 'office_other';
  if (c === 'building') {
    // Bare building \u2014 no clear function. Fall through to address-only.
    return null;
  }
  return null;
}
