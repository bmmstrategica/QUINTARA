import { Linking } from 'react-native';

/** The membership application lives in the web app for now; the mobile app opens it there. */
export const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'http://localhost:3000';
export const openApply = () => Linking.openURL(`${WEB_URL}/apply`);
export const openWeb = (path: string) => Linking.openURL(`${WEB_URL}${path}`);

/** Where the payment provider's checkout sends the member back: the web app's return page, in the browser. */
export const paymentReturnUrl = `${WEB_URL}/payments/return`;

/**
 * After paying: true if it was paid in the app (simulated payments). With a hosted checkout, opens the provider's page
 * in the phone's browser and returns false; the member comes back to the app and the screen refreshes.
 */
export function followPayment(outcome: { kind: 'paid' } | { kind: 'checkout'; url: string } | undefined): boolean {
  if (outcome?.kind === 'checkout') { void Linking.openURL(outcome.url); return false; }
  return outcome?.kind === 'paid';
}
