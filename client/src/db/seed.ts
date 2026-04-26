import type { AppCategory, RemindStrategy } from './schema';

/**
 * Curated app classification seed. Stage 1 covers the ~15 apps the user
 * actually opens daily. Unknown packages default to 'neutral' at runtime
 * (logic lives in classifier in a later stage).
 */
export const SEED_APP_CATEGORIES: ReadonlyArray<{
  pkg: string;
  category: AppCategory;
}> = [
  // unproductive
  { pkg: 'com.instagram.android', category: 'unproductive' },
  { pkg: 'com.zhiliaoapp.musically', category: 'unproductive' }, // TikTok
  { pkg: 'com.google.android.youtube', category: 'unproductive' },
  // neutral
  { pkg: 'com.whatsapp', category: 'neutral' },
  { pkg: 'com.android.chrome', category: 'neutral' },
  { pkg: 'com.google.android.apps.maps', category: 'neutral' },
  { pkg: 'com.spotify.music', category: 'neutral' },
  { pkg: 'com.linkedin.android', category: 'neutral' },
  { pkg: 'com.android.camera', category: 'neutral' },
  { pkg: 'com.android.settings', category: 'neutral' },
  { pkg: 'com.android.dialer', category: 'neutral' },
  // productive
  { pkg: 'com.google.android.gm', category: 'productive' }, // Gmail
  { pkg: 'com.google.android.apps.docs.editors.docs', category: 'productive' },
  { pkg: 'notion.id', category: 'productive' },
  { pkg: 'com.Slack', category: 'productive' },
];

interface SeedRule {
  id: string;
  name: string;
  trigger: Record<string, unknown>;
  action: { level: 1 | 2 | 3; message: string };
  cooldown_min: number;
}

export const SEED_RULES: readonly SeedRule[] = [
  {
    id: 'rule.late_night_instagram',
    name: 'Late-night Instagram',
    trigger: {
      app: 'com.instagram.android',
      after_local: '22:00',
      threshold_min_today: 30,
    },
    action: {
      level: 1,
      message: "It's getting late. Eight hours of sleep starts now.",
    },
    cooldown_min: 45,
  },
  {
    id: 'rule.morning_phone_grab',
    name: 'Phone within 2 min of waking',
    trigger: {
      after_event: 'wake',
      within_sec: 120,
      app_any: ['com.instagram.android', 'com.zhiliaoapp.musically'],
    },
    action: {
      level: 1,
      message: 'Stretch first. The feed will be there in 5.',
    },
    cooldown_min: 240,
  },
  {
    id: 'rule.unproductive_workhours',
    name: 'Distraction during work hours',
    trigger: {
      between_local: ['10:00', '17:00'],
      category: 'unproductive',
      threshold_min_today: 45,
      location: 'office',
    },
    action: { level: 2, message: 'Back to it. You scheduled deep work now.' },
    cooldown_min: 60,
  },
];

/** Used by todos created during onboarding examples. */
export const DEFAULT_REMIND_STRATEGY: RemindStrategy = 'none';
