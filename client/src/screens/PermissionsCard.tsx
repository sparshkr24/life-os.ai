/**
 * Native permissions card — surfaces all OS-level grants the foreground
 * service needs for Stages 3b–3d. Each row shows current status + a
 * one-tap action. Status is re-polled when the user returns to Settings
 * (parent screen calls `refresh()`); we don't auto-poll here because
 * permission changes happen via system settings, not in-app.
 */
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { LifeOsBridge } from '../bridge/lifeOsBridge';
import { useToast } from '../toast';
import { makeStyles } from './shared';

interface Status {
  usage: boolean | null;
  activity: boolean | null;
  fineLoc: boolean | null;
  bgLoc: boolean | null;
  notif: boolean | null;
  hcAvailable: boolean | null;
}

const initial: Status = {
  usage: null,
  activity: null,
  fineLoc: null,
  bgLoc: null,
  notif: null,
  hcAvailable: null,
};

export function PermissionsCard() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const toast = useToast();
  const [st, setSt] = useState<Status>(initial);

  const refresh = async () => {
    if (!LifeOsBridge) return;
    try {
      const [usage, activity, loc, notif, hc] = await Promise.all([
        LifeOsBridge.hasUsageAccess(),
        LifeOsBridge.hasActivityRecognitionPermission(),
        LifeOsBridge.hasLocationPermissions(),
        LifeOsBridge.hasNotificationListenerAccess(),
        LifeOsBridge.isHealthConnectAvailable(),
      ]);
      setSt({
        usage,
        activity,
        fineLoc: loc.fine,
        bgLoc: loc.background,
        notif,
        hcAvailable: hc,
      });
    } catch (e) {
      console.error('[permissions refresh]', e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!LifeOsBridge) {
    return (
      <View style={s.card}>
        <Text style={s.label}>Native permissions</Text>
        <Text style={s.muted}>Android only — bridge not loaded.</Text>
      </View>
    );
  }

  const wrap = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      // After any system-settings round-trip, re-poll on next focus.
      setTimeout(refresh, 500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(label + ' failed: ' + msg);
    }
  };

  return (
    <View style={s.card}>
      <Text style={s.label}>Native permissions</Text>
      <Row
        title="Usage access"
        sub="app foreground/background events (Stage 3a)"
        granted={st.usage}
        actionLabel="Open settings"
        onAction={wrap('open usage', () => LifeOsBridge.openUsageAccessSettings())}
      />
      <Row
        title="Activity recognition"
        sub="walking / vehicle / sleep transitions (Stage 3b)"
        granted={st.activity}
        actionLabel="Grant"
        onAction={wrap('grant AR', async () => {
          await LifeOsBridge.requestActivityRecognitionPermission();
        })}
      />
      <Row
        title="Location (foreground)"
        sub="needed before background — Stage 3c"
        granted={st.fineLoc}
        actionLabel="Grant"
        onAction={wrap('grant fg loc', async () => {
          await LifeOsBridge.requestForegroundLocation();
        })}
      />
      <Row
        title="Location (background)"
        sub="geofence enter/exit while app closed (Stage 3c)"
        granted={st.bgLoc}
        actionLabel="Grant"
        onAction={wrap('grant bg loc', async () => {
          await LifeOsBridge.requestBackgroundLocation();
        })}
      />
      <Row
        title="Notification listener"
        sub="incoming notif metadata, no content (Stage 3c)"
        granted={st.notif}
        actionLabel="Open settings"
        onAction={wrap('open notif', () => LifeOsBridge.openNotificationListenerSettings())}
      />
      <Row
        title="Health Connect"
        sub="steps + heart rate + exercise (Stage 3d)"
        granted={st.hcAvailable}
        actionLabel={st.hcAvailable ? 'Open' : 'Install'}
        onAction={wrap('open HC', () => LifeOsBridge.openHealthConnect())}
      />
      <Pressable onPress={refresh} style={s.btnGhost}>
        <Text style={s.btnGhostText}>Refresh status →</Text>
      </Pressable>
    </View>
  );
}

function Row({
  title,
  sub,
  granted,
  actionLabel,
  onAction,
}: {
  title: string;
  sub: string;
  granted: boolean | null;
  actionLabel: string;
  onAction: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const dotColor =
    granted === null ? theme.textFaint : granted ? theme.ok : theme.warn;
  const stateLabel = granted === null ? '—' : granted ? 'granted' : 'missing';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderColor: theme.rowBorder,
      }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: dotColor,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text style={s.body2}>{title}</Text>
        <Text style={s.muted}>
          {stateLabel} · {sub}
        </Text>
      </View>
      <Pressable onPress={onAction} style={s.btnInline}>
        <Text style={s.btnText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}
