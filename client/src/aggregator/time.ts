/**
 * Local-time helpers used by the aggregator. Hermes ships Intl.DateTimeFormat
 * with full IANA tz support, so no Luxon dep needed.
 */

/** Hour-of-day (0–23) for `ms` in IANA `tz`. */
export function localHour(ms: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return Number(fmt.format(new Date(ms)));
}

/** 'YYYY-MM-DD' for `ms` in IANA `tz`. */
export function localDateStr(ms: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(ms));
}

/** 'YYYY-MM' for `ms` in IANA `tz`. */
export function localMonthStr(ms: number, tz: string): string {
  return localDateStr(ms, tz).slice(0, 7);
}

/** Epoch ms for the start of local-tz day `date` ('YYYY-MM-DD'). */
export function localDayStartMs(date: string, tz: string): number {
  // Search a 36h window around naive UTC midnight; pick the timestamp whose
  // tz-local representation lands exactly on `date 00:00:00`.
  const naive = Date.parse(`${date}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  for (let offset = -14 * 3600_000; offset <= 14 * 3600_000; offset += 60_000) {
    const t = naive + offset;
    const parts = fmt.formatToParts(new Date(t));
    const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? '';
    const ymd = `${get('year')}-${get('month')}-${get('day')}`;
    if (ymd === date && get('hour') === '00' && get('minute') === '00' && get('second') === '00') {
      return t;
    }
  }
  return naive;
}

/** 'YYYY-MM-DD' for the day before `date`. */
export function prevDate(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`) - 24 * 3600_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' for the day after `date`. */
export function nextDate(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`) + 24 * 3600_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Best-effort device timezone; falls back to 'UTC'. */
export function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
