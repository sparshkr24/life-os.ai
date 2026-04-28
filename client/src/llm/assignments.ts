/**
 * Per-task model assignments persisted in `schema_meta` under one JSON blob.
 *
 * Storage key: `task_assignments` → `{ "nightly": "claude-sonnet-…", "chat": "…", … }`.
 * Missing keys fall back to `DEFAULT_TASK_MODELS`. Validation re-checks the
 * model exists in the catalogue and that its provider has a key set; if not,
 * the router falls back to the default.
 */
import { withDb } from '../db';
import { DEFAULT_TASK_MODELS, findModel } from './models';
import { getProviderKey } from './keys';
import type { ProviderId, TaskKind } from './types';

const META_KEY = 'task_assignments';

export type TaskAssignmentMap = Partial<Record<TaskKind, string>>;

export async function loadAssignments(): Promise<TaskAssignmentMap> {
  const row = await withDb(async (db) =>
    db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = ?`,
      [META_KEY],
    ),
  );
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as TaskAssignmentMap;
  } catch {
    return {};
  }
}

export async function saveAssignments(map: TaskAssignmentMap): Promise<void> {
  const cleaned: TaskAssignmentMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string' && v.length > 0) cleaned[k as TaskKind] = v;
  }
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_KEY, JSON.stringify(cleaned)],
    );
  });
}

export async function setAssignment(task: TaskKind, modelId: string): Promise<void> {
  const map = await loadAssignments();
  map[task] = modelId;
  await saveAssignments(map);
}

export interface ResolvedAssignment {
  task: TaskKind;
  modelId: string;
  provider: ProviderId;
  hasKey: boolean;
  isDefault: boolean;
}

/**
 * Resolve the model id for a task. Falls through to default if:
 *  - user hasn't picked one,
 *  - the picked model id is no longer in the catalogue,
 *  - the picked model's provider has no key (router will skip the call too).
 *
 * Returns null only if BOTH the user's pick AND the default fail catalogue
 * lookup, which can only happen if MODELS shrinks. Caller treats null as
 * 'no_assignment' and skips.
 */
export async function resolveAssignment(task: TaskKind): Promise<ResolvedAssignment | null> {
  const map = await loadAssignments();
  const userPick = map[task];
  const defaultPick = DEFAULT_TASK_MODELS[task];

  for (const [candidate, isDefault] of [
    [userPick, false],
    [defaultPick, true],
  ] as Array<[string | undefined, boolean]>) {
    if (!candidate) continue;
    const m = findModel(candidate);
    if (!m) continue;
    const key = await getProviderKey(m.provider);
    return {
      task,
      modelId: m.id,
      provider: m.provider,
      hasKey: key !== null,
      isDefault,
    };
  }
  return null;
}
