/**
 * Deterministic memory maintenance sweep. Runs after the nightly memory pass.
 *
 * Pure SQL safety net — archives rows the LLM may have missed:
 *   - Failed predictions never reinforced
 *   - Consistently disproven (contradiction≥3 AND ≥2×reinforcement)
 *   - Confidence < 0.10 with no reinforcement
 *   - Consolidation children whose parent is ≥14 days old
 *
 * Soft-delete only. Idempotent (every UPDATE includes `archived_ts IS NULL`).
 */
import { withDb } from '../db';

export interface MaintenanceReport {
  /** Predictions the LLM verified as wrong AND that have never been reinforced. */
  archivedFailedPredictions: number;
  /** Memories with consistent contradiction signal (>=3 contradictions, ratio ≥2:1 vs reinforcement). */
  archivedContradicted: number;
  /** Memories whose confidence dropped below the floor and have no recent reinforcement. */
  archivedLowConfidence: number;
  /** Children of a still-active consolidation parent that haven't been touched in 14d. */
  archivedSupersededChildren: number;
}

const LOW_CONFIDENCE_FLOOR = 0.1;
const CONTRADICTION_MIN = 3;
const CHILD_GRACE_MS = 14 * 86_400_000;

export async function runMemoryMaintenance(): Promise<MaintenanceReport> {
  const now = Date.now();
  return withDb(async (db) => {
    const failed = await db.runAsync(
      `UPDATE memories
         SET archived_ts = ?, updated_ts = ?
       WHERE archived_ts IS NULL
         AND was_correct = 0
         AND reinforcement = 0`,
      [now, now],
    );

    const contradicted = await db.runAsync(
      `UPDATE memories
         SET archived_ts = ?, updated_ts = ?
       WHERE archived_ts IS NULL
         AND contradiction >= ?
         AND contradiction >= 2 * reinforcement`,
      [now, now, CONTRADICTION_MIN],
    );

    const lowConfidence = await db.runAsync(
      `UPDATE memories
         SET archived_ts = ?, updated_ts = ?
       WHERE archived_ts IS NULL
         AND confidence < ?
         AND reinforcement = 0`,
      [now, now, LOW_CONFIDENCE_FLOOR],
    );

    // A consolidation parent that has been alive (active) for >14 days
    // implies the children's evidence is now folded into the parent.
    const cutoff = now - CHILD_GRACE_MS;
    const supersededChildren = await db.runAsync(
      `UPDATE memories
         SET archived_ts = ?, updated_ts = ?
       WHERE archived_ts IS NULL
         AND parent_id IS NOT NULL
         AND parent_id IN (
           SELECT id FROM memories
            WHERE archived_ts IS NULL
              AND child_ids IS NOT NULL
              AND created_ts < ?
         )`,
      [now, now, cutoff],
    );

    return {
      archivedFailedPredictions: failed.changes,
      archivedContradicted: contradicted.changes,
      archivedLowConfidence: lowConfidence.changes,
      archivedSupersededChildren: supersededChildren.changes,
    };
  });
}
