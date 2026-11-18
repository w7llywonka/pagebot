// Fake data for /admin, shaped exactly like server.js's /api/admin/* responses (see the handlers from
// "// ---------- admin ----------" down). Everything is derived from one fixed clock and a seeded generator, so two runs
// give byte-identical JSON. Nothing here touches the network or the repository.
//
//   import { makeAdminApi, NOW, TOKEN } from './admin-fixtures.mjs';
//   const api = makeAdminApi({ empty: false });
//   const { status, body } = api.handle('GET', '/api/admin/users', searchParams, postData, headers);
//
// `empty: true` is a server on its first day: no accounts, no questions, no password set yet.

export const NOW = Date.parse('2026-11-18T19:42:00Z'); // Wednesday 12:42 pm in America/Denver
export const TOKEN = 'fixture-admin-token-0123456789';
export const TIMEZONE = 'America/Denver';
const H = 3600e3, D = 86400e3, MIN = 60e3;
const iso = ms => new Date(ms).toISOString();
const ago = ms => iso(NOW - ms);

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const MODELS = [{ label: 'Haiku 5.5', id: 'claude-haiku-5-5', openrouter: false }, { label: 'Sonnet 5.5', id: 'claude-sonnet-5-5', openrouter: false }];
const BAN_HOURS = [1, 24, 72, 168, 336, 720, 0];
const DEFAULTS = { limitKind: 'tokens', limitValue: 100000, allowSonnet: true, allowWeb: true, allowPdf: true, allowActions: true };

// ---- people ----
// [name, status, options]. `lvl` is how much they use it (questions a week, roughly); `today` is the share of today's limit used.
const PEOPLE = [
  // waiting to be accepted
  ['nora.k', 'pending', { note: 'Hi! It’s Nora from book club. Sam said I could try this out for the reading list.', joined: 2 * H }],
  ['tio_rafa', 'pending', { note: 'Soy Rafa, el tío de Maya. ¿Me dejas entrar? Gracias!', joined: 5 * H }],
  ['leo-2014', 'pending', { note: '', joined: 26 * H }],
  ['priya_s', 'pending', { note: 'Priya (Dev’s roommate). Mostly for reading papers for my thesis, I promise not to hammer it. Happy to chip in for costs if it gets expensive, just tell me what I owe at the end of the month.', joined: 2 * D + 3 * H }],
  ['jk_backup', 'pending', { note: 'its jake again, made a new one', joined: 3 * D, linked: ['jake_r'] }],
  // accepted
  ['maya', 'trusted', { adminNote: 'Maya (sister)', limit: null, lvl: 46, today: 0, todayTok: 61200, seen: 4 * MIN, joined: 212 * D, devices: 3, passcode: true, lockMinutes: 15, pdfs: [7, 18.4e6] }],
  ['grandpa_joe', 'trusted', { adminNote: 'Grandpa. Call him if it stops working', limit: ['tokens', 100000], lvl: 9, today: .12, seen: 3 * H, joined: 188 * D, devices: 1, sonnet: false, actions: false }],
  ['dev.patel', 'trusted', { adminNote: 'Dev from work', limit: ['usd', 0.5], lvl: 38, today: .86, seen: 11 * MIN, joined: 140 * D, devices: 2, passcode: true, lockMinutes: 60, pdfs: [3, 4.1e6] }],
  ['sam.w', 'trusted', { adminNote: 'Sam from class', limit: ['tokens', 100000], lvl: 31, today: 1, seen: 26 * MIN, joined: 133 * D, devices: 2 }],
  ['aunt_carol', 'trusted', { adminNote: '', limit: ['tokens', 100000], lvl: 6, today: .04, seen: 2 * D, joined: 120 * D, devices: 1, web: false }],
  ['owen_p', 'trusted', { adminNote: 'Owen (Maya’s kid, 15)', limit: ['tokens', 150000], lvl: 52, today: .55, seen: 40 * MIN, joined: 97 * D, devices: 2, restrict: 'owen' }],
  ['mei.lin', 'trusted', { adminNote: '', limit: ['tokens', 200000], lvl: 27, today: .31, seen: 5 * H, joined: 95 * D, devices: 1, restrict: 'mei' }],
  ['the_real_benjamin_okafor', 'trusted', { adminNote: 'Ben, neighbour at no. 14. Borrowed the ladder, still has it', limit: ['tokens', 100000], lvl: 14, today: .22, seen: 9 * H, joined: 80 * D, devices: 1 }],
  ['zoe', 'trusted', { adminNote: 'Zoë', limit: ['usd', 1], lvl: 22, today: .4, seen: 1 * D + 2 * H, joined: 77 * D, devices: 2, pdfs: [12, 61.7e6] }],
  ['hank', 'trusted', { adminNote: '', limit: ['tokens', 50000], lvl: 3, today: 0, seen: 12 * D, joined: 71 * D, devices: 0, sonnet: false, web: false, pdf: false, actions: false }],
  ['lucia.m', 'trusted', { adminNote: 'Lucía, Spanish study group', limit: ['tokens', 100000], lvl: 19, today: .63, seen: 55 * MIN, joined: 66 * D, devices: 1 }],
  ['coach_t', 'trusted', { adminNote: '', limit: ['tokens', 100000], lvl: 8, today: .08, seen: 4 * D, joined: 60 * D, devices: 1 }],
  ['ines', 'trusted', { adminNote: 'Inès (Paris)', limit: ['tokens', 100000], lvl: 12, today: .17, seen: 7 * H, joined: 51 * D, devices: 1, passcode: true, lockMinutes: 0 }],
  ['bookclub_ruth', 'trusted', { adminNote: 'Ruth, book club', limit: ['tokens', 100000], lvl: 5, today: 0, seen: 6 * D, joined: 44 * D, devices: 1, sonnet: false }],
  ['kofi', 'trusted', { adminNote: '', limit: ['usd', 0.25], lvl: 17, today: .93, seen: 2 * H, joined: 39 * D, devices: 1 }],
  ['amelia-rose', 'trusted', { adminNote: 'Amelia, Dev’s sister', limit: ['tokens', 100000], lvl: 11, today: .02, seen: 20 * H, joined: 33 * D, devices: 1 }],
  ['mr_whiskers', 'trusted', { adminNote: 'No idea who this is?? ask Maya', limit: ['tokens', 100000], lvl: 2, today: 0, seen: 21 * D, joined: 30 * D, devices: 0 }],
  ['yusuf', 'trusted', { adminNote: '', limit: ['tokens', 100000], lvl: 24, today: .47, seen: 90 * MIN, joined: 24 * D, devices: 2 }],
  ['pat', 'trusted', { adminNote: 'Pat next door', limit: ['tokens', 100000], lvl: 4, today: 0, seen: 58 * D, joined: 150 * D, devices: 0 }],
  ['theo', 'trusted', { adminNote: '', limit: ['tokens', 100000], lvl: 0, today: 0, seen: null, joined: 2 * D, devices: 0 }],
  ['dylan_m', 'trusted', { adminNote: 'Dylan (Owen’s friend)', limit: ['tokens', 100000], lvl: 40, today: 0, seen: 3 * H, joined: 41 * D, devices: 1, ban: 'dylan' }],
  ['tasha.b', 'trusted', { adminNote: '', limit: ['tokens', 100000], lvl: 15, today: 0, seen: 30 * H, joined: 88 * D, devices: 1, ban: 'tasha' }],
  ['crypto_kev', 'trusted', { adminNote: 'Friend of a friend', limit: ['tokens', 100000], lvl: 0, today: 0, seen: 9 * D, joined: 16 * D, devices: 0, ban: 'kev' }],
  ['jake_r', 'trusted', { adminNote: 'Jake, shared his login around school', limit: ['tokens', 100000], lvl: 0, today: 0, seen: 3 * D, joined: 70 * D, devices: 1, ban: 'jake' }],
  // blocked
  ['old_roommate', 'blocked', { adminNote: 'Moved out in June', limit: ['tokens', 100000], lvl: 0, today: 0, seen: 140 * D, joined: 300 * D, devices: 0 }],
  ['testaccount2', 'blocked', { adminNote: '', limit: ['tokens', 100000], lvl: 0, today: 0, seen: 75 * D, joined: 76 * D, devices: 0 }],
  ['marcus_h', 'blocked', { adminNote: 'Asked me to pause it while he’s away', limit: ['usd', 0.5], lvl: 0, today: 0, seen: 19 * D, joined: 101 * D, devices: 0 }],
];

