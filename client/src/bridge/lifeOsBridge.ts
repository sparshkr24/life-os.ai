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

  // Stage 3b — Activity Recognition + Sleep API.
  hasActivityRecognitionPermission(): Promise<boolean>;
  requestActivityRecognitionPermission(): Promise<void>;

  // Stage 3c — Location + Geofencing.
  hasLocationPermissions(): Promise<{ fine: boolean; background: boolean }>;
  requestForegroundLocation(): Promise<void>;
  requestBackgroundLocation(): Promise<void>;
  setGeofences(places: LifeOsPlace[]): Promise<number>;
  removeAllGeofences(): Promise<void>;

  // v7 — one-shot current location for the Places UI / proactive questions.
  getCurrentLocation(): Promise<{
    lat: number;
    lng: number;
    accuracyM: number;
    ts: number;
  }>;

  // Stage 3d — Health Connect.
  isHealthConnectAvailable(): Promise<boolean>;
  openHealthConnect(): Promise<void>;
};

export const LifeOsBridge = NativeModules.LifeOsBridge as LifeOsBridgeNative;
