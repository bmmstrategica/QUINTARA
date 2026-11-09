/**
 * Push notifications on the phone.
 *
 * - The app never asks for permission on its own: the member turns notifications on under Profile (or from
 *   Notifications), and only then does the phone ask.
 * - Once allowed, this phone's push token is registered with the session signed in, each time the app opens, and
 *   removed when the member signs out.
 * - Tapping a notification opens what it is about (a booking, a message, a request, an order).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useAction, useApi, useResource, useSession } from '@quintara/app-core';
import type { ApiError } from '@quintara/app-core';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABEL } from '@quintara/domain';
import type { AppNotification, NotificationCategory, PushSettings } from '@quintara/domain';
import { ActionError, Body, Button, confirmThen, Heading, Muted } from '@/components/ui';
import { useTheme } from '@/theme';

// A notification arriving while the app is open shows as a banner too.
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }) });

/** Where a tap on a notification goes, as in the Notifications list. */
export const NOTIFICATION_ROUTE: Record<NonNullable<AppNotification['link']>['type'], (id: string) => string> = {
  experience: (id) => `/experience/${id}`,
  booking: () => '/bookings',
  member: (id) => `/member/${id}`,
  request: (id) => `/concierge/${id}`,
  conversation: (id) => `/messages/${id}`,
  order: () => '/boutique',
  qera: () => '/qera',
};

type Permission = 'granted' | 'denied' | 'undetermined' | 'unavailable';
interface PushValue {
  permission: Permission;
  /** Asks the phone (the first time) and registers this phone. */
  turnOn(): Promise<Permission>;
  token: string | null;
}
const PushContext = createContext<PushValue | null>(null);
export const usePush = () => useContext(PushContext);

