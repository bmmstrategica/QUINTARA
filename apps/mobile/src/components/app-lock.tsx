/**
 * Face ID, Touch ID or fingerprint to open the app.
 *
 * - Off until the member turns it on under Profile, Security. Turning it on asks for Face ID (or the fingerprint)
 *   once, so it is known to work on this phone.
 * - When on, the app opens locked, and locks again after it has been in the background for the chosen time.
 * - The phone's own passcode is accepted when Face ID fails, as with banking apps. "Sign out" is always offered.
 * - While the app is in the app switcher its contents are covered, so nothing private shows in the preview.
 * - The setting is kept in the phone's secure storage (the Keychain, or Android's Keystore), per phone.
 *
 * This is a lock on this phone, in addition to the two-step sign-in: it never replaces it.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useSession } from '@quintara/app-core';
import { Body, Button, Choice, Muted } from '@/components/ui';
import { useTheme } from '@/theme';

const KEY = 'quintara.app-lock';
/** Seconds in the background before the app locks again. */
export const LOCK_AFTER = [['0', 'Straight away'], ['60', 'After 1 minute'], ['300', 'After 5 minutes'], ['900', 'After 15 minutes']] as const;
type After = (typeof LOCK_AFTER)[number][0];

interface Setting { on: boolean; after: After }
interface Biometrics { available: boolean; enrolled: boolean; label: string }
interface AppLockValue {
  setting: Setting;
  biometrics: Biometrics | null;
  /** Turns the lock on (after a successful Face ID or fingerprint) or off. Returns false if the check failed. */
  setOn(on: boolean): Promise<boolean>;
  setAfter(after: After): Promise<void>;
}

const AppLockContext = createContext<AppLockValue | null>(null);
export const useAppLock = () => {
  const value = useContext(AppLockContext);
  if (!value) throw new Error('useAppLock needs <AppLock>.');
  return value;
};

/** What the phone calls it: Face ID, Touch ID, fingerprint, face unlock. */
async function readBiometrics(): Promise<Biometrics> {
  const [available, enrolled, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync().catch(() => false),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
    LocalAuthentication.supportedAuthenticationTypesAsync().catch(() => [] as LocalAuthentication.AuthenticationType[]),
  ]);
  const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION), finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  const label = Platform.OS === 'ios' ? (face ? 'Face ID' : finger ? 'Touch ID' : 'your passcode') : finger ? 'your fingerprint' : face ? 'face unlock' : 'your screen lock';
  return { available, enrolled, label };
}

const unlock = (label: string) => LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Quintara', cancelLabel: 'Cancel', fallbackLabel: 'Use passcode', disableDeviceFallback: false, promptDescription: `Use ${label} to open Quintara` });

export function AppLock({ children }: { children: ReactNode }) {
  const { session, guest, signOut } = useSession();
  const signedIn = Boolean(session || guest);
  const [setting, setSetting] = useState<Setting>({ on: false, after: '60' });
  const [loaded, setLoaded] = useState(false);
  const [biometrics, setBiometrics] = useState<Biometrics | null>(null);
  const [locked, setLocked] = useState(true);
  const [covered, setCovered] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const backgroundAt = useRef<number | null>(null);
  const prompting = useRef(false);

  useEffect(() => {
    void (async () => {
      const saved = await SecureStore.getItemAsync(KEY).catch(() => null);
      try { if (saved) setSetting({ on: false, after: '60', ...(JSON.parse(saved) as Partial<Setting>) }); } catch { /* the default stands */ }
      setBiometrics(await readBiometrics());
      setLoaded(true);
    })();
  }, []);

  const save = useCallback(async (next: Setting) => {
    setSetting(next);
    await SecureStore.setItemAsync(KEY, JSON.stringify(next), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => undefined);
  }, []);

  const tryUnlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    setFailed(null);
    try {
      const result = await unlock(biometrics?.label ?? 'Face ID');
      if (result.success) setLocked(false);
      else if (result.error !== 'user_cancel' && result.error !== 'system_cancel' && result.error !== 'app_cancel') setFailed('That did not work. Try again, or sign out.');
    } finally { prompting.current = false; }
  }, [biometrics]);

  // Locked on opening; again after time in the background; covered in the app switcher.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        setCovered(false);
        const away = backgroundAt.current === null ? 0 : (Date.now() - backgroundAt.current) / 1000;
        backgroundAt.current = null;
        if (setting.on && away >= Number(setting.after)) setLocked(true);
      } else {
        if (setting.on) setCovered(true);
        if (next === 'background' && backgroundAt.current === null) backgroundAt.current = Date.now();
      }
    });
    return () => sub.remove();
  }, [setting]);

  const active = loaded && setting.on && signedIn && locked;
  useEffect(() => { if (active && AppState.currentState === 'active') void tryUnlock(); }, [active, tryUnlock]);
  // Signing out leaves nothing to protect; the next sign-in starts locked if the lock is on.
  useEffect(() => { if (!signedIn) setLocked(true); }, [signedIn]);

  const value: AppLockValue = {
    setting, biometrics,
    async setOn(on) {
      if (on) {
        const b = biometrics ?? (await readBiometrics());
        if (!b.available || !b.enrolled) return false;
        const result = await unlock(b.label);
        if (!result.success) return false;
        setLocked(false);
      }
      await save({ ...setting, on });
      return true;
    },
    setAfter: (after) => save({ ...setting, after }),
  };

  return (
    <AppLockContext.Provider value={value}>
      {children}
      {active ? <LockScreen label={biometrics?.label ?? 'Face ID'} failed={failed} onUnlock={tryUnlock} onSignOut={() => { void signOut().then(() => setLocked(false)); }} /> : null}
      {!active && covered ? <Cover /> : null}
    </AppLockContext.Provider>
  );
}

