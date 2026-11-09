import { PushSettingsPanel } from '@/components/push';
import { Screen } from '@/components/ui';

/** Push notifications on this phone: on or off, which kinds, the lock screen, and the phones signed in. */
export default function NotificationSettingsScreen() {
  return <Screen><PushSettingsPanel /></Screen>;
}
