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
import type { PlaceRow } from '../db/schema';

const DEFAULT_RADIUS_M = 25;

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
}): Promise<PlaceRow> {
  const id = makePlaceId(input.label);
  const radius = clampRadius(input.radiusM ?? DEFAULT_RADIUS_M);
  const row: PlaceRow = {
    id,
    label: input.label.trim().slice(0, 64),
    lat: input.lat,
    lng: input.lng,
    radius_m: radius,
  };
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO places (id, label, lat, lng, radius_m) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         lat = excluded.lat,
         lng = excluded.lng,
         radius_m = excluded.radius_m`,
      [row.id, row.label, row.lat, row.lng, row.radius_m],
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

export async function deletePlace(id: string): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(`DELETE FROM places WHERE id = ?`, [id]);
  });
  await syncGeofences();
}

/** Re-register the OS geofence set from the current `places` table. */
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