const projectId = () => (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;

async function tokenForThisPhone(): Promise<string | null> {
  if (!Device.isDevice) return null;   // simulators cannot receive push notifications
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Quintara', importance: Notifications.AndroidImportance.HIGH, lightColor: '#D2B88E' });
  const id = projectId();
  if (!id) return null;   // the build is not linked to an Expo project yet (`eas init`)
  return (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
}

export function PushBridge({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const { session, guest } = useSession();
  const signedIn = Boolean(session || guest);
  const [permission, setPermission] = useState<Permission>(Device.isDevice ? 'undetermined' : 'unavailable');
  const [token, setToken] = useState<string | null>(null);
  const registered = useRef<string | null>(null);

  const register = useCallback(async () => {
    const t = await tokenForThisPhone().catch(() => null);
    setToken(t);
    if (t && registered.current !== t) {
      await api.registerPushDevice({ token: t, platform: Platform.OS === 'ios' ? 'ios' : 'android', deviceName: Device.deviceName ?? Device.modelName ?? '' }).then(() => { registered.current = t; }, () => undefined);
    }
  }, [api]);

  // Each time someone is signed in on a phone that allows notifications, it is registered with that session.
  useEffect(() => {
    if (!Device.isDevice) return;
    void Notifications.getPermissionsAsync().then((p) => {
      setPermission(p.granted ? 'granted' : p.canAskAgain === false ? 'denied' : 'undetermined');
      if (p.granted && signedIn) void register();
    });
    if (!signedIn) registered.current = null;
  }, [signedIn, register]);

  // A tap on a notification, whether the app was open, in the background or closed.
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data as { notificationId?: string; link?: AppNotification['link'] } | undefined;
      if (!data?.notificationId) return;
      void api.markNotificationRead(data.notificationId).catch(() => undefined);
      router.push(data.link && NOTIFICATION_ROUTE[data.link.type] ? NOTIFICATION_ROUTE[data.link.type](data.link.id) : '/notifications');
    };
    void Notifications.getLastNotificationResponseAsync().then(open).catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [api, router]);

  const value: PushValue = {
    permission, token,
    async turnOn() {
      if (!Device.isDevice) { setPermission('unavailable'); return 'unavailable'; }
      const p = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
      const next: Permission = p.granted ? 'granted' : 'denied';
      setPermission(next);
      if (p.granted) await register();
      return next;
    },
  };
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

/** Signing out removes this phone's token first, so nothing more is pushed to it. */
export function useSignOutWithPush() {
  const api = useApi(), push = usePush(), { signOut } = useSession();
  return async () => {
    if (push?.token) await api.unregisterPushDevice(push.token).catch(() => undefined);
    await Notifications.setBadgeCountAsync(0).catch(() => undefined);
    await signOut();
  };
}

/** Under Profile: notifications on this phone, which kinds are pushed, the lock screen, and the phones signed in. */
export function PushSettingsPanel() {
  const push = usePush();
  const { space } = useTheme();
  const settings = useResource((api) => api.getPushSettings(), [push?.permission]);
  const save = useAction((api, muted: NotificationCategory[], showDetails: boolean) => api.updatePushSettings({ muted, showDetails }));
  const remove = useAction(async (api, id: string) => { await api.removePushDevice(id); return true; });
  const test = useAction(async (api) => { await api.sendTestPush(); return true; });
  const [sent, setSent] = useState(false);
  const [current, setCurrent] = useState<PushSettings | null>(null);
  useEffect(() => { if (settings.data) setCurrent(settings.data); }, [settings.data]);
  if (!push) return null;
  const update = async (muted: NotificationCategory[], showDetails: boolean) => { const next = await save.run(muted, showDetails); if (next) setCurrent(next); };
  return (
    <View style={{ gap: space.sm }}>
      <Heading>Notifications on this phone</Heading>
      {push.permission === 'unavailable' ? <Muted>Push notifications need a real phone, not a simulator.</Muted>
        : push.permission === 'denied' ? <Muted>Notifications are turned off for Quintara in your phone's settings. Turn them on there to receive them.</Muted>
        : push.permission !== 'granted' ? (
          <>
            <Body>Have confirmations, replies, invitations and order news arrive on this phone.</Body>
            <Button label="Turn on notifications" onPress={() => { void push.turnOn().then(() => settings.reload()); }} />
          </>
        ) : <Muted>On. Everything also appears under Notifications in the app.</Muted>}
      {current ? (
        <>
          <Toggle label="Show details on the lock screen" detail={current.showDetails ? 'Shows what the notification says, such as who sent a message.' : 'Shows only "You have a new message", and so on.'} on={current.showDetails} onChange={(v) => { void update(current.muted, v); }} />
          <Muted>Push these to my phone:</Muted>
          {NOTIFICATION_CATEGORIES.map((c) => (
            <Toggle key={c} label={NOTIFICATION_CATEGORY_LABEL[c][0]} on={!current.muted.includes(c)}
              onChange={(v) => { void update(v ? current.muted.filter((m) => m !== c) : [...current.muted, c], current.showDetails); }} />
          ))}
          <ActionError error={(save.error ?? remove.error ?? test.error) as ApiError | null} />
          {current.devices.length ? (
            <>
              <Muted>Phones receiving notifications:</Muted>
              {current.devices.map((d) => (
                <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
                  <Body style={{ flex: 1 }}>{d.deviceName || (d.platform === 'ios' ? 'iPhone' : 'Android phone')}{d.thisDevice ? ' (this phone)' : ''}</Body>
                  {d.thisDevice ? null : <Button quiet label="Remove" onPress={() => confirmThen('Stop notifications to that phone?', 'It will receive nothing more until you sign in on it again.', 'Remove', async () => { if (await remove.run(d.id)) settings.reload(); }, true)} />}
                </View>
              ))}
              <Button quiet label={sent ? 'Test sent' : 'Send a test notification'} busy={test.pending} disabled={sent} onPress={async () => { if (await test.run()) setSent(true); }} />
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function Toggle({ label, detail, on, onChange }: { label: string; detail?: string; on: boolean; onChange: (on: boolean) => void }) {
  const { color, space } = useTheme();
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label} onPress={() => onChange(!on)}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs }}>
      <View style={{ flex: 1 }}><Body>{label}</Body>{detail ? <Muted>{detail}</Muted> : null}</View>
      <View style={{ width: 46, height: 28, borderRadius: 14, padding: 3, backgroundColor: on ? color.accent : color.line, alignItems: on ? 'flex-end' : 'flex-start' }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: color.bg }} />
      </View>
    </Pressable>
  );
}
export { Toggle };
