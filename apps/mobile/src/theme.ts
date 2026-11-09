import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { palettes, radius, space, THEME_STORAGE_KEY, type } from '@quintara/design-tokens';
import type { Palette, ThemeName } from '@quintara/design-tokens';

/** System serif until the brand typefaces are bundled with expo-font. */
const display = Platform.select({ ios: 'Didot', android: 'serif', default: 'serif' });

export interface Theme {
  name: ThemeName;
  color: Palette;
  space: typeof space;
  radius: typeof radius;
  type: typeof type;
  displayFont: string;
}

interface ThemeState { name: ThemeName; setName: (name: ThemeName) => void }

const ThemeContext = createContext<ThemeState>({ name: 'dark', setName: () => undefined });

/** Dark is the brand look and the default. The member's choice is remembered on this device. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [name, setNameState] = useState<ThemeName>('dark');
  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY).then((saved) => { if (saved === 'light' || saved === 'dark') setNameState(saved); }, () => undefined);
  }, []);
  const value = useMemo<ThemeState>(() => ({
    name,
    setName: (next) => { setNameState(next); AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => undefined); },
  }), [name]);
  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): Theme {
  const { name } = useContext(ThemeContext);
  return useMemo(() => ({ name, color: palettes[name], space, radius, type, displayFont: display }), [name]);
}

export function useThemeChoice(): ThemeState {
  return useContext(ThemeContext);
}