function buildUsers() {
  const r = rng(11);
  const live = {
    dylan: { id: 31, kind: 'ban', state: 'active', hours: 72, reason: 'Spamming', note: 'You sent about 400 questions in an hour on Monday. Take a breather.', at: ago(26 * H), endsAt: iso(NOW - 26 * H + 72 * H), seenAt: ago(25 * H),
      appeal: { id: 5, body: 'I’m really sorry, I was seeing how fast it could go for a school project. It won’t happen again. Can I have it back before my essay is due Friday?', at: ago(20 * H), decision: null, decidedAt: null, reply: '' } },
    tasha: { id: 29, kind: 'ban', state: 'ended', hours: 24, reason: 'Breaking the rules', note: '', at: ago(30 * H), endsAt: ago(6 * H), seenAt: ago(29 * H), appeal: null },
    kev: { id: 27, kind: 'ban', state: 'active', hours: null, reason: 'Abusing pagebot', note: 'Using it to mass-produce spam comments.', at: ago(9 * D), endsAt: null, seenAt: null,
      appeal: { id: 3, body: 'this is ridiculous unban me', at: ago(8 * D), decision: 'denied', decidedAt: ago(8 * D - 2 * H), reply: 'No. This one stays.' } },
    jake: { id: 30, kind: 'terminate', state: 'terminated', hours: null, reason: 'Sharing your account', note: 'Your login was used from eleven different browsers in one week.', at: ago(3 * D), endsAt: iso(NOW + 11 * D), seenAt: ago(3 * D - H),
      appeal: { id: 6, body: 'It was only my lab group, I didn’t know that wasn’t allowed. Please don’t delete my saved chats.', at: ago(2 * D), decision: null, decidedAt: null, reply: '' } },
    owen: { id: 32, kind: 'restrict', state: 'restricted', hours: 168, reason: 'Using a lot of Sonnet', note: 'Haiku is plenty for homework. Back to normal next week.', at: ago(2 * D), endsAt: iso(NOW + 5 * D),
      limits: { noSonnet: true, noWeb: true } },
    mei: { id: 33, kind: 'restrict', state: 'restricted', hours: 24, reason: 'Breaking the rules', note: '', at: ago(7 * H), endsAt: iso(NOW + 17 * H), limits: { limitKind: 'tokens', limitValue: 20000 } },
  };
  let id = 2;
  const users = PEOPLE.map(([name, status, o]) => {
    id++;
    const lvl = o.lvl || 0, pending = status === 'pending';
    const perQ = 6200 + Math.round(r() * 3400), sonnetShare = o.sonnet === false ? 0 : .08 + r() * .3;
    const usdPerQ = perQ * (.1 + sonnetShare * 2.4) / 1e6 + .0004;
    const weekQ = Math.round(lvl * (.7 + r() * .6)), weeks = Math.max(1, (o.joined || D) / (7 * D));
    const totalQ = Math.round(weekQ * weeks * (.5 + r() * .4)) + (lvl ? Math.round(r() * 9) : 0);
    const lim = pending ? null : o.limit;
    const rst = o.restrict && live[o.restrict], effLim = rst?.limits?.limitKind ? [rst.limits.limitKind, rst.limits.limitValue] : lim;
    let todayTok = o.todayTok || 0, todayUsd = 0;
    if (effLim && o.today) { if (effLim[0] === 'usd') { todayUsd = effLim[1] * o.today; todayTok = Math.round(todayUsd / usdPerQ * perQ); } else { todayTok = Math.round(effLim[1] * o.today); todayUsd = todayTok / perQ * usdPerQ; } }
    else if (todayTok) todayUsd = todayTok / perQ * usdPerQ;
    const todayQ = Math.round(todayTok / perQ);
    const mk = (b, ban) => ({ ...b, name, userId: id, key: 'k'.repeat(32), liftedAt: null, reactivatedAt: null, deletedAt: null, ...(ban ? {} : { appeal: undefined }) });
    return {
      id, name, status, note: o.note || '', adminNote: o.adminNote || '',
      limitKind: lim ? lim[0] : null, limitValue: lim ? lim[1] : null,
      allowSonnet: o.sonnet !== false, allowWeb: o.web !== false, allowPdf: o.pdf !== false, allowActions: o.actions !== false,
      createdAt: ago(o.joined || D), approvedAt: pending ? null : ago(Math.max(0, (o.joined || D) - 5 * H)), lastSeen: o.seen == null ? (pending ? ago(o.joined) : null) : ago(o.seen),
      passcode: !!o.passcode, lockMinutes: o.lockMinutes ?? 15, annSeen: 0, banId: o.ban ? live[o.ban].id : null, restrictId: rst ? rst.id : null,
      devices: o.devices ?? (pending ? 1 : 0),
      ban: o.ban ? mk(live[o.ban], true) : null, restriction: rst ? mk(rst, false) : null, linked: o.linked || [],
      today: { tokens: todayTok, usd: todayUsd, questions: todayQ },
      week: { tokens: todayTok + weekQ * perQ, usd: todayUsd + weekQ * usdPerQ, questions: todayQ + weekQ },
      total: { tokens: todayTok + (weekQ + totalQ) * perQ, usd: todayUsd + (weekQ + totalQ) * usdPerQ, questions: todayQ + weekQ + totalQ },
      lastQuestion: lvl && o.seen != null ? ago(o.seen + 2 * MIN) : null, pdfs: { count: o.pdfs?.[0] || 0, bytes: o.pdfs?.[1] || 0 },
    };
  });
  // the moderation log: what's in force above, plus things that are over
  const byName = n => users.find(u => u.name === n);
  const past = [
    { id: 26, kind: 'ban', state: 'lifted', name: 'sam.w', userId: byName('sam.w').id, hours: 24, reason: 'Inappropriate content', note: 'Mixed you up with someone else. Sorry, Sam!', at: ago(15 * D), endsAt: ago(14 * D), seenAt: ago(15 * D - H), liftedAt: ago(15 * D - 3 * H), appeal: { id: 2, body: 'That wasn’t me?? I was at practice all evening.', at: ago(15 * D - 2 * H), decision: 'accepted', decidedAt: ago(15 * D - 3 * H), reply: 'You’re right, my mistake.' } },
    { id: 24, kind: 'ban', state: 'reactivated', name: 'tasha.b', userId: byName('tasha.b').id, hours: 1, reason: 'Spamming', note: '', at: ago(22 * D), endsAt: ago(22 * D - H), seenAt: ago(22 * D - 10 * MIN), reactivatedAt: ago(21 * D), appeal: null },
    { id: 22, kind: 'restrict', state: 'expired', name: 'kofi', userId: byName('kofi').id, hours: 72, reason: 'Using a lot of Sonnet', note: '', at: ago(34 * D), endsAt: ago(31 * D), limits: { noSonnet: true } },
    { id: 19, kind: 'terminate', state: 'deleted', name: 'spam_bot_77', userId: null, hours: null, reason: 'Abusing pagebot', note: 'Automated sign-up.', at: ago(60 * D), endsAt: ago(46 * D), seenAt: null, deletedAt: ago(46 * D), appeal: null },
  ].map(b => ({ key: 'k'.repeat(32), seenAt: null, liftedAt: null, reactivatedAt: null, deletedAt: null, note: '', ...b }));
  const liveBans = users.flatMap(u => [u.ban, u.restriction].filter(Boolean));
  const bans = [...liveBans, ...past].sort((a, b) => b.id - a.id);
  const appeals = liveBans.filter(b => b.appeal && !b.appeal.decision).map(b => ({ ...b.appeal, ban: b })).sort((a, b) => a.id - b.id);
  return { users, bans, appeals };
}

