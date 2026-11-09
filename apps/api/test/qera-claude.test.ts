/**
 * QÉRA with a hosted model (Claude). The Anthropic client is replaced by a scripted stand-in, so these tests run
 * offline and check what Quintara sends and how it treats what comes back. Every safeguard of qeraTurn must hold
 * whatever the model says.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { QERA_TOOLS, RuleBasedQeraModel } from '@quintara/domain';
import { ClaudeQeraModel, withFallback } from '../src/qera-claude.ts';
import { startServer } from './harness.ts';

type Reply = Omit<Partial<Anthropic.Beta.BetaMessage>, 'content'> & { content: unknown[] };
/** A stand-in for the Anthropic client: answers with the scripted replies in turn and keeps every request. */
function scripted(replies: (Reply | Error)[]) {
  const requests: any[] = [];
  const client = { beta: { messages: { create: async (params: unknown) => {
    requests.push(params);
    const next = replies.shift();
    if (!next) throw new Error('No more scripted replies');
    if (next instanceof Error) throw next;
    return { stop_reason: 'end_turn', ...next };
  } } } } as unknown as Anthropic;
  return { client, requests };
}
const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }] });
const tool = (name: string, input: unknown): Reply => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] });
const lastQera = (thread: { messages: { role: string; text: string }[] }) => thread.messages.filter((m) => m.role === 'qera').at(-1)!.text;

test('the model looks things up with the member’s own tools, and the results go back as data', async () => {
  const { client, requests } = scripted([tool('list_experiences', {}), text('The Executive Yacht Club has seats left.')]);
  const s = await startServer({ qeraModel: new ClaudeQeraModel({ client, today: () => '2026-11-09' }) });
  try {
    const api = s.client();
    await api.signIn({ email: 'thandi@example.com' });
    const thread = await api.sendQeraMessage('What is coming up?');
    assert.equal(lastQera(thread), 'The Executive Yacht Club has seats left.');
    assert.equal(requests.length, 2);
    const [first, second] = requests;
    assert.equal(first.model, 'claude-opus-5-5');
    assert.deepEqual(first.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.equal(first.system[0].cache_control.type, 'ephemeral');
    assert.ok(first.betas.includes('server-side-fallback-2026-07-01') && first.fallbacks === 'default');
    // Only real tools, each with the schema the server validates against.
    for (const t of first.tools) assert.ok(t.name in QERA_TOOLS && t.input_schema.type === 'object', t.name);
    assert.ok(first.tools.some((t: any) => t.name === 'book_experience'));
    // The second request carries the lookup as a tool_result holding the real records.
    const result = second.messages.at(-1).content[0];
    assert.equal(result.type, 'tool_result');
    assert.match(result.content, /The Executive Yacht Club/);
    assert.match(first.messages[0].content[1].text, /Today is 2026-11-09/);
  } finally { await s.close(); }
});

test('an action the model asks for becomes a proposal the member confirms; nothing is booked until then', async () => {
  const replies: (Reply | Error)[] = [];
  const { client } = scripted(replies);
  const s = await startServer({ qeraModel: new ClaudeQeraModel({ client }) });
  try {
    const yachtId = (await s.db.query<{ id: string }>(`SELECT id FROM experiences WHERE title = 'The Executive Yacht Club'`))[0]!.id;
    replies.push(tool('book_experience', { experienceId: yachtId, seats: 2 }));
    const api = s.client();
    await api.signIn({ email: 'thandi@example.com' });
    const before = (await api.listBookings()).length;
    const thread = await api.sendQeraMessage('Book two seats on the yacht for me');
    assert.ok(thread.pending, 'a proposal is waiting: ' + lastQera(thread));
    assert.equal(thread.pending!.tool, 'book_experience');
    assert.match(thread.pending!.summary, /The Executive Yacht Club/);   // worded from the real record, not by the model
    assert.equal((await api.listBookings()).length, before);            // nothing booked yet
    await api.confirmQeraProposal(thread.pending!.id);
    assert.equal((await api.listBookings()).length, before + 1);
  } finally { await s.close(); }
});

test('arguments outside the tool’s rules are refused before any tool is touched', async () => {
  const { client } = scripted([tool('book_experience', { experienceId: 'x', seats: 99 }), tool('drop_tables', {})]);
  const s = await startServer({ qeraModel: new ClaudeQeraModel({ client }) });
  try {
    const api = s.client();
    await api.signIn({ email: 'thandi@example.com' });
    const one = await api.sendQeraMessage('Book 99 seats');
    assert.equal(one.pending, null);
    assert.match(lastQera(one), /could not work out the details/);
    // A tool that does not exist is never passed on.
    const two = await api.sendQeraMessage('Do something else');
    assert.equal(two.pending, null);
    assert.match(lastQera(two), /not sure how to help|not something I can do/);
  } finally { await s.close(); }
});

test('a guest is offered only read tools', async () => {
  const { client, requests } = scripted([text('Quintara is a private members’ club.')]);
  const s = await startServer({ qeraModel: new ClaudeQeraModel({ client }) });
  try {
    const api = s.client();
    await api.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.guest@example.com' });
    await api.sendQeraMessage('What is Quintara?');
    const offered: string[] = requests[0].tools.map((t: any) => t.name);
    assert.ok(offered.length > 0);
    for (const name of offered) assert.equal(QERA_TOOLS[name as keyof typeof QERA_TOOLS].kind, 'read', name);
    assert.match(requests[0].messages[0].content[1].text, /guest/);
  } finally { await s.close(); }
});

test('when the API fails, the rule-based model answers; a refusal is answered politely', async () => {
  const errors: unknown[] = [];
  const failing = scripted([new Error('connection reset')]);
  const model = withFallback(new ClaudeQeraModel({ client: failing.client }), new RuleBasedQeraModel(), (e) => errors.push(e));
  const step = await model.next({ message: 'What is Quintara?', results: [], tools: ['about_quintara'], audience: 'member' });
  assert.equal(errors.length, 1);
  assert.ok(step.reply || step.toolCall, 'the rule-based model answered');

  const refusing = scripted([{ stop_reason: 'refusal', content: [] }]);
  const refused = await new ClaudeQeraModel({ client: refusing.client }).next({ message: 'x', results: [], tools: [], audience: 'member' });
  assert.match(refused.reply ?? '', /cannot help with that/);
});
