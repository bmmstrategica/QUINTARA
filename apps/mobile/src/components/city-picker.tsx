import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useMarket } from '@quintara/app-core';
import { useTheme } from '@/theme';

export const MARKET_STORAGE_KEY = 'quintara.market';
export const saveMarket = (slug: string | null) => { (slug ? AsyncStorage.setItem(MARKET_STORAGE_KEY, slug) : AsyncStorage.removeItem(MARKET_STORAGE_KEY)).catch(() => undefined); };

/** Restores the city chosen on an earlier visit. Rendered once, inside the provider. */
export function RestoreMarket() {
  const { setMarket } = useMarket();
  useEffect(() => { AsyncStorage.getItem(MARKET_STORAGE_KEY).then((slug) => { if (slug) setMarket(slug); }, () => undefined); }, [setMarket]);
  return null;
}

/** Switches the city the app shows: its experiences, members, partners, services and Maison Quintara. */
export function CityPicker() {
  const { markets, market, setMarket } = useMarket();
  const { color, space, radius } = useTheme();
  if (markets.length < 2 || !market) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel="City" contentContainerStyle={{ gap: space.sm }}>
      {markets.map((m) => {
        const on = m.id === market.id;
        return (
          <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => setMarket(m.slug)}
            style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: on ? color.accent : color.line, backgroundColor: on ? color.inverseBg : 'transparent' }}>
            <Text style={{ color: on ? color.inverseInk : color.muted, fontSize: 12, letterSpacing: 1.6, textTransform: 'uppercase' }}>{m.name}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * The city switch in the header, shown as the location icon alone. Tapping it opens the list of open cities.
 */
export function CityButton() {
  const { markets, market, setMarket } = useMarket();
  const { color, space, radius, displayFont } = useTheme();
  const [open, setOpen] = useState(false);
  if (markets.length < 2 || !market) return null;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`City: ${market.name}. Choose a city`} hitSlop={8} onPress={() => setOpen(true)}
        style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: color.line, alignItems: 'center', justifyContent: 'center', marginRight: space.md }}>
        {/* A map pin: a teardrop with a hollow centre. */}
        <View style={{ width: 14, height: 14, borderRadius: 7, borderBottomRightRadius: 0, borderWidth: 1.5, borderColor: color.ink, transform: [{ rotate: '45deg' }], marginTop: -3, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 4, height: 4, borderRadius: 2, borderWidth: 1.2, borderColor: color.ink }} />
        </View>
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close" onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 96, paddingRight: space.md }}>
          <View accessibilityRole="radiogroup" accessibilityLabel="City" style={{ minWidth: 200, backgroundColor: color.raise, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, paddingVertical: space.sm }}>
            {markets.map((m) => {
              const on = m.id === market.id;
              return (
                <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { setMarket(m.slug); setOpen(false); }} style={{ paddingVertical: space.sm, paddingHorizontal: space.md }}>
                  <Text style={{ color: on ? color.accent : color.ink, fontFamily: displayFont, fontSize: 19 }}>{m.name}</Text>
                  <Text style={{ color: color.muted, fontSize: 11, letterSpacing: 1.4 }}>{m.country.toUpperCase()}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