// ---- usage over time ----
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });
const dayKey = ms => DAY_FMT.format(new Date(ms));
const HOUR_NOW = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(NOW)));
function usageRow(q, r) {
  const input = Math.round(q * (6900 + r() * 1400)), output = Math.round(q * (430 + r() * 220));
  const share = .16 + r() * .14, sonnet = Math.round((input + output) * share);
  const sonnetUsd = sonnet * 2.6 / 1e6, haikuUsd = (input + output - sonnet) * .13 / 1e6, searches = Math.round(q * (.08 + r() * .08));
  return { input, output, questions: q, searches, sonnet, router: 0, usd: sonnetUsd + haikuUsd + searches * .01, sonnetUsd, routerUsd: 0 };
}
function usage(days, weight) {
  const r = rng(days * 7 + 3);
  if (days === 1) {
    const shape = [0, 0, 0, 0, 0, 0, 1, 3, 6, 9, 7, 8, 5, 6, 7, 9, 11, 8, 6, 9, 12, 8, 4, 1];
    return { timezone: TIMEZONE, by: 'hour', days: shape.map((s, hour) => ({ day: dayKey(NOW), hour, ...usageRow(hour > HOUR_NOW ? 0 : Math.round(s * weight * (.7 + r() * .6)), r) })) };
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = NOW - i * D, dow = new Date(t).getUTCDay(), wk = [.55, 1.1, 1.2, 1.15, 1.05, .9, .5][dow];
    const growth = .55 + .45 * (1 - i / Math.max(1, days)), spike = i === 9 ? 2.1 : 1, quiet = i === 17 ? 0 : 1;
    out.push({ day: dayKey(t), ...usageRow(Math.round(92 * wk * growth * spike * quiet * weight * (.75 + r() * .5) * (i === 0 ? .55 : 1)), r) });
  }
  return { timezone: TIMEZONE, by: 'day', days: out };
}

