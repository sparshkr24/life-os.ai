/**
 * Places repository. Thin wrapper over the `places` table.
 *
 * Every mutation also re-registers the geofence list with the OS via the
 * Kotlin bridge — that's the only way OS geofencing actually starts firing.
 * If the bridge isn't available (web / dev), the DB write still happens;
 * geofences just won't trigger.
 */
import { Platform } from 'react-native';
import { withDb } from '../db';
import { LifeOsBridge } from '../bridge/lifeOsBridge';
import type { PlaceKind, PlaceRow } from '../db/schema';

const DEFAULT_RADIUS_M = 25;
/** Auto places (Nominatim-detected) get a slightly larger fence than user
 *  places \u2014 our lat/lng came from a single FusedLocation fix that can be
 *  off by 30\u201340m, so a 50m radius reduces re-triggers from GPS jitter. */
const AUTO_RADIUS_M = 50;

export async function listPlaces(): Promise<PlaceRow[]> {
  return withDb((db) =>
    db.getAllAsync<PlaceRow>(`SELECT * FROM places ORDER BY label ASC`),
  );
}

export async function addPlace(input: {
  label: string;
  lat: number;
  lng: number;
  radiusM?: number;
  kind?: PlaceKind;
  confidence?: number;
  category?: string;
}): Promise<PlaceRow> {
  const kind: PlaceKind = input.kind ?? 'manual';
  const id = makePlaceId(input.label);
  const radius = clampRadius(
    input.radiusM ?? (kind === 'auto' ? AUTO_RADIUS_M : DEFAULT_RADIUS_M),
  );
  const now = Date.now();
  const row: PlaceRow = {
    id,
    label: input.label.trim().slice(0, 64),
    lat: input.lat,
    lng: input.lng,
    radius_m: radius,
    kind,
    confidence: input.confidence ?? null,
    category: input.category ?? null,
    created_ts: now,
    last_visit_ts: null,
  };
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO places (id, label, lat, lng, radius_m, kind, confidence, category, created_ts, last_visit_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         lat = excluded.lat,
         lng = excluded.lng,
         radius_m = excluded.radius_m,
         kind = excluded.kind,
         confidence = excluded.confidence,
         category = excluded.category`,
      [row.id, row.label, row.lat, row.lng, row.radius_m, row.kind, row.confidence, row.category, row.created_ts],
    );
  });
  await syncGeofences();
  return row;
}

export async function updatePlaceRadius(id: string, radiusM: number): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(`UPDATE places SET radius_m = ? WHERE id = ?`, [
      clampRadius(radiusM),
      id,
    ]);
  });
  await syncGeofences();
}

export async function setPlaceKind(id: string, kind: PlaceKind): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(`UPDATE places SET kind = ? WHERE id = ?`, [kind, id]);
  });
  // Geofence registration set is unchanged (ignored places stay registered),
  // so no syncGeofences call required \u2014 GeofenceReceiver re-reads kind on
  // every transition.
}

export async function setPlaceLastVisit(id: string, ts: number): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(`UPDATE places SET last_visit_ts = ? WHERE id = ?`, [ts, id]);
  });
}

export async function deletePlace(id: string): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(`DELETE FROM places WHERE id = ?`, [id]);
  });
  await syncGeofences();
}

/**
 * Re-register the OS geofence set from the current `places` table. ALL
 * kinds are registered \u2014 manual + auto + ignored \u2014 because we need
 * geofence enters even for ignored places (to suppress dwell detection).
 * GeofenceReceiver consults `places.kind` to decide whether to write the
 * geo_enter / geo_exit event.
 */
export async function syncGeofences(): Promise<number> {
  if (Platform.OS !== 'android' || !LifeOsBridge) return 0;
  const places = await listPlaces();
  return LifeOsBridge.setGeofences(
    places.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, radiusM: p.radius_m })),
  );
}

function clampRadius(r: number): number {
  if (!isFinite(r)) return DEFAULT_RADIUS_M;
  return Math.max(15, Math.min(500, Math.round(r)));
}

/**
 * Build a stable id from the label. Lowercase, alphanum + dash. If two places
 * share a label (rare; user error), append a 4-char random suffix so the
 * ON CONFLICT path doesn't quietly overwrite a different place.
 */
function makePlaceId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 6);
  return slug ? `${slug}-${suffix}` : `place-${suffix}`;
}

export const PLACES_DEFAULT_RADIUS_M = DEFAULT_RADIUS_M;
