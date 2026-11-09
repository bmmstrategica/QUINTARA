/**
 * Development and test data. The same placeholder content as the mock API,
 * so the apps look identical whichever one they talk to. Never run against production.
 */
import { sampleDate } from '@quintara/domain';
import { addDefaultPlans } from './application-form.ts';
import type { Db } from './db.ts';

/** A service's one-line description for the directory. The person to ask for is left empty until each provider confirms one. */
const firstSentence = (text: string) => `${text.split('. ')[0]!.replace(/\.$/, '')}.`.slice(0, 240);

const ZONE = 'Africa/Johannesburg';

/** `history`: also a year of past payments, for Insights in development (tests leave it out). */
export async function seed(db: Db, options: { history?: boolean } = {}): Promise<void> {
  await db.tx(async (tx) => {
    const one = async (sql: string, params: unknown[] = []) => (await tx.query<{ id: string }>(sql, params))[0]!.id;

    await tx.query(`INSERT INTO currencies (code, name) VALUES ('ZAR', 'South African rand'), ('USD', 'US dollar')`);
    await tx.query(`INSERT INTO countries (code, name) VALUES ('ZA', 'South Africa')`);
    const city = await one(`INSERT INTO cities (country_code, name, timezone) VALUES ('ZA', 'Cape Town', $1) RETURNING id`, [ZONE]);
    const market = await one(`INSERT INTO markets (city_id, slug, name, currency_code, opened_at) VALUES ($1, 'cape-town', 'Cape Town', 'ZAR', now()) RETURNING id`, [city]);
    await addDefaultPlans(tx, market, 'ZAR');
    // Staff accounts for development. They are not members.
    for (const [email, role, name, title] of [['admin@example.com', 'admin', 'Nomsa Admin', 'Head of operations'], ['desk@example.com', 'concierge', 'Palesa Makam', 'Lifestyle Curator'], ['content@example.com', 'content', 'Lerato Content', 'Content and Maison Quintara']] as const) {
      const id = await one(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [email]);
      await tx.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2)', [id, role]);
      await tx.query('INSERT INTO staff_accounts (user_id, full_name, title) VALUES ($1, $2, $3)', [id, name, title]);
    }
    const founding = await one(`INSERT INTO membership_tiers (market_id, name, price_minor, currency_code) VALUES ($1, 'Founding member', 3600000, 'ZAR') RETURNING id`, [market]);
    const standard = await one(`INSERT INTO membership_tiers (market_id, name, price_minor, currency_code) VALUES ($1, 'Member', 4800000, 'ZAR') RETURNING id`, [market]);

    const people: [key: string, name: string, email: string, position: string, company: string, industry: string, cityName: string, bio: string, interests: string[], looking: string, offer: string, roles: string[], tier: string, joined: string][] = [
      ['thandi', 'Thandi Mokoena', 'thandi@example.com', 'Founder', 'Kloof Street Studio', 'Design', 'Cape Town', 'Building a design studio for hospitality brands.', ['Dining', 'Wine', 'Art'], 'A hotel group ready to rethink its guest experience', 'Brand and interior direction for hospitality', ['member', 'founder'], founding, '2026-06-12'],
      ['daniel', 'Daniel Fourie', 'daniel@example.com', 'Partner', 'Helderberg Capital', 'Venture capital', 'Stellenbosch', 'Early-stage investor in consumer and climate.', ['Golf', 'Wine', 'Investment'], 'Founders with first revenue', 'Seed funding and board experience', ['member', 'investor'], standard, '2026-05-02'],
      ['aisha', 'Aisha Parker', 'aisha@example.com', 'Chef and owner', 'Saffron House', 'Hospitality', 'Cape Town', 'Cape Malay cooking, told properly.', ['Dining', 'Culture'], 'A second site on the Atlantic seaboard', 'Private dinners and menu consulting', ['member', 'creative'], standard, '2026-07-20'],
      ['sipho', 'Sipho Ndlovu', 'sipho@example.com', 'Chief executive', 'Ledgerline', 'Technology', 'Johannesburg', 'Payments infrastructure for African merchants.', ['Padel', 'Business'], 'Series A partners', 'Introductions across fintech', ['member', 'founder'], standard, '2026-09-18'],
      ['chloe', 'Chloe van der Merwe', 'chloe@example.com', 'Director', 'Longkloof Pictures', 'Film', 'Cape Town', 'Commercials and documentaries.', ['Art', 'Fashion'], 'Brands with a story worth filming', 'Creative direction', ['member', 'creative'], standard, '2026-09-27'],
    ];
    const member: Record<string, string> = {}, user: Record<string, string> = {};
    let number = 1001;
    for (const [key, name, email, position, company, industry, cityName, bio, interests, looking, offer, roles, tier, joined] of people) {
      user[key] = await one(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [email]);
      await tx.query(`INSERT INTO profiles (user_id, full_name, position, company, industry, city, biography, interests, looking_for, can_offer) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)`, [user[key], name, position, company, industry, cityName, bio, interests, looking, offer]);
      for (const role of roles) await tx.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2)', [user[key], role]);
      member[key] = await one(`INSERT INTO members (user_id, member_number, home_market_id, tier_id, joined_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [user[key], `Q-${number++}`, market, tier, joined]);
    }
    // Terms: Thandi's renews automatically in three weeks, with a test card on file; everyone else's ends later in the year.
    await tx.query(`UPDATE members SET term_ends_at = now() + interval '200 days' WHERE home_market_id = $1`, [market]);
    await tx.query(`UPDATE members SET term_ends_at = now() + interval '21 days', auto_renew = true WHERE id = $1`, [member.thandi]);
    // A year of past payments (older than a month), so Insights has something to show in development.
    for (let k = 0; options.history && k < 52; k++) {
      const who = [user.thandi, user.daniel, user.aisha, user.chloe][k % 4]!, purpose = (['experience', 'boutique', 'experience', 'membership_renewal', 'membership'] as const)[k % 5]!;
      const amount = { experience: 450000 + (k % 7) * 85000, boutique: 120000 + (k % 5) * 64000, membership_renewal: 3600000, membership: 3000000 }[purpose];
      if ((purpose === 'membership' || purpose === 'membership_renewal') && k % 3) continue;
      await tx.query(`INSERT INTO payments (user_id, market_id, purpose, amount_minor, currency_code, provider, idempotency_key, status, paid_at) VALUES ($1, $2, $3, $4, 'ZAR', 'mock', $5, 'paid', now() - make_interval(days => $6))`,
        [who, market, purpose, amount, `seed-history-${k}`, 35 + k * 6]);
    }
    await tx.query(`INSERT INTO payment_methods (user_id, provider, provider_token, brand, last4, exp_month, exp_year) VALUES ($1, 'mock', 'mock_pm_visa_seed', 'Visa', '4242', 12, extract(year FROM now())::int + 3)`, [user.thandi]);
    await tx.query(`INSERT INTO connections (requester_id, addressee_id, status) VALUES ($1, $2, 'connected'), ($1, $3, 'connected'), ($4, $1, 'requested')`, [member.thandi, member.daniel, member.aisha, member.sipho]);

    const experiences: [key: string, title: string, category: string, summary: string, description: string, startsAt: string, venue: string, area: string, dress: string, host: string, programme: [string, string][], included: string[], capacity: number, held: number, price: number, memberPrice: number, admission: string, hidden: boolean, guests: string, maxSeats: number][] = [
      ['costa', 'Costa Convivio', 'Retreats', 'The Cape Winelands retreat. An exquisite escape, a shared table, a deeper connection.', 'Costa Convivio is Quintara\u2019s signature retreat experience, bringing together wellness, gastronomy, culture and meaningful connection in exceptional surroundings. Set against the beauty of the Cape Winelands, it offers an intimate escape for those who appreciate thoughtful hospitality, engaging company and the pleasure of a day beautifully spent. From leisurely mornings and vineyard discoveries to elegant dining and conversations that linger, it creates space to reconnect with yourself, with nature and with an inspiring circle of people.', '2026-10-11T08:00:00Z', 'A private wine estate', 'Cape Winelands', 'Linen and colour', 'Aisha Parker', [['10:00', 'Arrival and a leisurely morning'], ['11:30', 'Vineyard discovery'], ['13:30', 'Lunch at the shared table']], ['Wellness session', 'Vineyard discovery', 'Lunch with estate wines'], 40, 21, 145000, 115000, 'open', false, 'Members may bring up to three guests.', 4],
      ['episimo', 'Ep\u00edsimo D\u00edpno', 'Fine dining', 'The art of dining. Considered hospitality, remarkable cuisine and conversations that deserve an evening of their own.', 'Ep\u00edsimo D\u00edpno is Quintara\u2019s signature fine dining experience, bringing together a carefully curated circle of members and invited guests around one beautifully appointed table. Set within distinguished restaurants, intimate private residences and exceptional hospitality destinations, each edition celebrates the pleasure of dining well and the people who make it memorable. From the welcome drink to the final conversation, every detail serves a shared purpose: an evening of warmth, discovery and meaningful connection.', '2026-10-17T17:00:00Z', 'A private residence', 'Constantia', 'Black tie', 'Quintara', [['19:00', 'Welcome drink'], ['20:00', 'Dinner at one table'], ['23:00', 'The final conversation']], ['Welcome drink', 'Dinner with paired wines'], 24, 24, 240000, 240000, 'members_only', false, 'One guest per member.', 2],
      ['rally', 'The Penthouse Sessions', 'Conversations', 'Hosted in Cape Town\u2019s most exclusive penthouses, for a small audience of 20 to 30 guests.', 'Intimate sessions on entrepreneurship, wealth, artificial intelligence, leadership, luxury and venture capital, hosted in Cape Town\u2019s most exclusive penthouses. The audience is kept to 20 to 30 guests, so seats are allocated by the Quintara team.', '2026-10-22T16:00:00Z', 'A private penthouse', 'Cape Town', 'Smart', 'Sipho Ndlovu', [['18:00', 'Arrival'], ['18:30', 'The session'], ['20:00', 'Drinks and conversation']], ['The session', 'Drinks'], 30, 12, 0, 0, 'application_required', false, 'Members only. No guests.', 1],
      ['invitational', 'Quintara Golf Invitational', 'Golf', 'A private golf networking day, by invitation.', 'A private golf networking day with luxury hospitality, pairings that bring investors, founders and creatives together, and executive networking from the first tee to the clubhouse.', '2026-10-29T05:30:00Z', 'Steenberg Golf Club', 'Tokai', 'Club golf attire', 'Daniel Fourie', [['07:30', 'Breakfast and registration'], ['08:30', 'Shotgun start'], ['13:30', 'Lunch and networking']], ['Luxury hospitality', 'Curated pairings', 'Executive networking'], 48, 30, 320000, 320000, 'invitation_only', true, 'Invitations are personal.', 1],
      ['code', 'The Executive Yacht Club', 'Networking', 'Networking aboard a luxury yacht along the Atlantic Seaboard.', 'A sunset cruise along the Atlantic Seaboard with a champagne reception, live music and gourmet dining. Investor introductions are arranged by the Quintara team on request.', '2026-11-05T16:00:00Z', 'Aboard a private yacht', 'Atlantic Seaboard', 'Yacht smart', 'Quintara', [['18:00', 'Boarding and champagne reception'], ['18:45', 'Sunset cruise and live music'], ['20:00', 'Dinner and introductions']], ['Champagne reception', 'Gourmet dining', 'Live music'], 60, 18, 0, 0, 'members_only', false, 'One guest per member.', 2],
      ['aura', 'The Aura Enclave', 'Signature evenings', 'A Gatsby experience. An era reimagined, not recreated.', 'An exquisite evening. An intriguing encounter. The beginning of summer. As the last light of a Cape Town afternoon dissolves into gold across the Atlantic, Quintara opens its most anticipated chapter of the year. The Aura Enclave is not simply an event; it is an invitation into a world where elegance is not performed, but lived; where the romance of a bygone era meets the unmistakable pulse of the city\u2019s most sought-after private circle. This is summer, as it was always meant to be entered: beautifully, deliberately, and among company worth remembering.', '2026-11-13T16:00:00Z', 'A private address', 'Atlantic Seaboard', 'Gatsby, reimagined', 'Quintara', [['18:00', 'Arrival at golden hour'], ['19:30', 'The evening opens'], ['22:00', 'Late music']], ['Welcome reception', 'Dinner', 'Music'], 120, 115, 450000, 380000, 'open', false, 'One guest per booking.', 2],
      ['investor', 'The Investor Circle', 'Investment', 'Cape Town\u2019s premier invitation-only investment breakfast.', 'An exclusive breakfast for family offices, venture capitalists, angel investors and founders. Topics include investment trends, capital raising, deal sourcing, wealth creation and cross-border investment.', '2026-11-19T05:30:00Z', 'A private dining room', 'Cape Town', 'Business', 'Daniel Fourie', [['07:30', 'Arrival and coffee'], ['08:00', 'Breakfast and discussion'], ['09:30', 'Introductions']], ['Breakfast'], 24, 10, 0, 0, 'invitation_only', false, 'Invitations are personal.', 1],
      ['tennis', 'Quintara Tennis Social', 'Sport and wellness', 'Play. Connect. Inspire.', 'A members-only, invitation-only networking experience that brings together a curated community of 15 to 20 entrepreneurs, startup founders, investors, executives and premium digital creators for an afternoon of sport, wellness, meaningful conversation and luxury hospitality. It is not a competitive tournament, but a sophisticated lifestyle gathering where business relationships are cultivated through shared experiences in a relaxed and elegant environment.', '2026-11-21T12:00:00Z', 'A private tennis club', 'Cape Town', 'Tennis whites', 'Quintara', [['14:00', 'Arrival and welcome'], ['14:30', 'Social tennis'], ['17:00', 'Hospitality and conversation']], ['Social tennis', 'Wellness', 'Luxury hospitality'], 20, 8, 150000, 120000, 'members_only', false, 'Members only. No guests.', 1],
      ['feast', 'House Feast', 'Parties', 'The Quintara signature villa party.', 'Afro house sunsets with scenic views of the Atlantic Seaboard. A DJ, acoustic sets and good vibes.', '2026-11-28T14:00:00Z', 'A private villa', 'Atlantic Seaboard', 'Summer chic', 'Quintara', [['16:00', 'Doors'], ['17:30', 'Sunset set'], ['20:00', 'Acoustic session']], ['DJ and acoustic sets', 'Welcome drink'], 150, 60, 95000, 75000, 'open', false, 'Members may bring up to three guests.', 4],
      ['tera', 'Tera Convivio', 'Journeys', 'Three days of wilderness, refined hospitality and exceptional company.', 'Tera Convivio brings Quintara\u2019s spirit of connection into the African wilderness. Over three days and two nights, an intimate gathering of members and invited guests discovers extraordinary landscapes, shares beautifully prepared meals and enjoys the comfort of a luxury villa reserved exclusively for the group. The journey begins in Cape Town, continues through Johannesburg and unfolds with a private helicopter transfer to the Greater Kruger. At its heart is an unhurried rhythm: early mornings in the bush, leisurely afternoons at the villa and evenings gathered around a beautifully dressed table.', '2026-12-04T06:00:00Z', 'A private safari villa', 'Greater Kruger', 'Safari neutrals', 'Quintara', [['Day 1', 'Cape Town to Johannesburg, then by private helicopter to the villa'], ['Day 2', 'Early morning in the bush, an afternoon at the villa, dinner at a dressed table'], ['Day 3', 'A last morning in the bush and the journey home']], ['Two nights in a private villa', 'All meals', 'Private helicopter transfer'], 12, 4, 9500000, 8500000, 'members_only', false, 'One guest per member.', 2],
    ];
    const experience: Record<string, string> = {};
    for (const [key, title, category, summary, description, startsAt, venue, area, dress, host, programme, included, capacity, held, price, memberPrice, admission, hidden, guests, maxSeats] of experiences) {
      experience[key] = await one(
        `INSERT INTO experiences (market_id, title, category, summary, description, starts_at, timezone, venue_name, area, dress_code, host, programme, included, capacity, seats_held, price_minor, member_price_minor, currency_code, admission, is_hidden, guest_policy, max_seats_per_booking, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, 'ZAR', $18, $19, $20, $21, 'published') RETURNING id`,
        [market, title, category, summary, description, sampleDate(startsAt), ZONE, venue, area, dress, host, JSON.stringify(programme.map(([time, item]) => ({ time, title: item }))), JSON.stringify(included), capacity, held, price, memberPrice, admission, hidden, guests, maxSeats],
      );
    }
    // Guests see the experiences with open booking until staff choose otherwise.
    await tx.query(`UPDATE experiences SET open_to_guests = (admission = 'open') WHERE market_id = $1`, [market]);
    await tx.query('INSERT INTO experience_invitations (experience_id, member_id) VALUES ($1, $2)', [experience.invitational, member.thandi]);
    // One concierge request with options waiting, and one conversation, as in the mock.
    const desk = (await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = 'desk@example.com'`))[0]!.id;
    const request = await one(`INSERT INTO concierge_requests (member_id, market_id, category, subject, details, needed_by, status, created_at) VALUES ($1, $2, 'hospitality', 'Restaurant reservation', 'Table for six on Saturday evening, somewhere quiet enough to talk. One guest is vegetarian.', '2026-10-17', 'options_provided', '2026-10-04T13:00:00Z') RETURNING id`, [member.thandi, market]);
    await tx.query(`INSERT INTO concierge_messages (request_id, sender_user_id, from_desk, body, created_at) VALUES ($1, $2, true, 'Two options for 19:30: the private room at Saffron House, or a corner table at The Pot Luck Club. Which would you prefer?', '2026-10-04T13:10:00Z')`, [request, desk]);
    const [low, high] = member.thandi! < member.aisha! ? [member.thandi, member.aisha] : [member.aisha, member.thandi];
    const chat = await one(`INSERT INTO conversations (member_low, member_high, last_message_at) VALUES ($1, $2, '2026-10-04T08:40:00Z') RETURNING id`, [low, high]);
    await tx.query(`INSERT INTO messages (conversation_id, sender_member_id, body, created_at) VALUES ($1, $2, 'Loved the menu for Costa Convivio. Is the snoek course staying?', '2026-10-04T08:02:00Z'), ($1, $3, 'It is. And I have put you at my end of the table.', '2026-10-04T08:40:00Z')`, [chat, member.thandi, member.aisha]);
    await tx.query(`INSERT INTO conversation_reads (conversation_id, member_id, last_read_at) VALUES ($1, $2, '2026-10-04T08:02:00Z')`, [chat, member.thandi]);

    const booking = await one(`INSERT INTO experience_bookings (experience_id, member_id, seats, status, ticket_code) VALUES ($1, $2, 2, 'confirmed', 'QT-7F3K9A') RETURNING id`, [experience.costa, member.thandi]);
    await tx.query(
      `INSERT INTO notifications (user_id, category, title, link, read_at, created_at) VALUES
        ($1, 'experience_invitation', 'You are invited to the Quintara Golf Invitational.', $2::jsonb, NULL, '2026-10-05T06:10:00Z'),
        ($1, 'booking_confirmation', 'Your place at Costa Convivio is confirmed.', $3::jsonb, '2026-10-02T09:30:00Z', '2026-10-02T09:00:00Z'),
        ($1, 'message', 'Sipho Ndlovu would like to connect.', $4::jsonb, NULL, '2026-10-04T08:40:00Z')`,
      [user.thandi, JSON.stringify({ type: 'experience', id: experience.invitational }), JSON.stringify({ type: 'booking', id: booking }), JSON.stringify({ type: 'member', id: member.sipho })],
    );
    for (const [owner, kind, title, summary, sector, audience] of [
      ['sipho', 'capital', 'Series A for Ledgerline', 'Payments infrastructure for African merchants, live in three countries. Looking to meet investors who know fintech and long sales cycles.', 'Fintech', ['investor']],
      ['daniel', 'partnership', 'Hospitality founders worth backing', 'Helderberg Capital would like to meet founders building hospitality and consumer brands in the Cape, at any stage.', 'Hospitality', ['founder']],
      ['chloe', 'collaboration', 'Brands with a story worth filming', 'Longkloof Pictures is looking for two founders or executives a year whose company deserves a short documentary.', 'Film', ['founder', 'executive']],
    ] as const) {
      await tx.query(`INSERT INTO business_listings (market_id, member_id, kind, title, summary, sector, audience, status) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 'published')`, [market, member[owner], kind, title, summary, sector, [...audience]]);
    }
    // Lifestyle services that guests and members can ask to book.
    const SERVICES: [name: string, description: string][] = [
      ['Sun\u00e9 Photography', 'Professional photography for portraits, events and brands, with editing and retouching of every image. Sun\u00e9 Photography also creates user-generated content for social media that looks natural and personal. Tell us the occasion and the look you want, and the session is arranged for you.'],
      ['One&Only Yacht Charter', 'Private yacht charters for sunset cruises, celebrations and full days at sea. Each charter is arranged around your party: the vessel, the crew, the timing and the catering. Tell us the date, the number of guests and the occasion.'],
      ['Vellora Interiors', 'An interior design practice for homes, apartments and workspaces. From a single room to a full renovation, Vellora works through the concept, materials, furniture and finishing touches, and sees the project through to the finished space.'],
      ['Elite Motion', 'Luxury and performance cars to rent for a day, a weekend, a special occasion or a longer visit. Delivery and collection can be arranged on request. Tell us the dates and the kind of car you have in mind.'],
      ['Atelier Lunda', 'Personal branding and styling for how you present yourself, in person and online. Atelier Lunda advises on wardrobe, image and personal brand, for everyday wear, public appearances and the moments that matter.'],
      ['Apex Performance', 'A personal trainer, nutritionist and coach in one programme. Sessions are planned around your goals, whether strength, fitness, body composition or recovery, with nutrition guidance and ongoing coaching to keep you on track.'],
      ['The Culinary House', 'A private chef for your home or your event. Menus are designed with you around the occasion, your guests and any dietary needs, from an intimate dinner for two to a larger celebration, and cooked on the day where you are hosting.'],
      ['\u00c9clat Atelier', 'Beauty and make-up by professional artists for events, shoots, weddings and evenings out. Tell us the occasion, the look you would like and where you will be getting ready, and an appointment is arranged.'],
      ['Skye Health', 'IV drip therapy for hydration, recovery and wellbeing, given by qualified health professionals. Each appointment starts with a short consultation so that the drip suits you, and it is not given where it would not be safe.'],
      ['Alpha Management', 'A modelling agency representing talent for fashion, commercial and editorial work. Brands can book models for campaigns, shoots and events, and aspiring models can ask about representation.'],
      ['EliteReach Management', 'An elite agency for brand partnerships, marketing, promotions and user-generated content. EliteReach matches brands with the right creators and talent, and plans and runs campaigns from the first idea to the results.'],
      ['BMM Capital', 'Financial services, business advisory and investments. BMM Capital works with founders and businesses on strategy, structuring and funding. Any financial or investment advice comes from BMM Capital directly, not from Quintara. Mr. Wayne Huffton, Quintara\'s relationship manager, is with BMM Capital.'],
      ['TheFeed', 'News, promotions and adverts. TheFeed publishes stories and features, and places promotions and adverts for brands and businesses that want to reach its audience.'],
      ['Nava Studios', 'Photography and videography studios, with full production. Hire a studio for your own shoot, or have Nava Studios produce the whole project, from planning and crew to filming and editing.'],
      ['Novaderm Aesthetics', 'Skin, body and wellness treatments from an aesthetics clinic. Every treatment starts with a consultation, and what is recommended is chosen for your skin and your goals.'],
      ['Wonderland Cape Town', 'Wellness, a hotel, a sauna and co-working under one roof. Book a stay, a sauna session or a day at a desk, or combine them for a day that mixes work and rest.'],
      ['Virgin Active Country Club', 'A country club with a gym and wellness facilities. Quintara can arrange a visit, classes or sessions for you; facilities, access and membership terms are set by the club.'],
    ];
    const SERVICE_CATEGORY: Record<string, string> = { "Sun\u00e9 Photography": "Photography and Media", "One&Only Yacht Charter": "Mobility", "Vellora Interiors": "Home and Design", "Elite Motion": "Mobility", "Atelier Lunda": "Beauty and Style", "Apex Performance": "Wellness", "The Culinary House": "Dining", "\u00c9clat Atelier": "Beauty and Style", "Skye Health": "Wellness", "Alpha Management": "Talent and Brand", "EliteReach Management": "Talent and Brand", "BMM Capital": "Business", "TheFeed": "Photography and Media", "Nava Studios": "Photography and Media", "Novaderm Aesthetics": "Wellness", "Wonderland Cape Town": "Wellness", "Virgin Active Country Club": "Wellness" };
    const SERVICE_PACKAGES: Record<string, [name: string, description: string, priceMinor: number | null, basis: string, leadTimeHours: number, duration: string][]> = {"Sun\u00e9 Photography": [["Portrait session", "Portraits at a location of your choice, with a selection of edited images.", 350000, "per_session", 72, "2 hours"], ["Event coverage", "Photography of your event, edited and delivered as a private gallery.", 1200000, "per_booking", 168, "Up to 4 hours"], ["Content day", "A day creating natural, personal content for social media.", 650000, "per_day", 120, "Full day"]], "One&Only Yacht Charter": [["Sunset cruise", "A private yacht with crew for a sunset cruise.", 2500000, "per_booking", 72, "3 hours"], ["Full-day charter", "A private yacht for the day, with crew and catering arranged around your party.", null, "per_day", 168, "Full day"]], "Vellora Interiors": [["Design consultation", "A first visit to understand the space, how you live in it and what you would like.", 250000, "per_session", 120, "90 minutes"], ["Room design", "Concept, materials, furniture and finishing touches for one room.", null, "per_booking", 336, ""]], "Elite Motion": [["A day with a luxury car", "A luxury or performance car for the day.", 450000, "per_day", 48, "24 hours"], ["Weekend", "A luxury car from Friday to Sunday.", 1100000, "per_booking", 72, "Friday to Sunday"]], "Atelier Lunda": [["Style consultation", "Your wardrobe, image and personal brand, with clear recommendations.", 280000, "per_session", 72, "2 hours"], ["Wardrobe edit", "An edit of your wardrobe at home, with a list of what to keep, change and add.", 600000, "per_session", 168, "Half a day"]], "Apex Performance": [["Personal training session", "One session with a personal trainer.", 75000, "per_session", 24, "1 hour"], ["Four-week programme", "Training, nutrition guidance and coaching for four weeks.", 750000, "per_booking", 72, "4 weeks"]], "The Culinary House": [["Dinner for two", "A private chef cooks a dinner for two where you are hosting.", 480000, "per_booking", 120, "Evening"], ["Tasting menu", "A tasting menu cooked for your guests, designed with you.", 220000, "per_person", 120, "Evening"], ["Celebration", "A menu for a larger celebration, up to twenty guests.", null, "per_booking", 336, ""]], "\u00c9clat Atelier": [["Event make-up", "Make-up for an event or evening out, where you are getting ready.", 150000, "per_person", 48, "1 hour"], ["Bridal", "Bridal make-up with a trial beforehand.", null, "per_booking", 336, ""]], "Skye Health": [["Hydration drip", "An IV drip for hydration, after a short consultation.", 180000, "per_session", 24, "45 minutes"], ["Recovery drip", "An IV drip for recovery, after a short consultation.", 240000, "per_session", 24, "60 minutes"]], "Alpha Management": [["Model booking", "Models for a campaign, shoot or event.", null, "per_day", 168, ""]], "EliteReach Management": [["Brand partnership consultation", "A first meeting about your brand, your audience and the partnerships that would suit it.", 300000, "per_session", 120, "1 hour"], ["Creator campaign", "A campaign with matched creators, planned and run from idea to results.", null, "per_booking", 336, ""]], "BMM Capital": [["Introductory meeting", "A first meeting with BMM Capital about your business or what you are looking for.", null, "per_session", 72, "1 hour"]], "TheFeed": [["Promotion feature", "A feature or advert placed with TheFeed's audience.", null, "per_booking", 168, ""]], "Nava Studios": [["Studio hire", "A photography or videography studio for your own shoot.", 120000, "per_hour", 48, "Per hour"], ["Full production", "Planning, crew, filming and editing for your project.", null, "per_booking", 336, ""]], "Novaderm Aesthetics": [["Skin consultation", "A consultation to recommend treatments for your skin and your goals.", 90000, "per_session", 48, "45 minutes"], ["Signature facial", "A facial chosen for your skin.", 220000, "per_session", 72, "75 minutes"]], "Wonderland Cape Town": [["Sauna session", "A sauna session.", 45000, "per_person", 4, "90 minutes"], ["Work and wellness day", "A day at a desk with sauna access.", 65000, "per_day", 24, "Full day"], ["Overnight stay", "A night at Wonderland.", null, "per_booking", 48, "One night"]], "Virgin Active Country Club": [["Day visit", "A visit to the club's gym and wellness facilities, on the club's terms.", null, "per_person", 24, "Day"]]};
    for (const [index, [name, description]] of SERVICES.entries()) {
      const serviceId = await one(`INSERT INTO lifestyle_services (market_id, name, description, category, status, position, summary, area) VALUES ($1, $2, $3, $4, 'published', $5, $6, 'Cape Town') RETURNING id`, [market, name, description, SERVICE_CATEGORY[name] ?? 'Lifestyle', index, firstSentence(description)]);
      // Packages with indicative prices and notice periods. Prices are placeholders until the providers confirm them.
      for (const [position, [title, about, price, basis, lead, duration]] of (SERVICE_PACKAGES[name] ?? []).entries()) {
        await tx.query('INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [serviceId, title, about, price, basis, lead, duration, position]);
      }
    }
    // Opportunities from Quintara: members pursue them through the relationship manager.
    for (const [title, summary, sector, audience, daysAgo] of [
      ['Co-investment circle: boutique hospitality', 'Quintara is convening a small group of members to look at a boutique hospitality project on the Atlantic Seaboard. Ask your relationship manager for the briefing and to be introduced to the principals.', 'Hospitality', ['investor'], 1],
      ['Brand partners for the summer season', 'A small number of members\u2019 companies can partner with Quintara\u2019s summer experiences, from The Aura Enclave to House Feast. Tell your relationship manager what you have in mind.', 'Partnerships', [], 3],
      ['Advisers for early-stage founders', 'Several founder members are looking for an experienced adviser for the next twelve months. If you would consider a seat, your relationship manager can tell you more and make the introduction.', 'Advisory', ['executive', 'investor'], 5],
    ] as const) {
      await tx.query(`INSERT INTO business_updates (market_id, title, summary, sector, audience, status, updated_at) VALUES ($1, $2, $3, $4, $5::text[], 'published', now() - make_interval(days => $6))`, [market, title, summary, sector, [...audience], daysAgo]);
    }

    for (const [title, maker, category, description, price, memberPrice, membersOnly, options, stock] of [
      ['Longkloof print, edition of fifty', 'Longkloof Pictures', 'Limited editions', 'A still from the Cederberg film, signed and numbered.', 680000, null, true, ['Unframed', 'Framed in oak'], 2],
      ['Hand-stitched weekender', 'Atelier Ndaba', 'Accessories', 'Full-grain leather, brass hardware, made to order in Gardens.', 1450000, 1300000, false, ['Tan', 'Black'], null],
      ['Fynbos candle', 'Quintara', 'Home', 'Buchu, wild rosemary and salt air. Sixty hours.', 68000, null, false, [], 40],
      ['Silk scarf', 'Atelier Ndaba', 'Accessories', 'Hand-rolled edges, printed in Cape Town.', 320000, 280000, false, ['Atlantic', 'Protea'], 12],
    ] as const) {
      await tx.query(`INSERT INTO products (market_id, title, maker, category, description, price_minor, member_price_minor, members_only, currency_code, options, stock, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ZAR', $9::text[], $10, 'published')`, [market, title, maker, category, description, price, memberPrice, membersOnly, [...options], stock]);
    }
    await tx.query(`INSERT INTO delivery_options (market_id, name, description, fee_minor, free_over_minor, currency_code) VALUES
      ($1, 'Courier, South Africa', 'Two to four working days, signed for.', 15000, 500000, 'ZAR')`, [market]);

    // Sample series. The video address is a short public-domain clip standing in for real footage.
    const series = await one(`INSERT INTO tv_series (market_id, title, summary, status) VALUES ($1, 'The Long Table', 'One Quintara gathering per episode, from the first delivery to the last glass.', 'published') RETURNING id`, [market]);
    for (const [number, title, summary, seconds, audience] of [
      [1, 'First light at the market', 'Aisha chooses the snoek before the city is awake.', 1680, 'public'],
      [2, 'The long table is laid', 'Forty places, one terrace, and a wind that will not settle.', 2100, 'members'],
      [3, 'Until the light goes', 'The lunch itself, from the first glass to the last.', 2520, 'members'],
    ] as const) {
      await tx.query(`INSERT INTO tv_episodes (series_id, number, title, summary, duration_seconds, video_url, audience, status) VALUES ($1, $2, $3, $4, $5, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', $6, 'published')`, [series, number, title, summary, seconds, audience]);
    }
    await tx.query(`INSERT INTO tv_series (market_id, title, summary, status) VALUES ($1, 'Founders at Work', 'In production.', 'draft')`, [market]);

    const PARTNERS: [name: string, category: string, summary: string, area: string, privileges: [title: string, details: string, terms: string, uses: number, until: string | null][]][] = [
      ['Saffron House', 'Dining', 'Cape Malay cooking, told properly.', 'Bo-Kaap', [['A course from the kitchen', 'An extra course chosen by the chef with any dinner booking.', 'Dinner service only. Mention Quintara when booking.', 0, null]]],
      ['The Silo Spa', 'Wellness', 'A quiet floor above the harbour.', 'V&A Waterfront', [['A complimentary first treatment', 'One sixty-minute treatment of your choice.', 'Weekdays only. Book two days ahead.', 1, null], ['Winter thermal circuit', 'Use of the thermal circuit with any treatment.', 'Ended with the season.', 1, '2026-08-31']]],
      ['Atlantic Charter', 'Travel', 'Skippered yachts out of Granger Bay.', 'Granger Bay', [['Sunset upgrade', 'A two-hour charter extended to three.', 'Subject to weather and availability.', 2, null]]],
    ];
    for (const [name, category, summary, area, privileges] of PARTNERS) {
      const partner = await one(`INSERT INTO partners (market_id, name, category, summary, area, status) VALUES ($1, $2, $3, $4, $5, 'published') RETURNING id`, [market, name, category, summary, area]);
      for (const [title, details, terms, uses, until] of privileges) {
        await tx.query(`INSERT INTO privileges (partner_id, title, details, terms, uses_per_member, valid_until, status) VALUES ($1, $2, $3, $4, $5, $6, 'published')`, [partner, title, details, terms, uses, until]);
      }
    }
    await tx.query(`INSERT INTO partners (market_id, name, category, summary, status) VALUES ($1, 'Unannounced Gallery', 'Art', 'Opening in summer.', 'draft')`, [market]);
    // Placeholder directory details for the sample partners.
    await tx.query(`UPDATE partners SET offer = summary, contact_name = 'Guest relations', contact_email = lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) || '@example.com', contact_phone = '+27 21 555 0100', address = area || ', Cape Town' WHERE market_id = $1`, [market]);

    // A second city, open, with a little sample content of its own; and a third, closed, being prepared by staff.
    // All of it is placeholder content to be replaced by the Quintara team.
    const joburgCity = await one(`INSERT INTO cities (country_code, name, timezone) VALUES ('ZA', 'Johannesburg', $1) RETURNING id`, [ZONE]);
    const joburg = await one(`INSERT INTO markets (city_id, slug, name, currency_code, is_active, opened_at, position) VALUES ($1, 'johannesburg', 'Johannesburg', 'ZAR', true, now(), 1) RETURNING id`, [joburgCity]);
    await addDefaultPlans(tx, joburg, 'ZAR');
    const joburgTier = await one(`INSERT INTO membership_tiers (market_id, name, price_minor, currency_code) VALUES ($1, 'Member', 4800000, 'ZAR') RETURNING id`, [joburg]);
    for (const [key, name, email, position, company, industry, bio, interests, roles] of [
      ['kagiso', 'Kagiso Molefe', 'kagiso@example.com', 'Managing partner', 'Highveld Partners', 'Private equity', 'Backs founders building for the continent.', ['Golf', 'Investment', 'Dining'], ['member', 'investor']],
      ['lindiwe', 'Lindiwe Dube', 'lindiwe@example.com', 'Creative director', 'Studio Lindiwe', 'Fashion', 'Collections and campaigns from Maboneng.', ['Fashion', 'Art'], ['member', 'creative']],
    ] as const) {
      user[key] = await one(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [email]);
      await tx.query(`INSERT INTO profiles (user_id, full_name, position, company, industry, city, biography, interests) VALUES ($1, $2, $3, $4, $5, 'Johannesburg', $6, $7::text[])`, [user[key], name, position, company, industry, bio, [...interests]]);
      for (const role of roles) await tx.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2)', [user[key], role]);
      member[key] = await one(`INSERT INTO members (user_id, member_number, home_market_id, tier_id, joined_at) VALUES ($1, $2, $3, $4, '2026-08-01') RETURNING id`, [user[key], `Q-${number++}`, joburg, joburgTier]);
    }
    for (const [title, category, summary, startsAt, venue, area, capacity, price, admission, open] of [
      ['The Rooftop Supper', 'Fine dining', 'A long table above the city, and a chef cooking for thirty.', '2026-10-24T16:30:00Z', 'A private rooftop', 'Sandton', 30, 180000, 'members_only', false],
      ['Founders Breakfast', 'Networking', 'An early table for founders and the people who back them.', '2026-11-06T05:30:00Z', 'A private dining room', 'Rosebank', 24, 0, 'open', true],
    ] as const) {
      await tx.query(`INSERT INTO experiences (market_id, title, category, summary, description, starts_at, timezone, venue_name, area, dress_code, host, programme, included, capacity, seats_held, price_minor, member_price_minor, currency_code, admission, is_hidden, guest_policy, max_seats_per_booking, status, open_to_guests)
        VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'Smart', 'Quintara', '[]'::jsonb, '[]'::jsonb, $9, 0, $10, $10, 'ZAR', $11, false, 'One guest per member.', 2, 'published', $12)`, [joburg, title, category, summary, sampleDate(startsAt), ZONE, venue, area, capacity, price, admission, open]);
    }
    for (const [name, category, summary, area, privilege] of [
      ['Marula House', 'Dining', 'Seasonal Highveld cooking in a Parkhurst garden.', 'Parkhurst', 'A glass of something from the cellar with dinner'],
      ['Highveld Wellness Rooms', 'Wellness', 'Treatment rooms and a quiet pool.', 'Sandton', 'A complimentary first treatment'],
    ] as const) {
      const partner = await one(`INSERT INTO partners (market_id, name, category, summary, area, status, offer, contact_name, contact_email, contact_phone, address) VALUES ($1, $2, $3, $4, $5, 'published', $4, 'Guest relations', $6, '+27 11 555 0100', $7) RETURNING id`,
        [joburg, name, category, summary, area, `${name.toLowerCase().replace(/[^a-z]/g, '')}@example.com`, `${area}, Johannesburg`]);
      await tx.query(`INSERT INTO privileges (partner_id, title, details, terms, uses_per_member, status) VALUES ($1, $2, $2, 'Mention Quintara when booking.', 1, 'published')`, [partner, privilege]);
    }
    for (const [index, [name, category, description, pkg]] of ([
      ['BMM Capital', 'Business', 'Financial services, business advisory and investments. Any financial or investment advice comes from BMM Capital directly, not from Quintara.', 'A first conversation'],
      ['EliteReach Management', 'Talent and Brand', 'An elite agency for brand partnerships, marketing, promotions and user-generated content.', 'A brand partnership brief'],
    ] as const).entries()) {
      const serviceId = await one(`INSERT INTO lifestyle_services (market_id, name, description, category, status, position, summary, area) VALUES ($1, $2, $3, $4, 'published', $5, $6, 'Johannesburg') RETURNING id`, [joburg, name, description, category, index, firstSentence(description)]);
      await tx.query(`INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) VALUES ($1, $2, '', NULL, 'per_booking', 48, '', 0)`, [serviceId, pkg]);
    }
    await tx.query(`INSERT INTO products (market_id, title, maker, category, description, price_minor, currency_code, options, stock, status) VALUES ($1, 'Highveld candle', 'Quintara', 'Home', 'Wild sage and summer rain. Sixty hours.', 68000, 'ZAR', '{}', 30, 'published')`, [joburg]);
    await tx.query(`INSERT INTO delivery_options (market_id, name, description, fee_minor, free_over_minor, currency_code) VALUES ($1, 'Courier, South Africa', 'Two to four working days, signed for.', 15000, 500000, 'ZAR')`, [joburg]);
    const durbanCity = await one(`INSERT INTO cities (country_code, name, timezone) VALUES ('ZA', 'Durban', $1) RETURNING id`, [ZONE]);
    const durban = await one(`INSERT INTO markets (city_id, slug, name, currency_code, is_active, position) VALUES ($1, 'durban', 'Durban', 'ZAR', false, 2) RETURNING id`, [durbanCity]);
    await addDefaultPlans(tx, durban, 'ZAR');
    await tx.query(`INSERT INTO experiences (market_id, title, category, summary, description, starts_at, timezone, venue_name, area, capacity, price_minor, member_price_minor, currency_code, admission, status)
      VALUES ($1, 'Durban opening evening', 'Signature evenings', 'Quintara arrives on the coast.', 'Quintara arrives on the coast.', '2027-02-12T16:00:00Z', $2, 'To be announced', 'Umhlanga', 80, 0, 0, 'ZAR', 'members_only', 'draft')`, [durban, ZONE]);

    // Sample notifications are history: they must not be emailed when the server starts.
    await tx.query('DELETE FROM email_outbox');
  });
}
