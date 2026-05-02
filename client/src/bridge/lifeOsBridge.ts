import { NativeModules } from 'react-native';

export interface LifeOsPlace {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
}

type LifeOsBridgeNative = {
  startService(): Promise<void>;
  stopService(): Promise<void>;
  hasUsageAccess(): Promise<boolean>;
  openUsageAccessSettings(): Promise<void>;
  getStats(): Promise<{
    eventsLastHour: number;
    totalEvents: number;
    lastInsertTs: number;
    dbExists: boolean;
  }>;

  hasActivityRecognitionPermission(): Promise<boolean>;
  requestActivityRecognitionPermission(): Promise<void>;

  hasLocationPermissions(): Promise<{ fine: boolean; background: boolean }>;
  requestForegroundLocation(): Promise<void>;
  requestBackgroundLocation(): Promise<void>;
  setGeofences(places: LifeOsPlace[]): Promise<number>;
  removeAllGeofences(): Promise<void>;

  /** One-shot GPS fix. Used by the Places UI and the proactive question engine. */
  getCurrentLocation(): Promise<{
    lat: number;
    lng: number;
    accuracyM: number;
    ts: number;
  }>;

  isHealthConnectAvailable(): Promise<boolean>;
  openHealthConnect(): Promise<void>;
};

export const LifeOsBridge = NativeModules.LifeOsBridge as LifeOsBridgeNative;
