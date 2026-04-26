import { NativeModules } from 'react-native';

export interface LifeOsPlace {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
}

type LifeOsBridgeNative = {
  startService(): Promise<void>;
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

  // Stage 3c — NotificationListener.
  hasNotificationListenerAccess(): Promise<boolean>;
  openNotificationListenerSettings(): Promise<void>;

  // Stage 3d — Health Connect.
  isHealthConnectAvailable(): Promise<boolean>;
  openHealthConnect(): Promise<void>;
};

export const LifeOsBridge = NativeModules.LifeOsBridge as LifeOsBridgeNative;
