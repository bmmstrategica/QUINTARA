import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_APPLICATION } from '@quintara/domain';
import { ApiError, createMockApi } from './index.ts';

const api = () => createMockApi({ latencyMs: 0 });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('a visitor sees only open, unhidden experiences', async () => {
  const list = await api().listExperiences();
  assert.deepEqual(list.map((e) => e.title), ['Costa Convivio', 'The Aura Enclave', 'House Feast']);
});

test('a visitor cannot book and is told to sign in', async () => {
  await assert.rejects(api().bookExperience('exp-costa-convivio', 1), code('unauthenticated'));
});

test('a hidden experience is not found for a visitor and visible to an invited member', async () => {
  const client = api();
  await assert.rejects(client.getExperience('exp-invitational'), code('not_found'));
  await client.signIn({ email: 'thandi@example.com' });
  assert.equal((await client.getExperience('exp-invitational')).invited, true);
});

test('booking follows admission rules: waitlist when full, applied when by application', async () => {
  const client = api();
  await client.signIn({ email: 'thandi@example.com' });
  assert.equal((await client.bookExperience('exp-episimo-dipno', 1)).status, 'waitlisted');
  assert.equal((await client.bookExperience('exp-founder-rally', 1)).status, 'applied');
  assert.equal((await client.bookExperience('exp-code-capital', 2)).status, 'confirmed');
});

test('a second live booking for the same experience is a conflict', async () => {
  const client = api();
  await client.signIn({ email: 'thandi@example.com' });
  await assert.rejects(client.bookExperience('exp-costa-convivio', 1), code('conflict'));
});

test('too many seats is a validation error', async () => {
  const client = api();
  await client.signIn({ email: 'thandi@example.com' });
  await assert.rejects(client.bookExperience('exp-code-capital', 9), code('validation'));
});

test('the directory needs membership and never includes the viewer', async () => {
  const client = api();
  await assert.rejects(client.listMembers(), code('unauthenticated'));
  await client.signIn({ email: 'thandi@example.com' });
  const members = await client.listMembers({ role: 'founder' });
  assert.deepEqual(members.map((m) => m.fullName), ['Sipho Ndlovu']);
});

test('an incomplete application is rejected with field messages; a complete one is submitted', async () => {
  const client = api();
  await assert.rejects(client.submitApplication(EMPTY_APPLICATION), (error: unknown) => error instanceof ApiError && error.code === 'validation' && 'email' in error.fields);
  const planId = (await client.listMembershipPlans())[0]!.id;
  const sent = await client.submitApplication({
    ...EMPTY_APPLICATION, planId, phone: '+27 82 555 0103', email: 'new@example.com', fullName: 'New Person', city: 'Durban', position: 'Founder', industry: 'Retail',
    motivation: 'I would like to host dinners for founders.', socialPlatform: 'instagram', socialHandle: '@newperson',
  });
  assert.equal(sent.status, 'submitted');
  await assert.rejects(client.saveApplicationDraft(EMPTY_APPLICATION), code('conflict'));
});
