import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from './shared';
import { EventsTable } from './EventsTable';
import { RollupsScreen } from './RollupsScreen';
import { LlmTable } from './LlmTable';
import { NudgesTable } from './NudgesTable';

type ObsSection = 'events' | 'rollups' | 'llm' | 'nudges';
const OBS_SECTIONS: { id: ObsSection; label: string }[] = [
  { id: 'events', label: 'Events' },
  { id: 'rollups', label: 'Rollups' },
  { id: 'llm', label: 'LLM' },
  { id: 'nudges', label: 'Nudges' },
];

export function ObservabilityScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [section, setSection] = useState<ObsSection>('events');

  return (
    <View style={s.bodyTight}>
      {/* Segmented subtab strip — full width, lighter than bottom nav. */}
      <View style={s.seg}>
        {OBS_SECTIONS.map((o) => {
          const active = section === o.id;
          return (
            <Pressable
              key={o.id}
              onPress={() => setSection(o.id)}
              style={[s.segItem, active && s.segItemActive]}>
              <Text style={[s.segText, active && s.segTextActive]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        {section === 'events' && <EventsTable />}
        {section === 'rollups' && <RollupsScreen />}
        {section === 'llm' && <LlmTable />}
        {section === 'nudges' && <NudgesTable />}
      </View>
    </View>
  );
}
