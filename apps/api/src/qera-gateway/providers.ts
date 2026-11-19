/**
 * QÉRA's model gateway: one small interface, and an adapter for each hosted model provider.
 *
 * Adapters speak each provider's HTTP API directly (no SDKs), so adding or swapping a provider is one file and no
 * new dependencies. Keys are read on the server only and never reach the apps. Nothing here decides what QÉRA may
 * do: the gateway only turns "what should happen next?" into a reply or a request for one tool, and the tool rules
 * in packages/domain/src/qera.ts still check every request.
 */

export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface LlmToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCall?: { id: string; name: string; args: Record<string, unknown> } }
  | { role: 'tool'; id: string; name: string; result: string };
export interface LlmRequest { model: string; system: string; messages: LlmMessage[]; tools: LlmToolSpec[]; maxTokens: number; timeoutMs: number }
export interface LlmResponse { text?: string; toolCall?: { name: string; args: Record<string, unknown> }; inputTokens: number; outputTokens: number }

export interface LlmProvider {
  readonly name: ProviderName;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** A provider's answer that was not a success. The message is kept short and never includes the key. */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly status: number | null;
  constructor(provider: ProviderName, status: number | null, message: string) { super(`${provider}: ${message}`.slice(0, 300)); this.provider = provider; this.status = status; }
}

type Fetch = typeof fetch;