const SITES = ['en.wikipedia.org', 'docs.google.com', 'canvas.instructure.com', 'nytimes.com', 'youtube.com', null, 'github.com', 'reddit.com', 'arxiv.org', 'allrecipes.com', 'stackoverflow.com', 'a-very-long-subdomain.student-portal.university-of-somewhere.example.edu'];

// ---- the activity log ----
const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  cros: 'Mozilla/5.0 (X11; CrOS x86_64 16433.41.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};
// who (null = the owner), question, flags
const ASKS = [
  ['maya', 'Can you explain what this clause means in plain English? Is it normal for a lease?', { page: 1, highlight: 1, host: 'docs.google.com', title: 'Lease agreement – 41 Alder St (draft 3)', model: 's', out: 612 }],
  ['dev.patel', 'What are the key dates in this syllabus? Put them in a table.', { pdf: 'BIO-204 Cell Biology – syllabus, fall 2026 (final, updated).pdf', model: 'h', out: 388 }],
  ['owen_p', 'summarize this', { page: 1, host: 'en.wikipedia.org', title: 'Treaty of Versailles - Wikipedia', model: 'h', out: 240 }],
  [null, 'Compare the two phones on this page. Which has the better camera, and is the price difference worth it?', { page: 1, web: 3, host: 'gsmarena.com', title: 'Compare phones', model: 's', out: 904 }],
  ['grandpa_joe', 'What does this message mean and what should I click?', { image: 1, annotated: 1, host: 'mail.google.com', title: 'Inbox (3)', model: 'h', out: 171 }],
  ['sam.w', 'Fill in the shipping form with the address in my last message', { page: 1, acted: 1, host: 'shop.example.com', title: 'Checkout', model: 's', out: 96 }],
  ['lucia.m', '¿Puedes corregir este párrafo y explicarme los errores?', { highlight: 1, host: 'docs.google.com', title: 'Ensayo – borrador', model: 'h', out: 455 }],
  ['kofi', 'Write me a working keygen for this software', { page: 1, refused: 1, host: 'reddit.com', title: 'r/software', model: 'h', out: 64 }],
  ['zoe', 'Go through every section of this paper and give me a detailed critique of the methods, the statistics, and whether the conclusions follow. Be thorough, I have to present it on Thursday and my supervisor always asks about the power analysis.', { pdf: 'Nguyen et al 2025.pdf', stopped: 1, model: 's', out: 8000 }],
  ['yusuf', 'Is this recipe OK to make without eggs?', { page: 1, host: 'allrecipes.com', title: 'Best Banana Bread Recipe', model: 'h', out: 132 }],
  ['maya', '', { image: 1, host: 'nytimes.com', title: 'The Morning', model: 'h', out: 210 }],
  ['mei.lin', 'why is my flexbox not centering', { page: 1, highlight: 1, host: 'stackoverflow.com', title: 'css - Flexbox: center horizontally and vertically', model: 'h', out: 301 }],
  ['dev.patel', 'What changed in the latest release? Anything that breaks our build?', { page: 1, web: 2, fallback: 1, host: 'github.com', title: 'Releases · vitejs/vite', model: 'f', out: 540 }],
  ['amelia-rose', 'Who won the game last night?', { web: 1, model: 'h', out: 88 }],
  ['ines', 'Translate the highlighted part into English, keep the tone', { highlight: 1, host: 'lemonde.fr', title: 'Le Monde.fr - Actualités et Infos en France et dans le monde', model: 'h', out: 190 }],
  ['sam.w', 'quiz me on this chapter', { page: 1, host: 'canvas.instructure.com', title: 'Chapter 7: Cellular respiration', model: 'h', out: 420, removed: 1 }],
  ['the_real_benjamin_okafor', 'What’s a fair price for this used car?', { page: 1, web: 4, host: 'autotrader.com', title: '2019 Honda CR-V EX for sale', model: 's', out: 667 }],
  ['owen_p', 'explain like im 5', { page: 1, host: 'a-very-long-subdomain.student-portal.university-of-somewhere.example.edu', title: 'Unit 4 – Photosynthesis', model: 'h', out: 150 }],
  ['coach_t', 'Make a practice plan from this drill list', { page: 1, host: 'docs.google.com', title: 'U12 drills', noAnswer: 1 }],
  ['#deleted', 'test', { model: 'h', out: 12 }],
];
function buildActivity() {
  const r = rng(5), rows = [];
  let t = NOW - 6 * MIN, id = 48213;
  for (let i = 0; i < 64; i++) {
    const [who, question, f] = ASKS[i % ASKS.length], lap = Math.floor(i / ASKS.length);
    const fam = f.model === 's' ? 'sonnet' : f.model === 'f' ? 'sonnet' : 'haiku';
    const model = f.noAnswer ? null : f.model === 's' ? 'claude-sonnet-5-5' : f.model === 'f' ? 'claude-sonnet-5' : 'claude-haiku-5-5';
    const inTok = f.noAnswer ? 0 : Math.round((f.page ? 5200 : 300) + (f.pdf ? 21000 : 0) + (f.image ? 1500 : 0) + (f.web || 0) * 3000 + r() * 900);
    const out = f.noAnswer ? 0 : f.out, usd = !model ? 0 : fam === 'sonnet' ? (inTok * 2 + out * 10) / 1e6 + (f.web || 0) * .01 : (inTok * .1 + out * .5) / 1e6 + (f.web || 0) * .01;
    rows.push({
      id: id--, at: iso(t), who, question: lap ? question : question, page: !!f.page, highlight: !!f.highlight, image: !!f.image, annotated: !!f.annotated, pdf: f.pdf || null,
      url: f.host ? `https://${f.host}/some/page` : null, title: f.title || null, host: f.host || null, conversationId: 9100 - Math.floor(i / 2),
      model, modelLabel: !model ? null : model === 'claude-sonnet-5' ? 'Sonnet 5' : fam === 'sonnet' ? 'Sonnet 5.5' : 'Haiku 5.5', family: model ? fam : 'other',
      in: inTok, out, usd, searches: f.web || 0, refused: !!f.refused, stopped: !!f.stopped, fallback: !!f.fallback, answered: !!model, acted: !!f.acted, removed: !!f.removed,
    });
    t -= Math.round((4 + r() * 70) * MIN * (1 + lap));
  }
  return rows;
}
const ANSWERS = {
  default: 'Short version: **yes, it’s a normal clause**, but two parts are worth a second look.\n\n1. **“Joint and several liability”** means each of you can be asked for the *whole* rent if the other doesn’t pay, not just your half.\n2. **The 60-day notice** is longer than the usual 30. You can ask to change it; landlords often agree.\n\nEverything else here is standard: who fixes what, when rent is due, and how the deposit comes back.\n\nIf you want, paste the deposit section and I’ll check it against the rules for Colorado.',
};

