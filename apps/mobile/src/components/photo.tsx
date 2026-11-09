import { useState } from 'react';
import { Image, PixelRatio, useWindowDimensions } from 'react-native';
import type { ImageStyle, StyleProp } from 'react-native';
import { photoUrl } from '@quintara/domain';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

/**
 * A photograph at the sharpness the screen can show. The width it is shown at, times the screen's pixel
 * density, decides which stored copy is fetched: crisp on a 3x display, without sending a phone the full-size file.
 * Until the photograph has been measured, it assumes the full width of the window.
 */
export function Photo({ path, style, label, fraction = 1 }: { path: string; style?: StyleProp<ImageStyle>; label?: string; fraction?: number }) {
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width * fraction);
  // Rounded up to a 120 dp step, so a small change in layout does not fetch the picture again.
  const pixels = PixelRatio.getPixelSizeForLayoutSize(Math.ceil(width / 120) * 120);
  const uri = /^(data:|https?:|file:)/.test(path) ? path : photoUrl(API_URL, path, pixels);
  return (
    <Image
      source={{ uri }}
      onLayout={(event) => { const w = event.nativeEvent.layout.width; if (w > 0 && Math.abs(w - width) > 1) setWidth(w); }}
      accessibilityIgnoresInvertColors
      accessible={Boolean(label)}
      accessibilityLabel={label}
      resizeMode="cover"
      fadeDuration={200}
      style={style}
    />
  );
}
