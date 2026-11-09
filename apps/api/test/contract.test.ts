/**
 * The contract: one set of scenarios run against the mock API and the real API.
 * If both pass, the apps behave the same whichever they are connected to.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ApiError, createMockApi } from '@quintara/api-client';
import type { QuintaraApi } from '@quintara/api-client';
import { EMPTY_APPLICATION } from '@quintara/domain';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

const fails = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const byTitle = async (api: QuintaraApi, title: string) => (await api.listExperiences()).find((e) => e.title === title)!;
const MEMBER = { email: 'thandi@example.com' };

function contract(name: string, fresh: () => Promise<QuintaraApi> | QuintaraApi) {
  describe(name, () => {
    test('a visitor sees only open, unhidden experiences', async () => {
      const api = await fresh();
      assert.deepEqual((await api.listExperiences()).map((e) => e.title), ['Costa Convivio', 'The Aura Enclave', 'House Feast']);
      assert.equal(await api.getSession(), null);
    });

    test('a visitor cannot book, see the directory or read notifications', async () => {
      const api = await fresh();
      const costa = await byTitle(api, 'Costa Convivio');
      await assert.rejects(api.bookExperience(costa.id, 1), fails('unauthenticated'));
      await assert.rejects(api.listMembers(), fails('unauthenticated'));
      await assert.rejects(api.listNotifications(), fails('unauthenticated'));
    });

    test('signing in gives a session; signing out removes it', async () => {
      const api = await fresh();
      const session = await api.signIn(MEMBER);
      assert.equal(session.fullName, 'Thandi Mokoena');
      assert.deepEqual(session.roles, ['founder', 'member'].sort((a, b) => session.roles.indexOf(a as never) - session.roles.indexOf(b as never)));
      assert.equal((await api.getSession())?.memberNumber, 'Q-1001');
      await api.signOut();
      assert.equal(await api.getSession(), null);
    });

    test('a member sees member experiences and the hidden one they are invited to', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const list = await api.listExperiences();
      assert.equal(list.length, 10);
      assert.equal(list.find((e) => e.title === 'Quintara Golf Invitational')?.invited, true);
      assert.equal(list.find((e) => e.title === 'Costa Convivio')?.seatsTaken, 23);
    });

    test('booking follows admission and capacity: waitlisted when full, applied by application, confirmed otherwise', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      assert.equal((await api.bookExperience((await byTitle(api, 'Ep\u00edsimo D\u00edpno')).id, 1)).status, 'waitlisted');
      assert.equal((await api.bookExperience((await byTitle(api, 'The Penthouse Sessions')).id, 1)).status, 'applied');
      const code = await byTitle(api, 'The Executive Yacht Club');
      const booking = await api.bookExperience(code.id, 2);
      assert.equal(booking.status, 'confirmed');
      assert.match(booking.ticketCode, /^QT-/);
      assert.equal((await api.getExperience(code.id)).seatsTaken, code.seatsTaken! + 2);
      assert.ok((await api.listNotifications()).some((n) => n.title.includes('The Executive Yacht Club') && !n.readAt));
    });

    test('a paid experience holds the seats until payment, then confirms; cancelling in time refunds in full', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const aura = await byTitle(api, 'The Aura Enclave');
      const held = await api.bookExperience(aura.id, 2);
      assert.equal(held.status, 'awaiting_payment');
      assert.equal(held.amountDueMinor, aura.memberPriceMinor * 2);
      assert.ok(held.paymentDueAt && Date.parse(held.paymentDueAt) > Date.now());
      assert.equal((await api.getExperience(aura.id)).seatsTaken, aura.seatsTaken! + 2);   // held seats are not for sale
      const paid = await api.payBooking(held.id);
      assert.deepEqual([paid.status, paid.amountDueMinor, paid.paymentDueAt], ['confirmed', 0, null]);
      await assert.rejects(api.payBooking(held.id), fails('conflict'));                  // nothing left to pay
      assert.ok((await api.listNotifications()).some((n) => n.title.includes('The Aura Enclave')));
      const cancelled = await api.cancelBooking(held.id);
      assert.deepEqual([cancelled.status, cancelled.refundedMinor], ['cancelled', aura.memberPriceMinor * 2]);
      assert.equal((await api.getExperience(aura.id)).seatsTaken, aura.seatsTaken);
      await assert.rejects(api.payBooking('no-such-booking'), fails('not_found'));
    });

    test('a second live booking is a conflict; too many seats is a validation error', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      await assert.rejects(api.bookExperience((await byTitle(api, 'Costa Convivio')).id, 1), fails('conflict'));
      await assert.rejects(api.bookExperience((await byTitle(api, 'The Aura Enclave')).id, 9), fails('validation'));
    });

    test('a booking can be cancelled once, and frees its seats', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const costa = await byTitle(api, 'Costa Convivio');
      const mine = (await api.listBookings()).find((b) => b.experienceId === costa.id)!;
      assert.equal((await api.cancelBooking(mine.id)).status, 'cancelled');
      assert.equal((await api.getExperience(costa.id)).seatsTaken, costa.seatsTaken! - 2);
      await assert.rejects(api.cancelBooking(mine.id), fails('conflict'));
    });

    test('the directory excludes the viewer, filters by role and search, and never carries contact details', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const everyone = await api.listMembers();
      assert.equal(everyone.length, 4);
      assert.ok(!JSON.stringify(everyone).includes('@'));
      assert.deepEqual((await api.listMembers({ role: 'founder' })).map((m) => m.fullName), ['Sipho Ndlovu']);
      assert.deepEqual((await api.listMembers({ search: 'helderberg' })).map((m) => m.fullName), ['Daniel Fourie']);
    });

    test('connections: accept an incoming request, send a new one, refuse a repeat', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const members = await api.listMembers();
      const sipho = members.find((m) => m.fullName === 'Sipho Ndlovu')!, chloe = members.find((m) => m.fullName === 'Chloe van der Merwe')!;
      assert.equal(sipho.connection, 'incoming');
      assert.equal((await api.requestConnection(sipho.id)).connection, 'connected');
      assert.equal((await api.requestConnection(chloe.id)).connection, 'requested');
      await assert.rejects(api.requestConnection(chloe.id), fails('conflict'));
    });

    test('a member can edit their own profile; invalid input is rejected', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const profile = await api.getMyProfile();
      const updated = await api.updateMyProfile({ position: profile.position, company: profile.company, industry: profile.industry, city: 'Paarl', biography: profile.biography, interests: ['Wine'], lookingFor: profile.lookingFor, canOffer: profile.canOffer });
      assert.equal(updated.city, 'Paarl');
      assert.deepEqual(updated.interests, ['Wine']);
      await assert.rejects(api.updateMyProfile({ ...updated, biography: 'x'.repeat(700) } as never), fails('validation'));
    });

    test('an application is saved as a draft, validated on submission, and cannot be sent twice', async () => {
      const api = await fresh();
      assert.equal(await api.getApplication(), null);
      const draft = await api.saveApplicationDraft({ ...EMPTY_APPLICATION, fullName: 'New Person' });
      assert.equal(draft.status, 'draft');
      assert.equal((await api.getApplication())?.data.fullName, 'New Person');
      await assert.rejects(api.submitApplication({ ...EMPTY_APPLICATION, fullName: 'New Person' }), (e: unknown) => e instanceof ApiError && e.code === 'validation' && 'email' in e.fields);
      const ready = { ...EMPTY_APPLICATION, email: 'new.person@example.com', fullName: 'New Person', phone: '+27 82 555 0102', city: 'Durban', position: 'Founder', industry: 'Retail', motivation: 'I would like to host dinners for founders.', socialPlatform: 'instagram' as const, socialHandle: '@newperson' };
      // The membership applied for: resident or international, and a term from the plans offered in the city.
      const plans = await api.listMembershipPlans();
      assert.deepEqual(plans.map((p) => [p.residency, p.termMonths, p.priceMinor]), [
        ['resident', 3, 10_000_00], ['resident', 6, 18_000_00], ['resident', 12, 30_000_00],
        ['international', 1, 8_000_00], ['international', 3, 16_000_00], ['international', 6, 28_000_00], ['international', 12, 50_000_00]]);
      await assert.rejects(api.submitApplication(ready), (e: unknown) => e instanceof ApiError && e.code === 'validation' && 'planId' in e.fields);
      const international = plans.find((p) => p.residency === 'international' && p.termMonths === 1)!;
      await assert.rejects(api.submitApplication({ ...ready, residency: 'resident', planId: international.id }), (e: unknown) => e instanceof ApiError && 'planId' in (e as ApiError).fields);
      await assert.rejects(api.submitApplication({ ...ready, residency: 'international', planId: international.id, phone: 'call me' }), (e: unknown) => e instanceof ApiError && 'phone' in (e as ApiError).fields);
      const sent = await api.submitApplication({ ...ready, residency: 'international', planId: international.id });
      assert.equal(sent.data.phone, '+27 82 555 0102');
      assert.equal(sent.data.planId, international.id);
      assert.equal(sent.status, 'submitted');
      assert.ok(sent.submittedAt);
      await assert.rejects(api.saveApplicationDraft(EMPTY_APPLICATION), fails('conflict'));
    });

    test('concierge: a member sends a request, messages the desk, and can only confirm once options exist', async () => {
      const api = await fresh();
      await assert.rejects(api.listConciergeRequests(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      await assert.rejects(api.createConciergeRequest({ category: 'travel', subject: 'x', details: 'short' }), fails('validation'));
      const created = await api.createConciergeRequest({ category: 'travel', subject: 'Airport transfer', details: 'Two passengers arriving on Friday at 14:20.', neededBy: '2026-10-09' });
      assert.equal(created.status, 'requested');
      assert.equal(created.neededBy, '2026-10-09');
      assert.equal((await api.sendConciergeMessage(created.id, 'Four bags as well.')).messages.at(-1)?.from, 'member');
      await assert.rejects(api.confirmConciergeRequest(created.id), fails('conflict'));
      assert.equal((await api.cancelConciergeRequest(created.id)).status, 'cancelled');
      await assert.rejects(api.sendConciergeMessage(created.id, 'Hello?'), fails('conflict'));
      await assert.rejects(api.cancelConciergeRequest(created.id), fails('conflict'));

      const all = await api.listConciergeRequests();
      assert.equal(all.length, 2);
      const waiting = all.find((r) => r.status === 'options_provided')!;
      assert.equal(waiting.messages[0]?.from, 'desk');
      assert.equal((await api.confirmConciergeRequest(waiting.id)).status, 'confirmed');
      await assert.rejects(api.getConciergeRequest('00000000-0000-4000-8000-000000000000'), fails('not_found'));
    });

    test('messaging: only connected members can write; threads list newest first and track unread', async () => {
      const api = await fresh();
      await assert.rejects(api.listConversations(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      const members = await api.listMembers();
      const aisha = members.find((m) => m.fullName === 'Aisha Parker')!, daniel = members.find((m) => m.fullName === 'Daniel Fourie')!, chloe = members.find((m) => m.fullName === 'Chloe van der Merwe')!;
      const before = await api.listConversations();
      assert.deepEqual(before.map((c) => [c.fullName, c.unread]), [['Aisha Parker', true]]);
      const thread = await api.getConversation(aisha.id);
      assert.deepEqual(thread.messages.map((m) => m.mine), [true, false]);
      await api.markConversationRead(aisha.id);
      assert.equal((await api.listConversations())[0]?.unread, false);

      assert.equal((await api.getConversation(chloe.id)).canSend, false);
      await assert.rejects(api.sendMessage(chloe.id, 'Hello'), fails('forbidden'));
      await assert.rejects(api.sendMessage(daniel.id, '   '), fails('validation'));
      const sent = await api.sendMessage(daniel.id, 'Coffee on Tuesday?');
      assert.equal(sent.messages.at(-1)?.body, 'Coffee on Tuesday?');
      assert.equal(sent.messages.at(-1)?.mine, true);
      assert.deepEqual((await api.listConversations()).map((c) => c.fullName), ['Daniel Fourie', 'Aisha Parker']);
      assert.ok(!JSON.stringify(await api.listConversations()).includes('@'));
    });

    test('safety: a blocked member disappears everywhere until unblocked; a report is accepted once', async () => {
      const api = await fresh();
      await assert.rejects(api.listBlockedMembers(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      const aisha = (await api.listMembers()).find((m) => m.fullName === 'Aisha Parker')!, sipho = (await api.listMembers()).find((m) => m.fullName === 'Sipho Ndlovu')!;
      await assert.rejects(api.reportMember(sipho.id, { reason: 'nonsense' as never }), fails('validation'));
      await api.reportMember(sipho.id, { reason: 'unsolicited_investment', detail: 'Pitched a fund in a first message.' });
      await assert.rejects(api.reportMember(sipho.id, { reason: 'other' }), fails('conflict'));

      await api.blockMember(aisha.id);
      await api.blockMember(aisha.id);                                            // repeating it is harmless
      assert.equal((await api.listMembers()).length, 3);
      await assert.rejects(api.getMember(aisha.id), fails('not_found'));
      await assert.rejects(api.getConversation(aisha.id), fails('not_found'));
      await assert.rejects(api.sendMessage(aisha.id, 'Hello'), fails('not_found'));
      assert.deepEqual(await api.listConversations(), []);
      assert.deepEqual(await api.listBlockedMembers(), [{ id: aisha.id, fullName: 'Aisha Parker' }]);

      await api.unblockMember(aisha.id);
      assert.deepEqual(await api.listBlockedMembers(), []);
      assert.equal((await api.getMember(aisha.id)).connection, 'none');             // the connection does not come back by itself
      await assert.rejects(api.blockMember('no-such-member'), fails('not_found'));
    });

    test('privacy: settings are the member\'s own, an export carries their data, and closing the account signs them out', async () => {
      const api = await fresh();
      await assert.rejects(api.getPrivacySettings(), fails('unauthenticated'));
      await assert.rejects(api.exportMyData(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      assert.deepEqual(await api.getPrivacySettings(), { showInDirectory: true, marketingEmail: false, suggestions: true, weeklyBrief: true, dailyBrief: true });      // promotion is opt-in
      assert.deepEqual(await api.updatePrivacySettings({ showInDirectory: false, marketingEmail: true, suggestions: true, weeklyBrief: true, dailyBrief: true }), { showInDirectory: false, marketingEmail: true, suggestions: true, weeklyBrief: true, dailyBrief: true });
      await assert.rejects(api.updatePrivacySettings({ showInDirectory: 'yes' } as never), fails('validation'));
      const copy = await api.exportMyData();
      assert.equal(copy.email, 'thandi@example.com');
      assert.ok(Array.isArray(copy.bookings) && (copy.bookings as unknown[]).length >= 1);
      await assert.rejects(api.closeMyAccount('yes'), fails('validation'));
      const closed = await api.closeMyAccount('CLOSE');
      assert.ok(Date.parse(closed.eraseAfter) > Date.now() + 29 * 86_400_000);
      assert.equal(await api.getSession(), null);
    });

    test('privileges: members see published partners, redeem within the limit, and an ended privilege is refused', async () => {
      const api = await fresh();
      await assert.rejects(api.listPartners(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      const partners = await api.listPartners();
      assert.deepEqual(partners.map((p) => p.name), ['Atlantic Charter', 'Saffron House', 'The Silo Spa']);     // the draft partner is not shown
      const spa = await api.getPartner(partners[2]!.id);
      const treatment = spa.privileges.find((v) => v.title === 'A complimentary first treatment')!, thermal = spa.privileges.find((v) => v.title === 'Winter thermal circuit')!;
      assert.deepEqual([treatment.available, thermal.available], [true, false]);
      const redemption = await api.redeemPrivilege(treatment.id);
      assert.match(redemption.code, /^QP-/);
      assert.deepEqual([redemption.partnerName, redemption.privilegeTitle], ['The Silo Spa', 'A complimentary first treatment']);
      await assert.rejects(api.redeemPrivilege(treatment.id), fails('conflict'));                 // once per member
      await assert.rejects(api.redeemPrivilege(thermal.id), fails('conflict'));                   // ended
      await assert.rejects(api.redeemPrivilege('no-such-privilege'), fails('not_found'));
      const course = partners[1]!.privileges[0]!;
      await api.redeemPrivilege(course.id); await api.redeemPrivilege(course.id);                 // no limit on this one
      assert.equal((await api.listMyRedemptions()).length, 3);
      assert.equal((await api.getPartner(spa.id)).privileges.find((v) => v.id === treatment.id)?.available, false);
    });

    test('qera, the Quintara Intelligence: knows the company, recommends, books partners and services, and prepares plans', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const say = async (text: string) => { const thread = await api.sendQeraMessage(text); return { thread, reply: thread.messages.at(-1)!.text }; };

      // The company: what members are told elsewhere, by topic.
      assert.ok((await say('What is Quintara?')).reply.startsWith('Quintara is a private membership'));
      assert.ok((await say('Who is my relationship manager?')).reply.includes('Mr. Wayne Huffton of BMM Capital'));
      assert.ok((await say('How does the concierge work?')).reply.includes('Ms. Palesa Makam'));
      assert.ok((await say('What services can you arrange?')).reply.includes('One&Only Yacht Charter'));

      // Recommendations lean on the member's own interests (Dining, Wine, Art).
      const recommended = (await say('What would you recommend for me?')).reply;
      assert.ok(recommended.includes('dining') && recommended.includes('Experiences:') && recommended.includes('Partners:') && recommended.includes('Services:'), recommended);

      // A partner booking: asks for what is missing, proposes, and sends only on yes.
      assert.ok((await say('Book me a table at Saffron House')).reply.includes('For which date'));
      const proposed = await say('Book Saffron House on 2030-12-06 at 7pm for four');
      assert.equal(proposed.thread.pending?.tool, 'book_partner');
      assert.ok(proposed.reply.includes('Friday 6 December at 19:00 for 4') && proposed.reply.includes('your name, the date and the number of guests, and nothing else'), proposed.reply);
      assert.deepEqual(await api.listPartnerBookings(), []);
      const sent = await api.confirmQeraProposal(proposed.thread.pending!.id);
      assert.ok(sent.messages.at(-1)!.text.startsWith('Done. I have sent the booking to Saffron House'));
      const booking = (await api.listPartnerBookings())[0]!;
      assert.deepEqual([booking.partnerName, booking.date, booking.time, booking.partySize, booking.status], ['Saffron House', '2030-12-06', '19:00', 4, 'requested']);
      const twice = await say('Book Saffron House on 2030-12-06 for two');
      assert.ok((await api.confirmQeraProposal(twice.thread.pending!.id)).messages.at(-1)!.text.includes('already have a booking with this partner'));
      assert.ok((await say('What am I attending?')).reply.includes('Saffron House on Friday 6 December at 19:00 for 4 (requested)'));
      await api.cancelPartnerBooking(booking.id);
      await assert.rejects(api.cancelPartnerBooking(booking.id), fails('not_found'));

      // A service.
      const service = await say('Please book The Culinary House for 2030-12-07, dinner for eight');
      assert.equal(service.thread.pending?.tool, 'request_service');
      await api.confirmQeraProposal(service.thread.pending!.id);
      assert.deepEqual((await api.listMyServiceRequests()).map((r) => [r.serviceName, r.preferredDate]), [['The Culinary House', '2030-12-07']]);

      // A plan, prepared as a document that only this member can open. Nothing in it is booked.
      const plan = await say('Prepare an itinerary for a weekend from 2030-12-06 with wellness and good food');
      assert.ok(plan.thread.pending === null && plan.reply.includes('A weekend with Quintara') && plan.reply.includes('Documents'), plan.reply);
      const documents = await api.listQeraDocuments();
      assert.deepEqual(documents.map((d) => [d.kind, d.title]), [['weekend', 'A weekend with Quintara, Friday 6 December to Saturday 7 December']]);
      const document = await api.getQeraDocument(documents[0]!.id);
      assert.deepEqual([document.content.preparedFor, document.content.days.length, document.content.days[0]!.label], ['Thandi Mokoena', 2, 'Day 1. Friday 6 December']);
      assert.ok(document.content.days.every((d) => d.items.length >= 2) && document.content.days.flatMap((d) => d.items).some((i) => i.kind === 'partner' && i.book));
      assert.ok(document.content.notes[0]!.startsWith('Nothing in this plan is booked yet'));
      assert.equal((await api.listPartnerBookings()).filter((b) => b.status === 'requested').length, 0);
      assert.equal((await say('Plan a day for me on 2030-12-09')).thread.pending, null);
      assert.equal((await api.listQeraDocuments()).length, 2);
      await api.deleteQeraDocument(document.id);
      await assert.rejects(api.getQeraDocument(document.id), fails('not_found'));
      await assert.rejects(api.getPartnerBookingByToken('not-a-real-token-not-a-real-token-not-a-real-token'), fails('not_found'));
    });

    test('lifestyle services: anyone can ask to book; a guest gives a name and email; a member has a list', async () => {
      const api = await fresh();
      const services = await api.listLifestyleServices();
      assert.equal(services.length, 17);
      assert.deepEqual(services.slice(0, 2).map((s) => s.name), ['Sun\u00e9 Photography', 'One&Only Yacht Charter']);
      assert.deepEqual([...new Set(services.map((x) => x.category))].sort(), ['Beauty and Style', 'Business', 'Dining', 'Home and Design', 'Mobility', 'Photography and Media', 'Talent and Brand', 'Wellness']);
      assert.deepEqual(services.filter((x) => x.category === 'Mobility').map((x) => x.name), ['One&Only Yacht Charter', 'Elite Motion']);
      await assert.rejects(api.requestLifestyleService(services[0]!.id, { notes: 'A family portrait.' }), fails('validation'));   // a guest must say who they are
      await assert.rejects(api.requestLifestyleService(services[0]!.id, { notes: '', guest: { fullName: 'Lerato Dlamini', email: 'not-an-email' } }), fails('validation'));
      const asGuest = await api.requestLifestyleService(services[0]!.id, { notes: 'A family portrait in Constantia.', guest: { fullName: 'Lerato Dlamini', email: 'lerato@example.org' } });
      assert.deepEqual([asGuest.serviceName, asGuest.status], ['Sun\u00e9 Photography', 'requested']);
      await assert.rejects(api.listMyServiceRequests(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      await assert.rejects(api.requestLifestyleService(services[1]!.id, { preferredDate: '2020-01-01' }), fails('validation'));
      await assert.rejects(api.requestLifestyleService('00000000-0000-4000-8000-000000000000', {}), fails('not_found'));
      const mine = await api.requestLifestyleService(services[1]!.id, { preferredDate: '2030-12-06', notes: 'Sunset, eight guests.' });
      assert.deepEqual((await api.listMyServiceRequests()).map((r) => [r.serviceName, r.preferredDate, r.status]), [['One&Only Yacht Charter', '2030-12-06', 'requested']]);   // the guest's request is not in a member's list
      await api.cancelMyServiceRequest(mine.id);
      assert.equal((await api.listMyServiceRequests())[0]!.status, 'cancelled');
      await assert.rejects(api.cancelMyServiceRequest(mine.id), fails('not_found'));
    });

    test('profile picture: a member adds and removes their own; only real images are accepted', async () => {
      const api = await fresh();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      await assert.rejects(api.setMyAvatar('image/png', png), fails('unauthenticated'));
      await api.signIn(MEMBER);
      assert.equal((await api.getMyProfile()).avatarPath, null);
      await assert.rejects(api.setMyAvatar('image/gif', png), fails('validation'));
      const withPicture = await api.setMyAvatar('image/png', png);
      assert.ok(withPicture.avatarPath && (await api.getMyProfile()).avatarPath === withPicture.avatarPath);
      assert.equal((await api.removeMyAvatar()).avatarPath, null);
    });

    test('relationship manager: opportunities are shown by role, and an enquiry is the member\u2019s own conversation', async () => {
      const api = await fresh();
      await assert.rejects(api.listBusinessUpdates(), fails('unauthenticated'));
      await api.signIn(MEMBER);   // a founder: sees what is addressed to everyone, not what is for investors
      const updates = await api.listBusinessUpdates();
      assert.deepEqual(updates.map((u) => u.title), ['Brand partners for the summer season']);
      assert.deepEqual(await api.listRmEnquiries(), []);
      await assert.rejects(api.createRmEnquiry({ topic: 'investment_insight', subject: 'Hi', message: 'short' }), fails('validation'));
      const enquiry = await api.createRmEnquiry({ topic: 'partnership', subject: 'Partnering on the summer season', message: 'We would like to dress the tables at House Feast. Who should we speak to?', updateId: updates[0]!.id });
      assert.deepEqual([enquiry.topic, enquiry.updateTitle, enquiry.status, enquiry.messages.length, enquiry.messages[0]!.from], ['opportunity', 'Brand partners for the summer season', 'open', 1, 'member']);
      await assert.rejects(api.createRmEnquiry({ topic: 'opportunity', subject: 'An opportunity I cannot see', message: 'This one is not addressed to me at all.', updateId: '00000000-0000-4000-8000-000000000000' }), fails('not_found'));
      const plain = await api.createRmEnquiry({ topic: 'investment_insight', subject: 'Hospitality in the Winelands', message: 'What are members seeing in boutique hospitality at the moment?' });
      assert.equal((await api.sendRmMessage(plain.id, 'Happy to talk by phone if that is easier.')).messages.length, 2);
      assert.equal((await api.listRmEnquiries()).length, 2);
      await api.closeRmEnquiry(plain.id);
      await assert.rejects(api.sendRmMessage(plain.id, 'One more thing.'), fails('conflict'));
      await assert.rejects(api.closeRmEnquiry(plain.id), fails('not_found'));
    });

    test('business: listings are shown by role, a new listing waits for review, and an introduction goes to the team first', async () => {
      const api = await fresh();
      await assert.rejects(api.listBusinessListings(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      const listings = await api.listBusinessListings();
      // Thandi is a founder, not an investor: the listing about raising capital is not hers to see.
      assert.deepEqual(listings.map((l) => l.title).sort(), ['Brands with a story worth filming', 'Hospitality founders worth backing']);
      assert.ok(!JSON.stringify(listings).includes('@'));

      await assert.rejects(api.createBusinessListing({ kind: 'partnership', title: 'Hi', summary: 'Too short', audience: [] }), fails('validation'));
      const mine = await api.createBusinessListing({ kind: 'capital', title: 'Seed round for Kloof Street Studio', summary: 'A design studio for hospitality brands, looking to meet investors who know the sector.', audience: ['founder', 'executive'] });
      assert.deepEqual([mine.status, mine.mine, mine.audience], ['pending', true, ['investor']]);   // capital is always investors only
      assert.equal((await api.listBusinessListings())[0]?.id, mine.id);
      await api.closeBusinessListing(mine.id);
      await assert.rejects(api.closeBusinessListing(mine.id), fails('not_found'));

      const film = listings.find((l) => l.title.startsWith('Brands'))!, capital = listings.find((l) => l.title.startsWith('Hospitality'))!;
      await assert.rejects(api.requestIntroduction(film.id, 'Hello'), fails('validation'));
      const intro = await api.requestIntroduction(film.id, 'Our studio turns ten next year and the story of how it began is worth telling.');
      assert.deepEqual([intro.status, intro.direction, intro.with.fullName], ['requested', 'outgoing', 'Chloe van der Merwe']);
      await assert.rejects(api.requestIntroduction(film.id, 'Asking a second time, in case the first was missed.'), fails('conflict'));
      await assert.rejects(api.requestIntroduction(capital.id, 'We are already connected, so this should be refused.'), fails('conflict'));
      await assert.rejects(api.respondToIntroduction(intro.id, true), fails('not_found'));       // only the member asked can answer
      assert.equal((await api.listBusinessListings()).find((l) => l.id === film.id)?.myRequest, 'requested');
      await api.withdrawIntroduction(intro.id);
      assert.equal((await api.listIntroductions())[0]?.status, 'withdrawn');
    });

    test('boutique: visitors see public shelves and prices; members get member prices, delivery fees, one payment and a refund', async () => {
      const api = await fresh();
      const shelves = await api.listProducts();
      // Visitors: no members-only print, public prices, nothing to buy with.
      assert.deepEqual(shelves.map((p) => [p.title, p.priceMinor, p.publicPriceMinor]), [['Fynbos candle', 68000, null], ['Hand-stitched weekender', 1450000, null], ['Silk scarf', 320000, null]]);
      await assert.rejects(api.setWishlist(shelves[0]!.id, true), fails('unauthenticated'));       // a wishlist needs an account

      await api.signIn(MEMBER);
      const products = await api.listProducts();
      assert.deepEqual(products.map((p) => p.title), ['Fynbos candle', 'Hand-stitched weekender', 'Longkloof print, edition of fifty', 'Silk scarf']);
      const candle = products[0]!, print = products[2]!, scarf = products[3]!;
      assert.deepEqual([scarf.priceMinor, scarf.publicPriceMinor, print.membersOnly], [280000, 320000, true]);     // the member price, with the saving shown
      await api.setWishlist(print.id, true); await api.setWishlist(print.id, true);
      assert.deepEqual((await api.listProducts()).filter((p) => p.wished).map((p) => p.id), [print.id]);
      await api.setWishlist(print.id, false);

      const delivery = await api.listDeliveryOptions();
      assert.deepEqual(delivery.map((d) => [d.name, d.feeMinor]), [['Courier, South Africa', 15000]]);
      const courier = delivery[0]!, address = '12 Kloof Street, Gardens, Cape Town';
      await assert.rejects(api.createOrder({ items: [], deliveryOptionId: courier.id, deliveryAddress: address }), fails('validation'));
      await assert.rejects(api.createOrder({ items: [{ productId: print.id, quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address }), fails('validation'));          // an option is needed
      await assert.rejects(api.createOrder({ items: [{ productId: print.id, option: 'Unframed', quantity: 3 }], deliveryOptionId: courier.id, deliveryAddress: address }), fails('conflict'));   // only two left
      await assert.rejects(api.createOrder({ items: [{ productId: candle.id, quantity: 1 }], deliveryOptionId: candle.id, deliveryAddress: address }), fails('validation'));      // not a delivery method

      const small = await api.createOrder({ items: [{ productId: scarf.id, option: 'Protea', quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address });
      assert.deepEqual([small.totalMinor, small.deliveryFeeMinor, small.deliveryLabel], [280000 + 15000, 15000, 'Courier, South Africa']);
      await api.cancelOrder(small.id);

      const order = await api.createOrder({ items: [{ productId: print.id, option: 'Unframed', quantity: 2 }, { productId: candle.id, quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address });
      assert.deepEqual([order.status, order.totalMinor, order.deliveryFeeMinor, order.items.length], ['awaiting_payment', 2 * 680000 + 68000, 0, 2]);   // free delivery over the threshold
      assert.match(order.orderNumber, /^Q-\d+$/);
      assert.equal((await api.listProducts())[2]?.stock, 0);                                   // set aside while unpaid
      const paid = await api.payOrder(order.id);
      assert.deepEqual([paid.status, paid.trackingNumber], ['paid', null]);
      await assert.rejects(api.payOrder(order.id), fails('conflict'));
      assert.ok((await api.listNotifications()).some((n) => n.category === 'order'));
      const cancelled = await api.cancelOrder(order.id);
      assert.deepEqual([cancelled.status, cancelled.refundedMinor], ['cancelled', order.totalMinor]);
      assert.equal((await api.listProducts())[2]?.stock, 2);                                   // and returned
      await assert.rejects(api.cancelOrder(order.id), fails('conflict'));
      assert.equal((await api.listOrders()).length, 2);
    });

    test('boutique: a guest orders at the public price with their name and email, pays, follows and cancels the order', async () => {
      const api = await fresh();
      assert.deepEqual(await api.listOrders(), []);
      const scarf = (await api.listProducts()).find((p) => p.title === 'Silk scarf')!, courier = (await api.listDeliveryOptions())[0]!;
      const address = '4 Loader Street, De Waterkant, Cape Town';
      await assert.rejects(api.createOrder({ items: [{ productId: scarf.id, option: 'Atlantic', quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address }), fails('validation'));   // who is it for?
      await assert.rejects(api.createOrder({ items: [{ productId: scarf.id, option: 'Atlantic', quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address, guest: { fullName: 'Lerato Dube', email: 'not-an-email' } }), fails('validation'));
      const order = await api.createOrder({ items: [{ productId: scarf.id, option: 'Atlantic', quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address, guest: { fullName: 'Lerato Dube', email: 'lerato@example.org' } });
      assert.deepEqual([order.totalMinor, order.deliveryName, order.status], [320000 + 15000, 'Lerato Dube', 'awaiting_payment']);   // the public price, not the member price
      assert.equal((await api.payOrder(order.id)).status, 'paid');
      assert.deepEqual((await api.listOrders()).map((o) => o.orderNumber), [order.orderNumber]);
      assert.equal(await api.getSession(), null);                                            // ordering does not make a guest a member
      await assert.rejects(api.listMembers(), fails('unauthenticated'));
      const cancelled = await api.cancelOrder(order.id);
      assert.deepEqual([cancelled.status, cancelled.refundedMinor], ['cancelled', order.totalMinor]);
    });

    test('tv: guests watch public episodes only and are never sent a members video address; members keep their place', async () => {
      const api = await fresh();
      const guestView = (await api.listTvSeries())[0]!;
      assert.equal(guestView.title, 'The Long Table');
      assert.deepEqual(guestView.episodes.map((e) => [e.number, e.audience, e.locked, e.videoUrl !== null]), [[1, 'public', false, true], [2, 'members', true, false], [3, 'members', true, false]]);
      await assert.rejects(api.saveTvProgress(guestView.episodes[0]!.id, 30), fails('unauthenticated'));

      await api.signIn(MEMBER);
      const series = await api.listTvSeries();
      assert.equal(series.length, 1);                                                        // the series still in production is not listed
      const [first, second] = series[0]!.episodes;
      assert.ok(series[0]!.episodes.every((e) => !e.locked && e.videoUrl?.startsWith('https://')));
      await api.saveTvProgress(second!.id, 600);
      await api.saveTvProgress(first!.id, first!.durationSeconds - 5);
      await api.saveTvProgress(first!.id, 12);                                               // started again: still counted as watched
      const after = (await api.listTvSeries())[0]!.episodes;
      assert.deepEqual(after.map((e) => [e.positionSeconds, e.completed]), [[12, true], [600, false], [0, false]]);
      await assert.rejects(api.saveTvProgress(first!.id, -1), fails('validation'));
      await assert.rejects(api.saveTvProgress('no-such-episode', 10), fails('not_found'));
    });

    test('search: guests find only what is public; members find people, partners and listings too, never contact details', async () => {
      const api = await fresh();
      await assert.rejects(api.search('a'), fails('validation'));
      const guest = await api.search('the');
      assert.ok(guest.length > 0 && guest.every((r) => ['experience', 'product', 'episode'].includes(r.kind)));
      assert.deepEqual((await api.search('fourie')), []);                                    // no members for a guest
      assert.deepEqual((await api.search('silk scarf')).map((r) => [r.kind, r.title]), [['product', 'Silk scarf']]);
      assert.ok(!(await api.search('print')).some((r) => r.title.startsWith('Longkloof')));  // the members-only piece

      await api.signIn(MEMBER);
      assert.deepEqual((await api.search('helderberg')).map((r) => [r.kind, r.title]), [['member', 'Daniel Fourie'], ['listing', 'Hospitality founders worth backing']]);
      assert.deepEqual((await api.search('saffron')).map((r) => r.kind).sort(), ['member', 'partner']);
      assert.ok((await api.search('print')).some((r) => r.kind === 'product' && r.title.startsWith('Longkloof')));
      assert.ok(!(await api.search('ledgerline series')).some((r) => r.kind === 'listing'));   // a capital listing, and she is not an investor
      assert.ok((await api.search('filming')).some((r) => r.kind === 'listing'));
      assert.deepEqual(await api.search('thandi'), []);                                      // not herself
      assert.ok(!JSON.stringify(await api.search('example')).includes('@'));
    });

    test('matching: people to meet come with reasons, leave out existing connections, and stop when switched off', async () => {
      const api = await fresh();
      await assert.rejects(api.listSuggestions(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      const suggestions = await api.listSuggestions();
      // Daniel and Aisha are already connected to her, so they are not suggested.
      assert.ok(suggestions.length > 0 && suggestions.every((s) => s.member.connection === 'none' && s.reasons.length > 0));
      assert.ok(!suggestions.some((s) => ['Daniel Fourie', 'Aisha Parker', 'Thandi Mokoena'].includes(s.member.fullName)));
      assert.ok(suggestions.some((s) => s.member.fullName === 'Chloe van der Merwe' && s.reasons.some((r) => r.includes('Art'))));
      assert.ok(!JSON.stringify(suggestions).includes('@'));
      await api.updatePrivacySettings({ showInDirectory: true, marketingEmail: false, suggestions: false, weeklyBrief: true, dailyBrief: true });
      assert.deepEqual(await api.listSuggestions(), []);
    });

    test('qera: answers from what the member can see, proposes actions, and acts only when the member confirms', async () => {
      const api = await fresh();
      await assert.rejects(api.getQeraThread(), fails('unauthenticated'));
      await assert.rejects(api.sendQeraMessage('What is on?'), fails('unauthenticated'));
      await api.signIn(MEMBER);
      assert.deepEqual(await api.getQeraThread(), { messages: [], pending: null, usage: null });
      await assert.rejects(api.sendQeraMessage('   '), fails('validation'));

      const listed = await api.sendQeraMessage('What is on this month?');
      assert.deepEqual(listed.messages.map((m) => m.role), ['member', 'qera']);
      assert.ok(listed.messages[1]!.text.includes('Costa Convivio') && listed.pending === null);

      // Asking to book proposes; nothing is booked yet.
      const before = (await api.listBookings()).length;
      const proposed = await api.sendQeraMessage('Please book two seats at The Executive Yacht Club');
      assert.ok(proposed.pending && proposed.pending.tool === 'book_experience');
      assert.ok(proposed.pending!.summary.includes('2 seats at The Executive Yacht Club') && proposed.messages.at(-1)!.text.endsWith('Shall I go ahead?'));
      assert.equal((await api.listBookings()).length, before);

      // Saying no does nothing, and the proposal cannot then be confirmed.
      const declined = await api.cancelQeraProposal(proposed.pending!.id);
      assert.equal(declined.pending, null);
      await assert.rejects(api.confirmQeraProposal(proposed.pending!.id), fails('conflict'));
      assert.equal((await api.listBookings()).length, before);

      // A new message replaces a waiting proposal; confirming the current one books.
      const first = await api.sendQeraMessage('Reserve a seat at The Executive Yacht Club');
      const second = await api.sendQeraMessage('Book 2 seats at The Executive Yacht Club');
      await assert.rejects(api.confirmQeraProposal(first.pending!.id), fails('conflict'));
      const done = await api.confirmQeraProposal(second.pending!.id);
      assert.ok(done.messages.at(-1)!.text.startsWith('Done. The Executive Yacht Club: confirmed.') && done.pending === null);
      const booking = (await api.listBookings()).find((b) => b.experienceTitle === 'The Executive Yacht Club')!;
      assert.deepEqual([booking.seats, booking.status], [2, 'confirmed']);
      await assert.rejects(api.confirmQeraProposal(second.pending!.id), fails('conflict'));     // once only

      // The usual rules still apply: a second booking for the same experience is refused when it runs.
      const again = await api.sendQeraMessage('Book a seat at The Executive Yacht Club');
      assert.ok((await api.confirmQeraProposal(again.pending!.id)).messages.at(-1)!.text.startsWith('I could not do that.'));

      const cancel = await api.sendQeraMessage('Cancel my booking for The Executive Yacht Club');
      assert.equal(cancel.pending?.tool, 'cancel_booking');
      await api.confirmQeraProposal(cancel.pending!.id);
      assert.equal((await api.listBookings()).find((b) => b.id === booking.id)?.status, 'cancelled');

      // Something Quintara has partners for is offered, not passed on.
      const table = await api.sendQeraMessage('Please arrange a table for six on Saturday evening, somewhere quiet');
      assert.ok(table.pending === null && table.messages.at(-1)!.text.includes('I can book Saffron House'), table.messages.at(-1)!.text);
      // Only what it cannot manage itself is referred to the Lifestyle Curator, and then only with the member's yes.
      const desk = await api.sendQeraMessage('Please arrange a visa appointment and a private jet to Windhoek next month');
      assert.equal(desk.pending?.tool, 'create_concierge_request');
      assert.ok(desk.pending!.summary.includes('Ms. Palesa Makam'));
      const requests = (await api.listConciergeRequests()).length;
      await api.confirmQeraProposal(desk.pending!.id);
      assert.equal((await api.listConciergeRequests()).length, requests + 1);

      assert.ok((await api.sendQeraMessage('Who should I meet?')).messages.at(-1)!.text.includes('Chloe van der Merwe'));
      assert.ok(!JSON.stringify(await api.getQeraThread()).includes('@example.com'));         // no contact details, ever
      await api.clearQeraThread();
      assert.deepEqual(await api.getQeraThread(), { messages: [], pending: null, usage: null });
    });

    test('notifications can be marked as read', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const unread = (await api.listNotifications()).find((n) => !n.readAt)!;
      await api.markNotificationRead(unread.id);
      assert.ok((await api.listNotifications()).find((n) => n.id === unread.id)?.readAt);
    });

    test('guests and visitors are never sent experience dates or seat counts; members are', async () => {
      const api = await fresh();
      const open = await api.listExperiences();
      assert.ok(open.length > 0);
      for (const e of open) { assert.equal(e.startsAt, null); assert.equal(e.capacity, null); assert.equal(e.seatsTaken, null); assert.equal(e.openToGuests, true); }
      const one = await api.getExperience(open[0]!.id);
      assert.equal(one.startsAt, null);
      assert.equal(one.capacity, null);
      await api.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.guest@example.com' });
      assert.ok((await api.listExperiences()).every((e) => e.startsAt === null && e.seatsTaken === null));
      await api.signOut();
      await api.signIn(MEMBER);
      assert.ok((await api.listExperiences()).every((e) => typeof e.startsAt === 'string' && typeof e.capacity === 'number'));
    });

    test('a guest creates a personal account, signs in again later, and holds no member powers', async () => {
      const api = await fresh();
      assert.equal(await api.getGuestAccount(), null);
      await assert.rejects(api.createGuestAccount({ fullName: 'L', email: 'not-an-email' }), fails('validation'));
      const guest = await api.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.guest@example.com' });
      assert.equal(guest.fullName, 'Lerato Guest');
      assert.equal((await api.getGuestAccount())?.email, 'lerato.guest@example.com');
      assert.equal(await api.getSession(), null);
      await assert.rejects(api.listMembers(), fails('unauthenticated'));
      await assert.rejects(api.listPartners(), fails('unauthenticated'));
      await assert.rejects(api.createGuestAccount({ fullName: 'Lerato Guest', email: 'other@example.com' }), fails('conflict'));
      assert.equal((await api.updateGuestAccount({ fullName: 'Lerato M.' })).fullName, 'Lerato M.');
      await api.signOut();
      assert.equal(await api.getGuestAccount(), null);
      await assert.rejects(api.signInGuest({ email: 'nobody@example.com' }), fails('unauthenticated'));
      assert.equal((await api.signInGuest({ email: 'lerato.guest@example.com' })).fullName, 'Lerato M.');
      assert.equal(((await api.exportGuestData()).account as { email: string }).email, 'lerato.guest@example.com');
      await api.deleteGuestAccount();
      assert.equal(await api.getGuestAccount(), null);
      await assert.rejects(api.signInGuest({ email: 'lerato.guest@example.com' }), fails('unauthenticated'));
    });

    test('QÉRA is open to guest accounts with a daily allowance, read-only tools and no member data', async () => {
      const api = await fresh();
      await assert.rejects(api.getQeraThread(), fails('unauthenticated'));
      await api.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.guest@example.com' });
      const start = await api.getQeraThread();
      assert.equal(start.usage?.limitSeconds, 5 * 60 * 60);
      assert.equal(start.usage?.exhausted, false);
      const about = await api.sendQeraMessage('What is Quintara?');
      assert.match(about.messages.at(-1)!.text, /private membership/);
      const book = await api.sendQeraMessage('Book me a seat at Costa Convivio');
      assert.equal(book.pending, null);
      assert.match(book.messages.at(-1)!.text, /for members/);
      const on = await api.sendQeraMessage("What's on?");
      assert.match(on.messages.at(-1)!.text, /Costa Convivio/);
      assert.doesNotMatch(on.messages.at(-1)!.text, /seats left|October|November/);
      const heartbeat = await api.qeraHeartbeat();
      assert.equal(heartbeat?.limitSeconds, 5 * 60 * 60);
      await api.clearQeraThread();
      assert.equal((await api.getQeraThread()).messages.length, 0);
      await assert.rejects(api.listQeraDocuments(), fails('unauthenticated'));
    });

    test('QÉRA on WhatsApp: members link a number with a one-time code they send from WhatsApp', async () => {
      const api = await fresh();
      await assert.rejects(api.getWhatsApp(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      assert.equal((await api.getWhatsApp()).status, 'none');
      await assert.rejects(api.linkWhatsApp({ consent: false as never }), fails('validation'));
      const started = await api.linkWhatsApp({ consent: true });
      assert.equal(started.status, 'pending');
      assert.equal(started.message, `LINK ${started.code}`);
      assert.ok(started.openUrl!.startsWith('https://wa.me/'));
      await api.unlinkWhatsApp();
      assert.equal((await api.getWhatsApp()).status, 'none');
    });

    test('the application asks for a social media handle: Instagram, TikTok or X', async () => {
      const api = await fresh();
      const planId = (await api.listMembershipPlans())[0]!.id;
      const base = { ...EMPTY_APPLICATION, planId, phone: '+27 21 555 0199', email: 'handle.person@example.com', fullName: 'Handle Person', city: 'Durban', position: 'Founder', industry: 'Retail', motivation: 'I would like to host dinners for founders.' };
      await assert.rejects(api.submitApplication(base), (e: unknown) => e instanceof ApiError && e.code === 'validation' && 'socialHandle' in e.fields);
      await assert.rejects(api.submitApplication({ ...base, socialHandle: 'not a handle!' }), (e: unknown) => e instanceof ApiError && 'socialHandle' in (e as ApiError).fields);
      const sent = await api.submitApplication({ ...base, socialPlatform: 'x', socialHandle: '@handleperson' });
      assert.equal(sent.data.socialPlatform, 'x');
      assert.equal(sent.data.socialHandle, '@handleperson');
    });

    test('chief of staff: lifestyle services come with packages, indicative prices and notice periods', async () => {
      const api = await fresh();
      const services = await api.listLifestyleServices();
      assert.ok(services.every((x) => x.packages.length >= 1));
      const photo = services.find((x) => x.name === 'Suné Photography')!, event = photo.packages.find((p) => p.name === 'Event coverage')!;
      assert.deepEqual([event.priceMinor, event.priceBasis, event.leadTimeHours], [1200000, 'per_booking', 168]);
      await api.signIn(MEMBER);
      const tomorrow = new Date(Date.now() + 26 * 3_600_000).toISOString().slice(0, 10), later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      await assert.rejects(api.requestLifestyleService(photo.id, { preferredDate: tomorrow, notes: '', packageId: event.id }), (e: unknown) => e instanceof ApiError && e.code === 'validation' && /earliest date/.test(e.fields.preferredDate ?? ''));
      await assert.rejects(api.requestLifestyleService(photo.id, { notes: '', packageId: services[1]!.packages[0]!.id }), fails('validation'));
      const made = await api.requestLifestyleService(photo.id, { preferredDate: later, notes: 'A launch party.', packageId: event.id });
      assert.equal(made.packageName, 'Event coverage');
      assert.match(made.priceLabel ?? '', /12\s000.*per booking/);
      assert.equal((await api.listMyServiceRequests())[0]!.packageName, 'Event coverage');
    });

    test('chief of staff: memory the member can see, change and remove, and that QÉRA writes only when asked', async () => {
      const api = await fresh();
      await assert.rejects(api.getQeraMemory(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      assert.deepEqual((await api.getQeraMemory()).items, []);
      await assert.rejects(api.addQeraMemory({ kind: 'date', label: 'Our anniversary' }), fails('validation'));
      const added = await api.addQeraMemory({ kind: 'likes', label: 'Natural wine' });
      await assert.rejects(api.addQeraMemory({ kind: 'likes', label: 'natural wine' }), fails('conflict'));
      assert.equal((await api.updateQeraMemory(added.id, { kind: 'likes', label: 'Natural wine and oysters' })).label, 'Natural wine and oysters');
      // QÉRA asks before it remembers anything.
      const asked = await api.sendQeraMessage('Remember that I am vegetarian');
      assert.equal(asked.pending?.tool, 'remember');
      assert.equal((await api.getQeraMemory()).items.length, 1);
      await api.confirmQeraProposal(asked.pending!.id);
      const items = (await api.getQeraMemory()).items;
      assert.deepEqual(items.map((m) => [m.kind, m.label, m.source]).sort(), [['dietary', 'Vegetarian', 'qera'], ['likes', 'Natural wine and oysters', 'member']]);
      assert.match((await api.sendQeraMessage('What do you know about me?')).messages.at(-1)!.text, /Dietary: Vegetarian/);
      const forget = await api.sendQeraMessage('Forget that I am vegetarian');
      assert.equal(forget.pending?.tool, 'forget');
      await api.confirmQeraProposal(forget.pending!.id);
      assert.deepEqual((await api.getQeraMemory()).items.map((m) => m.label), ['Natural wine and oysters']);
      await api.deleteQeraMemory(added.id);
      await api.addQeraMemory({ kind: 'person', label: 'Lindiwe, my wife' });
      await api.clearQeraMemory();
      assert.deepEqual((await api.getQeraMemory()).items, []);
    });

    test('chief of staff: reminders and the weekly brief', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      const day = (n: number) => new Date(Date.now() + 2 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
      await assert.rejects(api.createReminder({ text: 'Too late', date: day(-2), time: '09:00' }), fails('validation'));
      const r = await api.createReminder({ text: 'Collect the suit from Atelier Lunda', date: day(2), time: '10:30' });
      assert.equal(r.status, 'scheduled');
      const asked = await api.sendQeraMessage('Remind me to call the florist tomorrow at 10am');
      assert.equal(asked.pending?.tool, 'set_reminder');
      await api.confirmQeraProposal(asked.pending!.id);
      const list = await api.listReminders();
      assert.deepEqual(list.map((x) => x.text).sort(), ['Call the florist', 'Collect the suit from Atelier Lunda']);
      await api.cancelReminder(r.id);
      assert.deepEqual((await api.listReminders()).map((x) => x.text), ['Call the florist']);
      await api.addQeraMemory({ kind: 'date', label: 'Our anniversary', date: `2019-${day(9).slice(5)}` });
      const brief = await api.getWeeklyBrief();
      assert.deepEqual(brief.sections.map((x) => x.key), ['week', 'dates', 'waiting', 'chosen', 'worth']);
      assert.match(brief.sections.find((x) => x.key === 'dates')!.items[0]!.detail, /in 9 days/);
      assert.ok(brief.sections.find((x) => x.key === 'week')!.items.some((i) => i.title === 'Reminder: Call the florist'));
      assert.ok(brief.sections.find((x) => x.key === 'chosen')!.items.length > 0);
      assert.match((await api.sendQeraMessage('What does my week look like?')).messages.at(-1)!.text, /Your week/);
    });

    test('chief of staff: a prepared plan is booked in one confirmation, line by line, with the usual checks', async () => {
      const api = await fresh();
      await api.signIn(MEMBER);
      await api.addQeraMemory({ kind: 'dietary', label: 'No shellfish' });
      const planned = await api.sendQeraMessage('Plan a weekend for me');
      assert.match(planned.messages.at(-1)!.text, /Documents/);
      const doc = (await api.listQeraDocuments())[0]!;
      const preview = await api.previewPlanBooking(doc.id, 2);
      assert.ok(preview.lines.length >= 2);
      assert.ok(preview.notes.some((n) => /No shellfish/.test(n)));
      const ready = preview.lines.filter((l) => l.bookable);
      assert.ok(ready.length >= 1, JSON.stringify(preview.lines));
      await assert.rejects(api.bookPlan(doc.id, { partySize: 2, lines: [] }), fails('validation'));
      const first = ready[0]!;
      const booked = await api.bookPlan(doc.id, { partySize: 2, lines: [first.index] });
      assert.equal(booked.lines[0]!.ok, true, JSON.stringify(booked));
      const again = await api.previewPlanBooking(doc.id, 2);
      assert.equal(again.lines.find((l) => l.index === first.index)!.bookable, false);
      assert.ok(again.lines.find((l) => l.index === first.index)!.status);
      // Through QÉRA: one proposal for the rest of the plan, and nothing happens until it is confirmed.
      const asked = await api.sendQeraMessage('Book the whole plan for 2');
      if (again.lines.some((l) => l.bookable)) {
        assert.equal(asked.pending?.tool, 'book_plan', asked.messages.at(-1)!.text);
        const done = await api.confirmQeraProposal(asked.pending!.id);
        assert.match(done.messages.at(-1)!.text, /booked/);
        assert.ok((await api.previewPlanBooking(doc.id, 2)).lines.every((l) => !l.bookable));
      }
    });

    test('cities: the open cities are listed, and switching city shows that city\'s experiences, members, partners, services and Maison Quintara', async () => {
      const api = await fresh();
      assert.deepEqual((await api.listMarkets()).map((m) => m.slug), ['cape-town', 'johannesburg']);
      api.setMarket('johannesburg');
      assert.deepEqual((await api.listExperiences()).map((e) => e.title), ['Founders Breakfast']);
      await api.signIn(MEMBER);
      assert.deepEqual((await api.listExperiences()).map((e) => e.title), ['The Rooftop Supper', 'Founders Breakfast']);
      assert.deepEqual((await api.listMembers()).map((m) => m.fullName), ['Kagiso Molefe', 'Lindiwe Dube']);
      assert.deepEqual((await api.listPartners()).map((p) => p.name).sort(), ['Highveld Wellness Rooms', 'Marula House']);
      assert.deepEqual((await api.listLifestyleServices()).map((x) => x.name), ['BMM Capital', 'EliteReach Management']);
      assert.deepEqual((await api.listProducts()).map((p) => p.title), ['Highveld candle']);
      // A city that is not open, or does not exist, falls back to the member's home city.
      api.setMarket('durban');
      assert.equal((await api.listExperiences()).length, 10);
      api.setMarket(null);
      assert.equal((await api.listExperiences()).length, 10);
      assert.ok((await api.listMembers()).some((m) => m.fullName === 'Daniel Fourie'));
    });

    test('section descriptions: everyone reads them, with Quintara\'s wording until staff change it', async () => {
      const api = await fresh();
      const list = await api.listSectionCopy();
      assert.deepEqual(list.map((c) => c.key), ['qera', 'club', 'concierge', 'lifestyle', 'privileges', 'boutique', 'bookings', 'messaging', 'curator', 'experiences', 'business', 'relationship', 'matching', 'services', 'partners', 'tv', 'membership', 'guest', 'notifications']);
      assert.ok(list.every((c) => c.updatedAt === null && c.description.length > 10 && c.summary.length > 2));
      assert.match(list.find((c) => c.key === 'curator')!.title, /Palesa Makam/);
    });

    test('daily brief: a connected calendar puts the member\'s own day beside Quintara\'s; titles can be hidden; disconnecting removes it', async () => {
      const api = await fresh();
      await assert.rejects(api.getDailyBrief(), fails('unauthenticated'));
      await api.signIn(MEMBER);
      const empty = await api.getDailyBrief();
      assert.equal(empty.calendar.connected, false);
      assert.match(empty.greeting, /^Good (morning|afternoon|evening), Thandi\.$/);
      assert.ok(empty.agenda.every((i) => i.source !== 'calendar'));
      assert.equal((await api.getCalendar()).connection, null);
      // Consent is required, and only the provider's own address is accepted.
      await assert.rejects(api.connectCalendar({ provider: 'sample', showTitles: true } as never), fails('validation'));
      await assert.rejects(api.connectCalendar({ provider: 'google', address: 'https://evil.example.com/calendar.ics', showTitles: true, consent: true }), fails('validation'));
      const connected = await api.connectCalendar({ provider: 'sample', showTitles: true, consent: true });
      assert.equal(connected.connection?.provider, 'sample');
      assert.ok(connected.events.some((e) => e.title === 'Board meeting'));
      const brief = await api.getDailyBrief();
      assert.equal(brief.calendar.connected, true);
      const mine = brief.agenda.filter((i) => i.source === 'calendar');
      assert.deepEqual(mine.map((i) => i.title), ['Weekly team check-in', 'Design review with the hotel group', 'Call with the London office']);
      assert.deepEqual(mine.map((i) => i.time), ['08:30', '11:00', '16:30']);
      assert.ok(brief.agenda.every((i, k) => k === 0 || (brief.agenda[k - 1]!.time ?? '00:00') <= (i.time ?? '00:00')));
      // With titles hidden QÉRA keeps only the busy times.
      const hidden = await api.updateCalendar({ showTitles: false });
      assert.ok(hidden.events.every((e) => e.title === '' && e.location === ''));
      assert.deepEqual((await api.getDailyBrief()).agenda.filter((i) => i.source === 'calendar').map((i) => i.title), ['Busy', 'Busy', 'Busy']);
      await api.disconnectCalendar();
      assert.equal((await api.getCalendar()).connection, null);
      assert.ok((await api.getDailyBrief()).agenda.every((i) => i.source !== 'calendar'));
    });
  });
}

contract('mock API', () => createMockApi({ latencyMs: 0 }));

describe('real API on PostgreSQL', () => {
  let server: TestServer;
  // Each scenario gets its own database so they cannot affect one another.
  const servers: TestServer[] = [];
  // Closed after each scenario: an in-memory database is large, and holding them all open exhausts memory.
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
  contract('contract', async () => { server = await startServer(); servers.push(server); return server.client(); });
});
