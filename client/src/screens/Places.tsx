/**
 * Places — list/add/edit/delete geofenced locations.
 *
 * Add flow: tap "+ Add current location" → bridge.getCurrentLocation() → user
 * names it → INSERT row + sync OS geofence set. Default radius 25 m.
 *
 * Edit flow: tap a row → modal with radius slider (15–500 m) and Delete.
 *
 * Reachable from Settings → Places. No own bottom-nav slot; the floating nav
 * highlights "Settings" while this screen is mounted.
 */
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LifeOsBridge } from '../bridge/lifeOsBridge';
import {
  addPlace,
  deletePlace,
  listPlaces,
  updatePlaceRadius,
  PLACES_DEFAULT_RADIUS_M,
} from '../repos/places';
import type { PlaceRow } from '../db/schema';
import { useTheme } from '../theme';
import { useToast } from '../toast';
import { ActionButton, makeStyles, useAsyncRunner } from './shared';
import { SectionHeader } from './widgets';

const RADIUS_PRESETS = [25, 50, 100, 200];

export function PlacesScreen({ onBack }: { onBack: () => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();

  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pendingPin, setPendingPin] = useState<{
    lat: number;
    lng: number;
    accuracyM: number;
  } | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [editing, setEditing] = useState<PlaceRow | null>(null);
  const [editRadius, setEditRadius] = useState(PLACES_DEFAULT_RADIUS_M);

  const refresh = async () => {
    const r = await run('places load', () => listPlaces(), setLoading);
    if (r) setPlaces(r);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCaptureCurrent = async () => {
    if (Platform.OS !== 'android' || !LifeOsBridge) {
      toast.error('current-location capture only works on Android');
      return;
    }
    const fix = await run(
      'capture location',
      () => LifeOsBridge.getCurrentLocation(),
      setAdding,
    );
    if (!fix) return;
    setPendingPin({ lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM });
    setLabelDraft('');
  };

  const onSaveNewPlace = async () => {
    if (!pendingPin) return;
    const label = labelDraft.trim();
    if (!label) {
      toast.error('Name the place first');
      return;
    }
    const ok = await run(
      'save place',
      async () => {
        await addPlace({
          label,
          lat: pendingPin.lat,
          lng: pendingPin.lng,
          radiusM: PLACES_DEFAULT_RADIUS_M,
        });
        return true;
      },
      setAdding,
    );
    if (ok) {
      toast.ok(`Saved "${label}" (25 m)`);
      setPendingPin(null);
      setLabelDraft('');
      await refresh();
    }
  };

  const onConfirmDelete = (place: PlaceRow) => {
    Alert.alert('Delete place?', `"${place.label}" will be removed and its geofence cleared.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const ok = await run('delete place', async () => {
            await deletePlace(place.id);
            return true;
          });
          if (ok) {
            toast.ok('Deleted');
            setEditing(null);
            await refresh();
          }
        },
      },
    ]);
  };

  const onSaveRadius = async () => {
    if (!editing) return;
    const ok = await run('update radius', async () => {
      await updatePlaceRadius(editing.id, editRadius);
      return true;
    });
    if (ok) {
      toast.ok(`Radius set to ${editRadius} m`);
      setEditing(null);
      await refresh();
    }
  };

  return (
    <ScrollView contentContainerStyle={s.body}>
      <Pressable onPress={onBack} hitSlop={10} style={{ marginBottom: 4 }}>
        <Text style={[s.body2, { color: theme.accent, fontWeight: '700' }]}>‹ Settings</Text>
      </Pressable>

      <View style={s.card}>
        <Text style={s.label}>Places & geofences</Text>
        <Text style={[s.body2, { marginTop: 6, color: theme.textMuted }]}>
          The phone fires geo_enter / geo_exit events when you cross any of these circles.
          Default radius is 25 m. Used by the Today screen and by the AI to learn your
          routine.
        </Text>
      </View>

      <ActionButton
        loading={adding}
        onPress={onCaptureCurrent}
        label="+ Add current location"
      />

      <SectionHeader>Saved places</SectionHeader>
      {loading && places.length === 0 && (
        <View style={[s.card, { alignItems: 'center' }]}>
          <ActivityIndicator color={theme.accent} />
        </View>
      )}
      {!loading && places.length === 0 && (
        <View style={s.card}>
          <Text style={[s.body2, { color: theme.textMuted }]}>
            No places yet. Tap “Add current location” while you're somewhere meaningful (Home,
            Office, Gym).
          </Text>
        </View>
      )}
      {places.map((p) => (
        <Pressable
          key={p.id}
          onPress={() => {
            setEditing(p);
            setEditRadius(p.radius_m);
          }}>
          <View style={s.card}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
              <View style={{ flex: 1 }}>
                <Text style={[s.body2, { fontWeight: '700' }]}>{p.label}</Text>
                <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 2 }]}>
                  {p.lat.toFixed(5)}, {p.lng.toFixed(5)} · {p.radius_m} m
                </Text>
              </View>
              <Text style={[s.tdMono, { color: theme.accent, fontWeight: '700' }]}>Edit →</Text>
            </View>
          </View>
        </Pressable>
      ))}

      {/* Modal — name the new place */}
      <Modal
        visible={pendingPin !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPendingPin(null)}>
        <View style={modalStyles.scrim}>
          <View style={[s.card, { width: '88%', backgroundColor: theme.card }]}>
            <Text style={s.label}>Name this place</Text>
            {pendingPin && (
              <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 4 }]}>
                {pendingPin.lat.toFixed(5)}, {pendingPin.lng.toFixed(5)} · ±
                {Math.round(pendingPin.accuracyM)} m
              </Text>
            )}
            <TextInput
              autoFocus
              placeholder="Office, Home, Gym…"
              placeholderTextColor={theme.inputPlaceholder}
              value={labelDraft}
              onChangeText={setLabelDraft}
              style={s.input}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                onPress={() => setPendingPin(null)}
                style={[s.btnSecondary, { flex: 1 }]}>
                <Text style={s.btnText}>Cancel</Text>
              </Pressable>
              <ActionButton
                loading={adding}
                onPress={onSaveNewPlace}
                label="Save (25 m)"
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal — edit radius / delete */}
      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}>
        <View style={modalStyles.scrim}>
          <View style={[s.card, { width: '88%', backgroundColor: theme.card }]}>
            <Text style={s.label}>{editing?.label}</Text>
            <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 4 }]}>
              radius — currently {editRadius} m
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {RADIUS_PRESETS.map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setEditRadius(r)}
                  style={[s.chipSm, editRadius === r && s.chipActive]}>
                  <Text style={[s.chipText, editRadius === r && s.chipTextActive]}>{r} m</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              placeholder="Custom (15–500 m)"
              placeholderTextColor={theme.inputPlaceholder}
              keyboardType="number-pad"
              value={String(editRadius)}
              onChangeText={(t) => {
                const n = Number(t);
                if (isFinite(n)) setEditRadius(n);
              }}
              style={s.input}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                onPress={() => editing && onConfirmDelete(editing)}
                style={[s.btnSecondary, { flex: 1, borderColor: theme.err }]}>
                <Text style={[s.btnText, { color: theme.err }]}>Delete</Text>
              </Pressable>
              <ActionButton
                loading={false}
                onPress={onSaveRadius}
                label="Save"
                style={{ flex: 1 }}
              />
            </View>
            <Pressable onPress={() => setEditing(null)} style={{ marginTop: 10 }}>
              <Text style={[s.body2, { color: theme.textMuted, textAlign: 'center' }]}>
                Close
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const modalStyles = {
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: 16,
  },
};
