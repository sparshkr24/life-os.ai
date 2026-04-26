import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  Pressable,
  Text,
  View,
} from 'react-native';
import { listEvents, eventTotalCount } from '../repos/observability';
import type { EventRow } from '../db/schema';
import { reopenDb } from '../db';
import { useTheme } from '../theme';
import {
  ActionButton,
  fmtClock,
  fmtDur,
  fmtTime,
  fmtTimeShort,
  makeStyles,
  parseEvent,
  prettyPkg,
  useAsyncRunner,
} from './shared';
import { AppIcon } from './widgets';

const PAGE_SIZE = 25;
const NEAR_END_THRESHOLD = 0.4; // trigger next page when within 40% of the bottom

export function EventsTable() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [rows, setRows] = useState<EventRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  // `loading` covers the initial fetch only — used for the skeleton state.
  const [loading, setLoading] = useState(false);
  // `loadingMore` covers infinite-scroll page loads.
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [done, setDone] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const reqIdRef = useRef(0);
  // Track current offset via ref so loadMore always reads the latest value
  // even when the rows state hasn't updated yet (stale-closure guard).
  const offsetRef = useRef(0);

  const loadInitial = async () => {
    const myReq = ++reqIdRef.current;
    offsetRef.current = 0;
    const result = await run(
      'events',
      async () => {
        // Force a fresh JS connection so writes from the Kotlin foreground
        // service (a separate SQLiteDatabase handle in this process) are
        // visible — expo-sqlite's long-lived connection can otherwise hold a
        // stale WAL read snapshot.
        await reopenDb();
        const [list, t] = await Promise.all([
          listEvents({ limit: PAGE_SIZE, offset: 0 }),
          eventTotalCount(),
        ]);
        const newest = list[0]?.ts ?? 0;
        console.log(
          '[obs] loadInitial total=' +
            t +
            ' returned=' +
            list.length +
            ' newestTs=' +
            (newest ? new Date(newest).toLocaleTimeString() : 'none'),
        );
        return { list, t };
      },
      setLoading,
    );
    if (myReq !== reqIdRef.current) return;
    setHasFetched(true);
    if (result) {
      setRows(result.list);
      setTotal(result.t);
      offsetRef.current = result.list.length;
      setDone(result.list.length < PAGE_SIZE);
    }
  };

  const loadMore = async () => {
    if (done || loadingMore || loading) return;
    const myReq = reqIdRef.current;
    const offset = offsetRef.current;
    setLoadingMore(true);
    try {
      const next = await listEvents({ limit: PAGE_SIZE, offset });
      if (myReq !== reqIdRef.current) return;
      if (next.length === 0) {
        setDone(true);
      } else {
        // Deduplicate by id in case onEndReached fires twice before state settles.
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          const fresh = next.filter((r) => !seen.has(r.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        offsetRef.current = offset + next.length;
        if (next.length < PAGE_SIZE) setDone(true);
      }
    } catch (e) {
      console.error('[events loadMore]', e);
    } finally {
      setLoadingMore(false);
    }
  };

  // Defer the initial fetch until after navigation/animation settles.
  // Without this, mounting EventsTable on tab-switch blocks the JS thread
  // long enough to make the bottom-nav spring animation jitter.
  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => {
      loadInitial();
    });
    return () => handle.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderItem = ({ item: r }: { item: EventRow }) => {
    const isOpen = expanded === r.id;
    const p = parseEvent(r);
    const tint = theme.kindColors[r.kind] ?? theme.accent;
    const appLabel = p.pkg ? prettyPkg(p.pkg) : r.kind;
    const sub =
      r.kind === 'app_fg' || r.kind === 'app_bg'
        ? `${fmtClock(p.startTs)} → ${fmtClock(p.endTs)}`
        : r.kind.replace(/_/g, ' ');
    return (
      <Pressable onPress={() => setExpanded(isOpen ? null : r.id)} style={s.eventRow}>
        <View style={[s.eventTint, { backgroundColor: tint }]} />
        <View style={s.eventInner}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <AppIcon label={appLabel} pkg={p.pkg} fallback={tint} size={34} />
            <View style={{ flex: 1 }}>
              <Text style={s.eventApp} numberOfLines={1}>
                {appLabel}
              </Text>
              <Text style={[s.tdMonoSm, { color: theme.textFaint }]} numberOfLines={1}>
                {sub}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[s.tdMono, { color: theme.text, fontWeight: '700' }]}>
                {fmtDur(p.durationMs)}
              </Text>
              <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
                {fmtTimeShort(r.ts)}
              </Text>
            </View>
          </View>
          {isOpen && (
            <View style={{ marginTop: 8, gap: 4 }}>
              {p.pkg && (
                <Text style={s.tdMonoSm}>
                  <Text style={s.kvKey}>pkg </Text>
                  {p.pkg}
                </Text>
              )}
              <Text style={s.tdMonoSm}>
                <Text style={s.kvKey}>start </Text>
                {fmtTime(p.startTs)}
              </Text>
              <Text style={s.tdMonoSm}>
                <Text style={s.kvKey}>end </Text>
                {fmtTime(p.endTs)}
              </Text>
              {p.source && (
                <Text style={s.tdMonoSm}>
                  <Text style={s.kvKey}>src </Text>
                  {p.source}
                </Text>
              )}
              <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>{r.payload}</Text>
            </View>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={s.flexFill}>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 1 }]}>Event</Text>
        <Text style={[s.thCell, { textAlign: 'right' }]}>Duration · Time</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.id)}
        renderItem={renderItem}
        style={s.list}
        contentContainerStyle={{ paddingBottom: 120 }}
        onEndReached={loadMore}
        onEndReachedThreshold={NEAR_END_THRESHOLD}
        // Virtualization tuning so older rows are recycled.
        initialNumToRender={PAGE_SIZE}
        windowSize={7}
        removeClippedSubviews
        ListEmptyComponent={
          loading ? (
            <View style={s.inlineLoad}>
              <ActivityIndicator color={theme.accent} />
              <Text style={s.muted}>loading events…</Text>
            </View>
          ) : hasFetched ? (
            <Text style={s.muted}>no events yet</Text>
          ) : (
            <View style={s.inlineLoad}>
              <ActivityIndicator color={theme.accent} />
              <Text style={s.muted}>loading…</Text>
            </View>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={s.inlineLoad}>
              <ActivityIndicator color={theme.accent} size="small" />
              <Text style={s.muted}>loading more…</Text>
            </View>
          ) : done && rows.length > 0 ? (
            <Text style={[s.muted, { textAlign: 'center' }]}>— end of list —</Text>
          ) : null
        }
      />
      <ActionButton
        onPress={loadInitial}
        loading={loading}
        label={`Refresh · ${rows.length} of ${total}`}
        variant="secondary"
      />
    </View>
  );
}
