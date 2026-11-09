/**
 * QÉRA on WhatsApp: the rules shared by the server and the apps.
 *
 * A member or guest links their WhatsApp number by sending a one-time code from that number to Quintara's WhatsApp
 * Business number. Sending it proves they hold the number; nothing is sent to a number that has not written first.
 * Once linked, messages from that number reach QÉRA as that person, with exactly the tools and permissions they
 * have in the app. Anything QÉRA would do still waits for an explicit Confirm, sent from the linked number.
 */
import { z } from 'zod';

export type WhatsAppStatus = 'none' | 'pending' | 'linked';

export interface WhatsAppLink {
  /** False when Quintara's WhatsApp number is not set up yet. */
  available: boolean;
  status: WhatsAppStatus;
  /** Quintara's WhatsApp Business number, for display, e.g. "+27 21 000 0000". */
  businessNumber: string | null;
  /** The linked number, shown only by its last digits. */
  numberMasked: string | null;
  linkedAt: string | null;
  /** While linking: the code to send, the message to send it in, and a link that opens WhatsApp with it typed. */
  code: string | null;
  message: string | null;
  openUrl: string | null;
  codeExpiresAt: string | null;
}

export const whatsAppLinkSchema = z.object({
  consent: z.literal(true, { error: 'Please agree to talk to QÉRA on WhatsApp' }),
});
export type WhatsAppLinkInput = z.input<typeof whatsAppLinkSchema>;

/** Minutes a linking code stays valid. */
export const WHATSAPP_CODE_MINUTES = 15;
/** The words that link a number: "LINK 123456". */
export const linkMessage = (code: string) => `LINK ${code}`;
export const LINK_PATTERN = /^\s*link\s+(\d{6})\s*$/i;

/** Digits only, without a leading plus: the form WhatsApp uses for numbers (e.g. 27821234567). */
export const waDigits = (number: string) => number.replace(/\D/g, '');
/** A link that opens a chat with the number, with the text typed in. */
export const waMeLink = (number: string, text: string) => `https://wa.me/${waDigits(number)}?text=${encodeURIComponent(text)}`;
export const maskNumber = (digits: string) => `•••• ${digits.slice(-4)}`;

/** What a message from the person can mean before it is passed to QÉRA. */
export type WhatsAppCommand = { kind: 'link'; code: string } | { kind: 'unlink' } | { kind: 'help' } | { kind: 'yes' } | { kind: 'no' } | { kind: 'text'; text: string };
export function readCommand(text: string): WhatsAppCommand {
  const t = text.trim();
  const link = LINK_PATTERN.exec(t);
  if (link) return { kind: 'link', code: link[1]! };
  const word = t.toLowerCase().replace(/[.!]+$/, '');
  if (word === 'stop' || word === 'unlink') return { kind: 'unlink' };
  if (word === 'help') return { kind: 'help' };
  if (['yes', 'confirm', 'yes please', 'go ahead'].includes(word)) return { kind: 'yes' };
  if (['no', 'cancel', 'not now', 'no thanks'].includes(word)) return { kind: 'no' };
  return { kind: 'text', text: t };
}

/** WhatsApp shows *bold* and _italic_. QÉRA writes plain sentences, so only stray Markdown needs adjusting. */
export function toWhatsAppText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/\n{3,}/g, '\n\n').slice(0, 4000);
}

export const WHATSAPP_TEXT = {
  welcome: 'Your WhatsApp is now linked to Quintara. I am QÉRA. Ask me about experiences, partners and services, or to plan something. I always ask before I do anything, and you can reply STOP at any time to unlink this number.',
  notLinked: 'Hello from Quintara. To talk to QÉRA here, link this number in the Quintara app, under QÉRA, then WhatsApp.',
  badCode: 'That code has expired or is not right. Start again in the Quintara app, under QÉRA, then WhatsApp.',
  numberTaken: 'This number is already linked to another Quintara account. Unlink it there first, or reply STOP from this number.',
  unlinked: 'This number is no longer linked to Quintara. You can link it again in the app at any time.',
  cannotUse: 'This number is linked to an account that cannot use QÉRA at the moment. Please open the Quintara app.',
  help: 'Write to me as you would in the app. When I suggest doing something, tap Confirm or reply YES; tap Not now or reply NO and nothing happens. Reply STOP to unlink this number.',
  slowDown: 'Give me a moment. Please write again in a minute.',
  nothingWaiting: 'There is nothing waiting for your answer. What would you like to do?',
  unsupported: 'I can read text messages only for now. Please type what you need.',
} as const;
