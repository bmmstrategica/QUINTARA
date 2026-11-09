import { Tabs } from 'expo-router';
import { CityButton } from '@/components/city-picker';
import { useTheme } from '@/theme';

export default function TabsLayout() {
  const { name, color, displayFont } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.bg },
        headerTitleStyle: { fontFamily: displayFont, color: color.ink },
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: color.bg, borderTopColor: color.line },
        // In the light look the chosen tab is emerald, as QÉRA is; in the dark look it is ivory.
        tabBarActiveTintColor: name === 'light' ? color.accent : color.ink,
        tabBarInactiveTintColor: color.muted,
        // Text-only tabs until the icon set is chosen with the design system.
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '500' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', headerTitle: 'QUINTARA', headerRight: () => <CityButton /> }} />
      <Tabs.Screen name="experiences" options={{ title: 'Experiences', headerRight: () => <CityButton /> }} />
      <Tabs.Screen name="members" options={{ title: 'Members', headerRight: () => <CityButton /> }} />
      <Tabs.Screen name="concierge" options={{ title: 'Concierge' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
