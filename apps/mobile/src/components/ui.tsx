import { useRouter } from 'expo-router';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import type { TextInputProps, TextProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiError, Resource } from '@quintara/app-core';
import { useTheme } from '@/theme';

/** A scrolling screen with safe-area padding and optional pull to refresh. */
export function Screen({ children, onRefresh, refreshing = false }: { children: ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  const { color, space } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: color.bg }}
      contentContainerStyle={{ padding: space.md, paddingBottom: insets.bottom + space.xl, gap: space.md }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.accent} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Title({ style, ...props }: TextProps) {
  const { color, type, displayFont } = useTheme();
  return <Text accessibilityRole="header" {...props} style={[{ color: color.ink, fontFamily: displayFont, fontSize: type.title.size, lineHeight: type.title.lineHeight }, style]} />;
}

export function Heading({ style, ...props }: TextProps) {
  const { color, type, displayFont } = useTheme();
  return <Text accessibilityRole="header" {...props} style={[{ color: color.ink, fontFamily: displayFont, fontSize: type.heading.size, lineHeight: type.heading.lineHeight }, style]} />;
}

export function Body({ style, ...props }: TextProps) {
  const { color, type } = useTheme();
  return <Text {...props} style={[{ color: color.ink, fontSize: type.body.size, lineHeight: type.body.lineHeight }, style]} />;
}

export function Muted({ style, ...props }: TextProps) {
  const { color, type } = useTheme();
  return <Text {...props} style={[{ color: color.muted, fontSize: type.small.size, lineHeight: type.small.lineHeight }, style]} />;
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  quiet?: boolean;
  busy?: boolean;
  disabled?: boolean;
}

export function Button({ label, onPress, quiet = false, busy = false, disabled = false }: ButtonProps) {
  const { color, space, radius, type } = useTheme();
  const inactive = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48, // comfortable touch target
        paddingHorizontal: space.lg,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: quiet ? color.line : color.inverseBg,
        backgroundColor: quiet ? 'transparent' : color.inverseBg,
        opacity: inactive ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={quiet ? color.ink : color.inverseInk} /> : <Text style={{ color: quiet ? color.ink : color.inverseInk, fontSize: type.body.size, fontWeight: '500' }}>{label}</Text>}
    </Pressable>
  );
}

export function Tag({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'accent' | 'positive' | 'critical' }) {
  const { color, radius, type } = useTheme();
  const ink = tone === 'accent' ? color.accent : tone === 'positive' ? color.positive : tone === 'critical' ? color.critical : color.muted;
  return (
    <View style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: tone === 'neutral' ? color.line : ink, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 2 }}>
      <Text style={{ color: ink, fontSize: type.caption.size }}>{label}</Text>
    </View>
  );
}

export function Divider() {
  const { color } = useTheme();
  return <View style={{ height: 1, backgroundColor: color.line }} />;
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const { color, space, radius, type } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ color: color.ink, fontSize: type.small.size, fontWeight: '500' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.muted}
        {...props}
        textAlignVertical={props.multiline ? 'top' : undefined}
        style={{ minHeight: props.multiline ? 110 : 48, paddingVertical: props.multiline ? space.sm : 0, borderWidth: 1, borderColor: error ? color.critical : color.line, borderRadius: radius.sm, backgroundColor: color.surface, color: color.ink, paddingHorizontal: space.md, fontSize: type.body.size }}
      />
      {error ? <Text accessibilityRole="alert" style={{ color: color.critical, fontSize: type.small.size }}>{error}</Text> : null}
    </View>
  );
}

/* ---------- Screen states ---------- */

export function Loading() {
  const { color, space } = useTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading" style={{ paddingVertical: space.xxl, alignItems: 'center' }}>
      <ActivityIndicator color={color.accent} />
    </View>
  );
}

