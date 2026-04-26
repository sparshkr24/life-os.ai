import { NativeModules } from 'react-native';

type LifeOsBridgeNative = {
  startService(): Promise<void>;
  hasUsageAccess(): Promise<boolean>;
  openUsageAccessSettings(): Promise<void>;
  getStats(): Promise<{ eventsLastHour: number; lastInsertTs: number }>;
};

export const LifeOsBridge = NativeModules.LifeOsBridge as LifeOsBridgeNative;