function LockScreen({ label, failed, onUnlock, onSignOut }: { label: string; failed: string | null; onUnlock: () => void; onSignOut: () => void }) {
  const { color, space, displayFont } = useTheme();
  return (
    <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: color.bg, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md }]}>
      <Image source={require('../../assets/splash-icon.png')} accessibilityIgnoresInvertColors style={{ width: 96, height: 96, opacity: 0.9 }} />
      <Text accessibilityRole="header" style={{ color: color.ink, fontFamily: displayFont, fontSize: 26 }}>Quintara is locked</Text>
      <Muted style={{ textAlign: 'center' }}>Use {label} to open the app.</Muted>
      {failed ? <Body accessibilityRole="alert" style={{ color: color.critical, textAlign: 'center' }}>{failed}</Body> : null}
      <View style={{ alignSelf: 'stretch', gap: space.sm, marginTop: space.md }}>
        <Button label={`Unlock with ${label}`} onPress={onUnlock} />
        <Button quiet label="Sign out" onPress={onSignOut} />
      </View>
    </View>
  );
}

/** Covers the app in the app switcher, so its preview shows nothing private. */
function Cover() {
  const { color } = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color.bg, alignItems: 'center', justifyContent: 'center' }]}>
      <Image source={require('../../assets/splash-icon.png')} style={{ width: 96, height: 96 }} />
    </View>
  );
}

/** Under Profile, Security: the lock on this phone. */
export function AppLockSettings() {
  const { setting, biometrics, setOn, setAfter } = useAppLock();
  const { space, color } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  if (!biometrics) return null;
  const label = biometrics.label, name = label.replace(/^your /, '');
  const Label = name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <View style={{ gap: space.sm }}>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: setting.on }} accessibilityLabel={`Open Quintara with ${label}`}
        onPress={async () => {
          setMessage(null);
          if (!setting.on && (!biometrics.available || !biometrics.enrolled)) { setMessage(`Set up ${label} in your phone's settings first.`); return; }
          const done = await setOn(!setting.on);
          if (!done) setMessage(`${Label} was not confirmed, so the lock was not turned on.`);
        }}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: space.sm }}>
        <View style={{ flex: 1 }}>
          <Body>Open Quintara with {label}</Body>
          <Muted>{setting.on ? 'On for this phone.' : `Ask for ${label} each time the app opens.`}</Muted>
        </View>
        <View style={{ width: 46, height: 28, borderRadius: 14, padding: 3, backgroundColor: setting.on ? color.accent : color.line, alignItems: setting.on ? 'flex-end' : 'flex-start' }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: color.bg }} />
        </View>
      </Pressable>
      {setting.on ? <Choice label="Lock again when the app has been away" options={LOCK_AFTER} value={setting.after} onChange={(v) => { void setAfter(v); }} /> : null}
      {message ? <Muted accessibilityRole="alert">{message}</Muted> : null}
    </View>
  );
}
