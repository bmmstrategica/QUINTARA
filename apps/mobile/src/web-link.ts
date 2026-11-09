import { Linking } from 'react-native';

/** The membership application lives in the web app for now; the mobile app opens it there. */
export const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'http://localhost:3000';
export const openApply = () => Linking.openURL(`${WEB_URL}/apply`);
export const openWeb = (path: string) => Linking.openURL(`${WEB_URL}${path}`);