export function EmptyState({ title, message, children }: { title: string; message?: string; children?: ReactNode }) {
  const { space } = useTheme();
  return (
    <View style={{ paddingVertical: space.xl, gap: space.sm }}>
      <Heading>{title}</Heading>
      {message ? <Muted>{message}</Muted> : null}
      {children}
    </View>
  );
}

/** One place decides what each kind of failure looks like and what the next step is. */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const router = useRouter();
  if (error.code === 'unauthenticated') {
    return <EmptyState title="This is for members" message="Sign in to continue."><Button label="Sign in" onPress={() => router.push('/sign-in')} /></EmptyState>;
  }
  if (error.code === 'forbidden') {
    return <EmptyState title="Not part of your membership" message={error.message}><Button quiet label="Back to home" onPress={() => router.replace('/')} /></EmptyState>;
  }
  if (error.code === 'not_found') {
    return <EmptyState title="No longer available" message={error.message}><Button quiet label="Go back" onPress={() => router.back()} /></EmptyState>;
  }
  return <EmptyState title="That did not load" message={error.message}>{onRetry ? <Button label="Try again" onPress={onRetry} /> : null}</EmptyState>;
}

interface ResourceViewProps<T> {
  resource: Resource<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/** Renders the loading, error, permission-denied, empty and ready states of a screen. */
export function ResourceView<T>({ resource, isEmpty, empty, children }: ResourceViewProps<T>) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (isEmpty?.(resource.data)) return <>{empty}</>;
  return <>{children(resource.data)}</>;
}

export function ActionError({ error }: { error: ApiError | null }) {
  const { color, type } = useTheme();
  if (!error) return null;
  return <Text accessibilityRole="alert" style={{ color: color.critical, fontSize: type.small.size }}>{error.message}</Text>;
}

/* ---------- Lists, choices and conversations ---------- */

/** A tappable list row: title, a line beneath, and an optional tag on the right. */
export function Row({ title, detail, trailing, onPress }: { title: string; detail?: string; trailing?: ReactNode; onPress?: () => void }) {
  const { color, space } = useTheme();
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.line, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontWeight: '500' }}>{title}</Body>
        {detail ? <Muted numberOfLines={2}>{detail}</Muted> : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** Pick one of a few options: the mobile stand-in for a select. */
export function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void }) {
  const { color, space, radius, type } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ color: color.ink, fontSize: type.small.size, fontWeight: '500' }}>{label}</Text>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {options.map(([key, text]) => (
          <Pressable key={key} accessibilityRole="radio" accessibilityState={{ selected: key === value }} onPress={() => onChange(key)}
            style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: key === value ? color.accent : color.line }}>
            <Text style={{ color: key === value ? color.accent : color.muted, fontSize: type.small.size }}>{text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function Bubble({ mine, body, meta }: { mine: boolean; body: string; meta: string }) {
  const { color, space, radius } = useTheme();
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: space.sm + 4, borderRadius: radius.md * 2, borderWidth: 1, borderColor: mine ? color.accent : color.line, backgroundColor: color.surface }}>
      <Body>{body}</Body>
      <Muted style={{ fontSize: 12 }}>{meta}</Muted>
    </View>
  );
}

/** Write and send one message. Clears itself once `onSend` reports success. */
export function Composer({ placeholder, busy, onSend }: { placeholder: string; busy: boolean; onSend: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState('');
  return (
    <>
      <Field label="Message" multiline value={body} onChangeText={setBody} placeholder={placeholder} maxLength={2000} />
      <Button label="Send" busy={busy} disabled={!body.trim()} onPress={async () => { if (await onSend(body.trim())) setBody(''); }} />
    </>
  );
}

/** Every consequential action asks first. */
export function confirmThen(title: string, message: string, actionLabel: string, action: () => void, destructive = false) {
  Alert.alert(title, message, [{ text: 'Not now', style: 'cancel' }, { text: actionLabel, style: destructive ? 'destructive' : 'default', onPress: action }]);
}

export const clock = (iso: string) => new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