async function post(provider: ProviderName, fetcher: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderError(provider, null, error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(provider, response.status, `HTTP ${response.status} ${detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return response.json();
}

/** Anthropic's Messages API, with tool use. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly apiKey: string;
  private readonly fetcher: Fetch;
  private readonly baseUrl: string;
  constructor(apiKey: string, fetcher: Fetch = fetch, baseUrl = 'https://api.anthropic.com') { this.apiKey = apiKey; this.fetcher = fetcher; this.baseUrl = baseUrl; }
  async complete(r: LlmRequest): Promise<LlmResponse> {
    const messages = r.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.text };
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.result }] };
      return { role: 'assistant', content: [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.toolCall ? [{ type: 'tool_use', id: m.toolCall.id, name: m.toolCall.name, input: m.toolCall.args }] : [])] };
    });
    const out = await post(this.name, this.fetcher, `${this.baseUrl}/v1/messages`, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: r.model, max_tokens: r.maxTokens, system: r.system, messages,
      tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }, r.timeoutMs);
    const blocks: any[] = Array.isArray(out?.content) ? out.content : [];
    const usage = { inputTokens: Number(out?.usage?.input_tokens ?? 0), outputTokens: Number(out?.usage?.output_tokens ?? 0) };
    // Declined by the model's safety checks: a polite answer, not an empty one.
    if (out?.stop_reason === 'refusal') return { text: 'I am sorry, I cannot help with that. The concierge desk will gladly assist.', ...usage };
    // Cut off by the token ceiling (thinking counts towards it): a tool call may be missing arguments and the text may
    // stop mid-sentence, so the answer is not used and the gateway tries the next provider.
    if (out?.stop_reason === 'max_tokens') throw new ProviderError(this.name, null, 'the answer was cut off by the token limit');
    const use = blocks.find((b) => b.type === 'tool_use');
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n').trim();
    return { ...(use ? { toolCall: { name: String(use.name), args: (use.input ?? {}) as Record<string, unknown> } } : {}), ...(text ? { text } : {}), ...usage };
  }
}

/** OpenAI's Chat Completions API, with function calling. */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private readonly apiKey: string;
  private readonly fetcher: Fetch;
  private readonly baseUrl: string;
  constructor(apiKey: string, fetcher: Fetch = fetch, baseUrl = 'https://api.openai.com') { this.apiKey = apiKey; this.fetcher = fetcher; this.baseUrl = baseUrl; }
  async complete(r: LlmRequest): Promise<LlmResponse> {
    const messages: unknown[] = [{ role: 'system', content: r.system }];
    for (const m of r.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.text });
      else if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.id, content: m.result });
      else messages.push({ role: 'assistant', content: m.text ?? null, ...(m.toolCall ? { tool_calls: [{ id: m.toolCall.id, type: 'function', function: { name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.args) } }] } : {}) });
    }
    const out = await post(this.name, this.fetcher, `${this.baseUrl}/v1/chat/completions`, { authorization: `Bearer ${this.apiKey}` }, {
      model: r.model, max_completion_tokens: r.maxTokens, messages,
      tools: r.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }, r.timeoutMs);
    if (out?.choices?.[0]?.finish_reason === 'length') throw new ProviderError(this.name, null, 'the answer was cut off by the token limit');
    const message = out?.choices?.[0]?.message ?? {};
    const call = message.tool_calls?.[0]?.function;
    let args: Record<string, unknown> = {};
    if (call) { try { args = JSON.parse(call.arguments || '{}'); } catch { throw new ProviderError(this.name, null, 'tool arguments were not valid JSON'); } }
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    return { ...(call ? { toolCall: { name: String(call.name), args } } : {}), ...(text ? { text } : {}), inputTokens: Number(out?.usage?.prompt_tokens ?? 0), outputTokens: Number(out?.usage?.completion_tokens ?? 0) };
  }
}

/** Google's Gemini API (generateContent), with function declarations. */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  private readonly apiKey: string;
  private readonly fetcher: Fetch;
  private readonly baseUrl: string;
  constructor(apiKey: string, fetcher: Fetch = fetch, baseUrl = 'https://generativelanguage.googleapis.com') { this.apiKey = apiKey; this.fetcher = fetcher; this.baseUrl = baseUrl; }
  async complete(r: LlmRequest): Promise<LlmResponse> {
    const contents = r.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
      if (m.role === 'tool') return { role: 'user', parts: [{ functionResponse: { name: m.name, response: { content: m.result } } }] };
      // Gemini 3 models refuse a replayed function call without the thought signature that came with it. The gateway
      // rebuilds calls from what the tools did, not from the provider's reply, so it sends the value Google documents
      // for calls whose signature was not kept.
      return { role: 'model', parts: [...(m.text ? [{ text: m.text }] : []), ...(m.toolCall ? [{ functionCall: { name: m.toolCall.name, args: m.toolCall.args }, thoughtSignature: GEMINI_UNSIGNED }] : [])] };
    });
    const out = await post(this.name, this.fetcher, `${this.baseUrl}/v1beta/models/${encodeURIComponent(r.model)}:generateContent`, { 'x-goog-api-key': this.apiKey }, {
      systemInstruction: { parts: [{ text: r.system }] }, contents,
      tools: [{ functionDeclarations: r.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }],
      generationConfig: { maxOutputTokens: r.maxTokens },
    }, r.timeoutMs);
    if (out?.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new ProviderError(this.name, null, 'the answer was cut off by the token limit');
    const parts: any[] = out?.candidates?.[0]?.content?.parts ?? [];
    const fn = parts.find((p) => p.functionCall)?.functionCall;
    const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n').trim();
    return { ...(fn ? { toolCall: { name: String(fn.name), args: (fn.args ?? {}) as Record<string, unknown> } } : {}), ...(text ? { text } : {}), inputTokens: Number(out?.usageMetadata?.promptTokenCount ?? 0), outputTokens: Number(out?.usageMetadata?.candidatesTokenCount ?? 0) };
  }
}

const GEMINI_UNSIGNED = 'skip_thought_signature_validator';

/** Gemini accepts a subset of JSON Schema: drop the keys it rejects. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', 'additionalProperties', 'default', 'pattern', 'format'].includes(key)) continue;
    out[key] = geminiSchema(value);
  }
  return out;
}

/** The providers whose keys are set in the environment. */
export function providersFromEnv(env: Record<string, string | undefined>, fetcher: Fetch = fetch): Partial<Record<ProviderName, LlmProvider>> {
  const out: Partial<Record<ProviderName, LlmProvider>> = {};
  if (env.ANTHROPIC_API_KEY) out.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY, fetcher);
  if (env.OPENAI_API_KEY) out.openai = new OpenAIProvider(env.OPENAI_API_KEY, fetcher);
  if (env.GEMINI_API_KEY) out.gemini = new GeminiProvider(env.GEMINI_API_KEY, fetcher);
  return out;
}