// ---- the fake server ----
export function makeAdminApi({ empty = false } = {}) {
  const { users, bans, appeals } = empty ? { users: [], bans: [], appeals: [] } : buildUsers();
  const activity = empty ? [] : buildActivity();
  const name = id => users.find(u => u.id === id)?.name;
  const idOf = n => users.find(u => u.name === n)?.id;
  const userRef = who => who == null ? null : who === '#deleted' ? { id: 2, name: '(deleted account)' } : { id: idOf(who), name: who };
  const weights = () => { const tot = users.reduce((a, u) => a + u.week.questions, 0) + 34; return { owner: 34 / tot, of: id => (users.find(u => u.id === +id)?.week.questions || 0) / tot }; };
  const weightFor = who => empty ? 0 : who === 'all' ? 1 : who === 'owner' ? weights().owner : weights().of(who);
  const whoOf = q => q === 'owner' ? 'owner' : /^\d+$/.test(String(q || '')) ? String(q) : 'all';
  const sum = (rows, k) => rows.reduce((a, x) => a + x[k], 0);
  const month = usage(30, empty ? 0 : 1).days;
  const total = { tokens: empty ? 0 : 61_340_000, usd: empty ? 0 : 27.84, questions: empty ? 0 : 7412 };
  const owner = empty
    ? { today: { tokens: 0, usd: 0, questions: 0 }, week: { tokens: 0, usd: 0, questions: 0 }, total: { tokens: 0, usd: 0, questions: 0 }, devices: 0, lastSeen: null, lastQuestion: null, pdfs: { count: 0, bytes: 0 } }
    : { today: { tokens: 48200, usd: 0.0431, questions: 6 }, week: { tokens: 262400, usd: 0.3312, questions: 34 }, total: { tokens: 9_870_000, usd: 6.42, questions: 1288 }, devices: 3, lastSeen: ago(2 * MIN), lastQuestion: ago(6 * MIN), pdfs: { count: 4, bytes: 9.3e6 } };
  const sessions = empty ? [] : [
    [null, UA.macChrome, '73.14.201.8', 9 * D, 2 * MIN, true], [null, UA.iosSafari, '2601:281:c200:4f3a:8d1e:77ff:fe2b:19ac', 31 * D, 5 * H, false], [null, UA.winEdge, '73.14.201.8', 3 * D, 26 * H, false],
    ['maya', UA.macSafari, '98.43.77.120', 20 * D, 4 * MIN, true], ['maya', UA.iosSafari, '172.58.63.201', 12 * D, 9 * H, true], ['maya', UA.winChrome, '98.43.77.120', 40 * D, 6 * D, true],
    ['dev.patel', UA.linuxFirefox, '203.0.113.77', 6 * D, 11 * MIN, true], ['dev.patel', UA.android, '2a02:c7c:5a1b:9e00:10f3:b2ff:fe77:0c41', 2 * D, 3 * H, true],
    ['sam.w', UA.cros, '198.51.100.23', 15 * D, 26 * MIN, true], ['sam.w', UA.winChrome, '198.51.100.23', 50 * D, 33 * D, false],
    ['owen_p', UA.cros, '98.43.77.120', 8 * D, 40 * MIN, true], ['owen_p', UA.android, '172.58.61.14', 4 * D, 7 * H, true],
    ['grandpa_joe', UA.winEdge, '24.9.118.52', 60 * D, 3 * H, true], ['lucia.m', UA.macChrome, '189.203.44.9', 22 * D, 55 * MIN, true],
    ['yusuf', UA.winChrome, '86.12.240.3', 5 * D, 90 * MIN, true], ['yusuf', UA.iosSafari, '86.12.240.3', 5 * D, 2 * D, true],
    ['dylan_m', UA.cros, '98.43.80.2', 10 * D, 3 * H, true], ['jake_r', UA.winChrome, '71.218.9.140', 3 * D, 3 * D, true], ['nora.k', UA.macSafari, '67.190.12.88', 2 * H, 2 * H, true], [null, null, null, 70 * D, 44 * D, false],
  ].map(([who, ua, ip, created, used, active], i) => ({
    id: (i + 1).toString(16).padStart(2, '0').repeat(32), user: who ? { id: idOf(who), name: who, status: users.find(u => u.name === who).status } : null,
    createdAt: ago(created), lastUsed: ago(used), ip, ua, endsAt: iso(NOW - used + (active ? 30 * D : 0)), active,
  }));
  const stats = () => ({
    total: total.tokens, input: Math.round(total.tokens * .93), output: Math.round(total.tokens * .07), today: empty ? 0 : month.at(-1).input + month.at(-1).output,
    week: empty ? 0 : month.slice(-7).reduce((a, d) => a + d.input + d.output, 0), questions: total.questions, questions_today: empty ? 0 : month.at(-1).questions,
    searches: empty ? 0 : 903, total_usd: total.usd, today_usd: empty ? 0 : month.at(-1).usd, week_usd: empty ? 0 : sum(month.slice(-7), 'usd'),
    sessions: sessions.length, budget: 200_000_000, effort: 'low', models: MODELS, passwordSet: !empty,
    limits: { maxTokens: 100000, pageTokens: 5000, maxSearches: 3 }, limitRanges: { maxTokens: [256, 100000], pageTokens: [500, 50000], maxSearches: [1, 10] },
    lock: { on: !empty, minutes: 15, fails: empty ? 0 : 2, maxFails: 10, choices: [0, 1, 5, 15, 30, 60, 240, 1440] },
  });
  const overview = (days, who) => {
    const w = weightFor(who), u = usage(days, w).days, r = rng(days + 41);
    const q = sum(u, 'questions'), input = sum(u, 'input'), output = sum(u, 'output'), usd = sum(u, 'usd'), searches = sum(u, 'searches');
    const sonnetTok = sum(u, 'sonnet'), sonnetUsd = sum(u, 'sonnetUsd'), sq = Math.round(q * .21), fq = q ? Math.max(1, Math.round(q * .004)) : 0;
    const active = users.filter(x => x.status !== 'pending' && x.week.questions);
    const one = who === 'owner' ? [{ user: null, w: 1 }] : active.filter(x => String(x.id) === who).map(x => ({ user: { id: x.id, name: x.name }, w: 1 }));
    const ppl = !q ? [] : who !== 'all' ? one : [{ user: null, w: 34 }, ...active.map(x => ({ user: { id: x.id, name: x.name }, w: x.week.questions }))].sort((a, b) => b.w - a.w).slice(0, 10);
    const wsum = ppl.reduce((a, p) => a + p.w, 0) || 1;
    const heat = [];
    for (let dow = 1; dow <= 7; dow++) for (let h = 6; h < 24; h++) {
      const base = [0, 0, 0, 0, 0, 0, 1, 2, 5, 8, 6, 7, 4, 5, 6, 8, 10, 7, 5, 8, 11, 7, 3, 1][h] * (dow >= 6 ? .5 : 1) * (dow === 2 && h === 20 ? 1.9 : 1);
      const n = Math.round(base * q / 560 * (.6 + r() * .8)); if (n) heat.push([dow, h, n]);
    }
    return {
      days, timezone: TIMEZONE,
      totals: { questions: q, input, output, tokens: input + output, usd, searches, people: who === 'all' ? Math.min(active.length + 1, q) : q ? 1 : 0, chats: Math.round(q / 2.6),
        pages: Math.round(q * .71), highlights: Math.round(q * .18), images: Math.round(q * .09), web: Math.round(searches * .6), refused: Math.round(q * .003), stopped: Math.round(q * .008), fallbacks: fq },
      before: { questions: Math.round(q * .84), tokens: Math.round((input + output) * .81), usd: usd * .77, people: who === 'all' ? Math.max(0, active.length - 2) : q ? 1 : 0 },
      models: !q ? [] : [
        { model: 'claude-haiku-5-5', label: 'Haiku 5.5', family: 'haiku', questions: q - sq - fq, input: Math.round((input + output - sonnetTok) * .93), output: Math.round((input + output - sonnetTok) * .07), usd: usd - sonnetUsd - searches * .01, searches: Math.round(searches * .4) },
        { model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', questions: sq, input: Math.round(sonnetTok * .9), output: Math.round(sonnetTok * .08), usd: sonnetUsd * .97 + searches * .01, searches: Math.round(searches * .6) },
        { model: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet', questions: fq, input: Math.round(sonnetTok * .018), output: Math.round(sonnetTok * .002), usd: sonnetUsd * .03, searches: 0 },
      ],
      people: ppl.map((p, i) => ({ user: p.user, questions: Math.round(q * p.w / wsum * .92), tokens: Math.round((input + output) * p.w / wsum * .92), usd: usd * p.w / wsum * (i % 3 === 0 ? 1.25 : .8), last: ago((i * i * 17 + 2) * MIN) })).sort((a, b) => b.usd - a.usd),
      sites: !q ? [] : SITES.map((host, i) => { const f = [.19, .14, .11, .09, .08, .07, .06, .05, .04, .03, .02, .01][i]; return { host, questions: Math.max(1, Math.round(q * f)), people: who === 'all' ? Math.max(1, 12 - i) : 1, tokens: Math.round((input + output) * f), usd: usd * f }; }),
      heat,
    };
  };
  const filterActivity = p => {
    const who = whoOf(p.get('user')), model = p.get('model') || '', flag = p.get('flag') || '', q = (p.get('q') || '').toLowerCase(), days = +(p.get('days') || 30), before = +(p.get('before') || 0);
    return activity.filter(r => (who === 'all' || (who === 'owner' ? r.who == null : idOf(r.who) === +who))
      && (!model || r.family === model) && (!flag || r[{ stopped: 'stopped', refused: 'refused', fallback: 'fallback', web: 'searches' }[flag] || flag])
      && (!q || (r.question + ' ' + (r.host || '')).toLowerCase().includes(q)) && Date.parse(r.at) >= NOW - days * D && (!before || r.id < before));
  };
  const publicRow = ({ who, ...r }) => ({ ...r, user: userRef(who) });
  const detail = id => {
    const r = activity.find(x => x.id === id); if (!r) return null;
    const i = activity.indexOf(r);
    return {
      id: r.id, at: r.at, user: userRef(r.who), conversationId: r.conversationId, turn: { n: 2 - (i % 2), total: 2 + (i % 3) }, question: r.question,
      page: r.page ? { url: r.url, title: r.title, chars: 18240 + i * 311 } : null,
      highlight: r.highlight ? 'Tenant and any co-tenant shall be jointly and severally liable for all obligations under this Agreement, including Rent, and either party may terminate with no less than sixty (60) days’ written notice.' : null,
      image: r.image, annotated: r.annotated, pdf: r.pdf ? { name: r.pdf, size: 2_480_000, pages: 14, stored: i % 3 !== 2 } : null,
      answer: r.answered ? (r.refused ? 'I can’t help with getting around software licensing. If the price is the problem, I can look for a free alternative or a student discount.' : ANSWERS.default) : null,
      model: r.model, modelLabel: r.modelLabel, family: r.family, in: r.in, out: r.out, usd: r.usd, searches: r.searches, refused: r.refused, stopped: r.stopped, fallback: r.fallback,
      steps: r.acted ? [{ tool: 'find', text: 'Looked for the shipping form', outcome: 'done' }, { tool: 'type', text: 'Typed “41 Alder St” into Address line 1', outcome: 'done' }, { tool: 'click', text: 'Clicked “Place order”', outcome: 'denied' }, { tool: 'type', text: 'Typed the postcode into ZIP', outcome: 'failed' }] : null,
    };
  };
  const announcement = empty ? null : { id: 4, body: 'Heads up: I’m moving pagebot to a new server on Saturday morning, so it’ll be down for about an hour from 9.\n\nIf something looks broken after that, text me. — Sam', createdAt: ago(2 * D + 3 * H) };
  const json = (body, status = 200) => ({ status, body });

  // method, pathname, URLSearchParams, parsed JSON body (or null), request headers (lower-case keys)
  function handle(method, pathname, params = new URLSearchParams(), post = null, headers = {}) {
    if (!pathname.startsWith('/api/admin/')) return null;
    if (headers['x-admin-token'] !== TOKEN) return json({ error: 'Wrong admin token' }, 401);
    const p = pathname.slice('/api/admin/'.length), days = Math.max(1, Math.min(3650, +(params.get('days') || 30)));
    if (method === 'GET') {
      if (p === 'stats') return json(stats());
      if (p === 'users') return json({ bans, banHours: BAN_HOURS, terminateDays: 14, appeals, signup: true, defaults: DEFAULTS, ranges: { tokens: [1000, 100000000], usd: [0.01, 1000] }, timezone: TIMEZONE, owner, pdfCap: 104857600, users });
      if (p === 'usage') return json(usage(Math.min(365, days), weightFor(whoOf(params.get('user')))));
      if (p === 'overview') return json(overview(Math.min(365, days), whoOf(params.get('user'))));
      if (p === 'activity') { const n = Math.max(1, Math.min(200, +(params.get('limit') || 50))), rows = filterActivity(params); return json({ more: rows.length > n, rows: rows.slice(0, n).map(publicRow) }); }
      if (/^activity\/\d+$/.test(p)) { const d = detail(+p.split('/')[1]); return d ? json(d) : json({ error: 'Not found.' }, 404); }
      if (p === 'sessions') return json({ sessionDays: 30, ownerIdleMinutes: empty ? 0 : 15, sessions });
      if (p === 'security') return json(empty
        ? { failsLastHour: 0, addressCount: 0, addresses: [], perAddress: 30, ownerFails: 0, ownerPauseAt: 200, ownerPaused: false, passcode: { on: false, fails: 0, max: 10, locked: false }, adminFails: 0 }
        : { failsLastHour: 37, addressCount: 3, addresses: [{ ip: '45.155.205.233', fails: 30, blocked: true, last: ago(4 * MIN) }, { ip: '2a02:c7c:5a1b:9e00:10f3:b2ff:fe77:0c41', fails: 5, blocked: false, last: ago(38 * MIN) }, { ip: '98.43.77.120', fails: 2, blocked: false, last: ago(51 * MIN) }],
          perAddress: 30, ownerFails: 4, ownerPauseAt: 200, ownerPaused: false, passcode: { on: true, fails: 2, max: 10, locked: false }, adminFails: 1 });
      if (p === 'announcement') return json({ announcement, people: users.filter(u => u.status === 'trusted').length, seen: announcement ? 9 : 0, max: 500 });
    }
    // writes answer the way the server would, without changing the fixture (the shots only read)
    if (method === 'POST' && p === 'check') return json({ ok: true, passwordSet: !empty });
    if (method === 'POST' && p === 'signout-all') return json({ ok: true, signedOut: sessions.length });
    if (method === 'POST' && p === 'password') return json({ ok: true, signedOut: sessions.filter(s => !s.user).length });
    if (method === 'POST' && p === 'limits') return json({ ok: true, limits: { ...stats().limits, ...Object.fromEntries(Object.entries(post || {}).map(([k, v]) => [k, +v])) } });
    if (method === 'POST' && p === 'passcode') return json({ ok: true, on: !empty, minutes: +(post?.lockMinutes ?? 15) });
    if (method === 'POST' && p === 'accounts') return json({ ok: true, signup: post?.signup ?? true, defaults: { ...DEFAULTS, ...(post?.defaults || {}) } });
    if (method === 'POST' || method === 'DELETE') return json({ ok: true });
    return json({ error: 'Not found.' }, 404);
  }
  return { handle, users, bans, appeals, activity, sessions, name };
}
