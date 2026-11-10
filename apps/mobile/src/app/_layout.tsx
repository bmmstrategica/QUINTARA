import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createHttpApi, createMockApi } from '@quintara/api-client';
import type { QuintaraApi } from '@quintara/api-client';
import { QuintaraProvider, setVisibilitySource } from '@quintara/app-core';
import { AppState } from 'react-native';

// Live screens (messages, notifications) refresh only while the app is in the foreground.
setVisibilitySource({
  visible: () => AppState.currentState === 'active',
  subscribe: (onChange) => { const subscription = AppState.addEventListener('change', (state) => onChange(state === 'active')); return () => subscription.remove(); },
});
import { CityButton, RestoreMarket, saveMarket } from '@/components/city-picker';
import { SecondStepGate } from '@/components/two-factor';
import { AppLock } from '@/components/app-lock';
import { LapsedScreen } from '@/components/membership';
import { PushBridge } from '@/components/push';
import { useSession } from '@quintara/app-core';
import type { ReactNode } from 'react';
import { ThemeProvider, useTheme } from '@/theme';

/** With EXPO_PUBLIC_API_URL set the app uses the real API; otherwise the in-memory mock. */
function createApi(): QuintaraApi {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  // The session travels in an HttpOnly cookie kept by the device's own cookie store, so app code never holds the token.
  if (baseUrl) return createHttpApi({ baseUrl });
  return createMockApi();
}

/** A member whose membership has lapsed sees the renewal screen in place of the app. */
function LapsedGate({ children }: { children: ReactNode }) {
  const { lapsed } = useSession();
  return lapsed ? <LapsedScreen /> : <>{children}</>;
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell() {
  const [api] = useState(createApi);
  const { name, color, displayFont } = useTheme();
  return (
    <SafeAreaProvider>
      <QuintaraProvider api={api} onMarketChange={saveMarket}>
        <RestoreMarket />
        <StatusBar style={name === 'light' ? 'dark' : 'light'} />
        <SecondStepGate>
        <PushBridge>
        <AppLock>
        <LapsedGate>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: color.bg },
            headerTintColor: color.ink,
            headerTitleStyle: { fontFamily: displayFont },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: color.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="experience/[id]" options={{ title: 'Experience' }} />
          <Stack.Screen name="member/[id]" options={{ title: 'Member' }} />
          <Stack.Screen name="concierge/new" options={{ title: 'New request' }} />
          <Stack.Screen name="concierge/[id]" options={{ title: 'Request' }} />
          <Stack.Screen name="messages/index" options={{ title: 'Messages' }} />
          <Stack.Screen name="messages/[memberId]" options={{ title: 'Conversation' }} />
          <Stack.Screen name="qera" options={{ title: 'QÉRA' }} />
          <Stack.Screen name="document/[id]" options={{ title: 'Document' }} />
          <Stack.Screen name="memory" options={{ title: 'What QÉRA remembers' }} />
          <Stack.Screen name="calendar" options={{ title: 'Your calendar' }} />
          <Stack.Screen name="whatsapp" options={{ title: 'QÉRA on WhatsApp' }} />
          <Stack.Screen name="today" options={{ title: 'Your day' }} />
          <Stack.Screen name="search" options={{ title: 'Search' }} />
          <Stack.Screen name="tv" options={{ title: 'Quintara TV' }} />
          <Stack.Screen name="boutique" options={{ title: 'Maison Quintara', headerRight: () => <CityButton /> }} />
          <Stack.Screen name="lifestyle/index" options={{ title: 'Lifestyle', headerRight: () => <CityButton /> }} />
          <Stack.Screen name="lifestyle/[id]" options={{ title: 'Partner' }} />
          <Stack.Screen name="lifestyle/service/[id]" options={{ title: 'Service' }} />
          <Stack.Screen name="business" options={{ title: 'Business' }} />
          <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
          <Stack.Screen name="bookings" options={{ title: 'Bookings' }} />
          <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
          <Stack.Screen name="notification-settings" options={{ title: 'Notification settings' }} />
          <Stack.Screen name="membership" options={{ title: 'Membership' }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in', presentation: 'modal' }} />
          <Stack.Screen name="join" options={{ title: 'Guest account', presentation: 'modal' }} />
        </Stack>
        </LapsedGate>
        </AppLock>
        </PushBridge>
        </SecondStepGate>
      </QuintaraProvider>
    </SafeAreaProvider>
  );
}
