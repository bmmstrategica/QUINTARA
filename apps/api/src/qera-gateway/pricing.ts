/**
 * Estimated prices, in US dollars per million tokens, used to track QÉRA's running cost and enforce the daily cap.
 *
 * These are estimates for monitoring, not billing. They were taken from published rate cards in November 2026 and
 * must be checked against each provider's own pricing page before production and whenever a model is changed:
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://developers.openai.com/api/docs/pricing
 *   https://ai.google.dev/gemini-api/docs/pricing
 * A model not listed here is priced at its provider's `default`, which is set high on purpose so the cap errs safe.
 */
import type { ProviderName } from './providers.ts';

interface Rate { input: number; output: number }
export const PRICES: Record<ProviderName, Record<string, Rate> & { default: Rate }> = {
  anthropic: { 'claude-sonnet-5-5': { input: 2, output: 10 }, 'claude-opus-5-5': { input: 4, output: 20 }, 'claude-haiku-4-5': { input: 1, output: 5 }, default: { input: 10, output: 50 } },
  openai: { 'gpt-6.1-sol': { input: 2, output: 10 }, 'gpt-6-luna': { input: 0.1, output: 0.5 }, 'gpt-6-astra': { input: 10, output: 50 }, default: { input: 10, output: 50 } },
  gemini: { 'gemini-3.1-pro-preview': { input: 2, output: 12 }, 'gemini-3-flash-preview': { input: 0.5, output: 3 }, default: { input: 10, output: 50 } },
};

/** Hundredths of a US cent (1 USD = 10 000), the unit stored in qera_model_calls.cost_micro. */
export function costMicro(provider: ProviderName, model: string, inputTokens: number, outputTokens: number): number {
  const table = PRICES[provider];
  const rate = table[model] ?? table.default;
  return Math.ceil(((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000) * 10_000);
}

export const isPriced = (provider: ProviderName, model: string) => Boolean(PRICES[provider][model]) && model !== 'default';
