// The systems most houses have, as a starting list for the owner, and a made-up house for the sample mode; and how an
// import file goes over the pages already here.
import { fillIn, refusal } from './kit/ledger.js';
import { lines, dayText } from './kit/ui.js';
export const KINDS = [
  ['water', 'Water'], ['power', 'Power'], ['heat', 'Heating and cooling'], ['safety', 'Safety'], ['appliance', 'Appliances'], ['other', 'Everything else'],
];

export const STARTER = [
  ['water-shutoff', 'Main water shutoff', 'water', true],
  ['water-heater', 'Water heater', 'water'],
  ['well-tank', 'Well pressure tank', 'water'],
  ['septic', 'Septic system', 'water'],
  ['panel-main', 'Main electrical panel', 'power', true],
  ['panel-sub', 'Electrical subpanel', 'power'],
  ['air-handler-up', 'Air handler, upstairs', 'heat'],
  ['air-handler-down', 'Air handler, downstairs', 'heat'],
  ['outdoor-units', 'Heat pump outdoor units', 'heat'],
  ['baseboard', 'Baseboard heaters', 'heat'],
  ['smoke-co', 'Smoke and CO alarms', 'safety', true],
  ['extinguisher', 'Fire extinguisher', 'safety'],
  ['range', 'Range and oven', 'appliance'],
  ['fridge', 'Refrigerator', 'appliance'],
  ['dishwasher', 'Dishwasher', 'appliance'],
  ['washer', 'Washer', 'appliance'],
  ['dryer', 'Dryer', 'appliance'],
  ['trash', 'Trash and recycling', 'other'],
].map(([id, name, kind, emergency], i) => ({ id, name, kind, emergency: !!emergency, order: i + 1 }));

// "Label: value" lines to [[label, value], …] and back. The label ends at the first colon with a space after it, or one
// with no space that isn't a link's :// or a time's digit:digit ("Model:XE50T10", "Breakers:21 and 23"), so a link
// ("https://…/valve.pdf") or a time ("Pumped 10:30 am") on a line of its own stays one value.
export function parseFacts(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = /^(.+?):(?: |(?!\/\/)(?!(?<=\d:)\d))/.exec(l);
    return m ? [m[1].trim(), l.slice(m[0].length).trim()] : ['', l];
  });
}
export const factsText = facts => (facts || []).map(([k, v]) => (k ? `${k}: ${v}` : v)).join('\n');
// The number a Call or Text button dials: the first one written, without an extension ("800-555-0100 ext. 12",
// "… x12", "…, ext 12"), a second number ("… or …", "… / …", "… & …", "… and …") or a note in brackets ("… (after
// 6 pm …)"); a bracketed area code ("(800) 555-0100") stays. The button still shows all of it.
export const dial = phone => String(phone || '').split(/\s*(?:\bext\b\.?|\bx\s*\d|,|;|\/|&|\((?!\d{3}\))|\bor\b|\band\b)/i)[0].replace(/[^\d+]/g, '');
export { lines };   // the kit's: one entry per line, typed numbering and bullets taken off

// Text with its links and phone numbers marked, for a page to make them tappable: [{ text }, { text, href }, …].
// A phone number is 3-3-4 digits (dashes, dots or spaces between, the area code may be in brackets) or 3-4 with a dash
// ("555-0142"), on its own: never part of a longer run of digits or letters, so a model number, a serial, a filter
// size ("16 × 25 × 1"), a decimal ("750.1234 ft") or a year stays text. The short form is never followed by a unit, so a
// range ("120-1500 W", "303-1100 lb") does too; "A/C" after a number isn't amps. Only https links, without the full stop
// or bracket after them.
const LINK = /https:\/\/[^\s<>"]+|(?<![\w+.\-/])(?:\+?1[ .-])?(?:(?:\(\d{3}\) ?|\d{3}[ .-])\d{3}[ .-]\d{4}|\d{3}-\d{4}(?!\s?(?:k?W|V|A|lbs?|ft|gal|psi|mm|cm|kg|g|oz|cfm|BTU|°|%)(?![A-Za-z/])))(?![\w-]|[.,]\d)/g;
export function splitLinks(text) {
  const out = [], s = String(text ?? '');
  let at = 0;
  for (const m of s.matchAll(LINK)) {
    let t = m[0];
    if (t.startsWith('https')) t = t.replace(/[.,;:!?)\]'"]+$/, '');
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ text: t, href: t.startsWith('https') ? t : 'tel:' + dial(t) });
    at = m.index + t.length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

// A page's photo: a file in the repo's photos folder, by its name ('water-shutoff.jpg', with a 'photos/' typed before it
// taken off). '' for none, null for something that can't be one (a link, a path, another kind of file), so a page only
// ever shows a picture from this site, which a tenant's phone keeps for a tap with no signal.
const PHOTO = /^[a-z0-9][a-z0-9._-]{0,79}\.(?:jpe?g|png|webp)$/i;
export function photoName(v) {
  const s = String(v ?? '').trim().replace(/^\.?\/?photos\//i, '');
  return !s ? '' : PHOTO.test(s) && !s.includes('..') ? s : null;
}

// ---- a page's regular job: what it is (task), every N months (every) and when it was last done (lastDone)
// A day as stored (YYYY-MM-DD, a real day of a four-digit year from 1000), or ''.
export function isoDay(v) {
  const m = /^([12]\d{3})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return '';
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() ? m[0] : '';
}
// Every N months: a whole number from 1 to 120, as a number or as digits typed into the sheet ('3'); 0 for anything else.
export function everyOf(v) {
  const n = typeof v === 'number' ? v : /^\s*\d+(?:\.0*)?\s*$/.test(String(v ?? '')) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : 0;
}
// When the job is next due: Last done plus every N months, the day kept or the month's last day (Aug 31 and 6 months is
// Feb 28), as YYYY-MM-DD; '' without both. dispatch/placard_slip.py works it out the same way.
export function nextDue(p) {
  const n = everyOf(p?.every), d = isoDay(p?.lastDone);
  if (!n || !d) return '';
  const [y, m, day] = d.split('-').map(Number), k = m - 1 + n, Y = y + Math.floor(k / 12), M = k % 12 + 1;
  const end = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  return `${Y}-${String(M).padStart(2, '0')}-${String(Math.min(day, end)).padStart(2, '0')}`;
}
// Due on that day or after it (today: YYYY-MM-DD).
export const isDue = (p, today) => { const d = nextDue(p); return !!d && d <= today; };
// 'Filter change' as it reads in a sentence: 'filter change' ('HVAC service' stays as it is).
export const job = t => { const s = String(t ?? '').trim().replace(/\s+/g, ' '); return s.length > 1 && /\p{Ll}/u.test(s[1]) ? s[0].toLowerCase() + s.slice(1) : s; };
// What a tenant reads under Looking after it: 'Last filter change: Nov 3, 2026. Every 3 months.', 'Last done: Nov 3,
// 2026.', 'Filter change every 3 months.'; '' when the page has neither date nor months.
export function doneText(p) {
  const n = everyOf(p?.every), d = isoDay(p?.lastDone), t = String(p?.task ?? '').trim().replace(/\s+/g, ' ');
  const months = n === 1 ? 'month' : `${n} months`;
  if (d) return `Last ${t ? job(t) : 'done'}: ${dayText(d)}.${n ? ` Every ${months}.` : ''}`;
  return !n ? '' : t ? `${t} every ${months}.` : `Every ${months}.`;
}

// ---- the Reports screen
// How to answer a report: a phone number in its contact (Call and Text dial it, as the contact card's do) and an email
// address. A contact that's only a number however it's typed ("5550101", "+1 845 555 0101") counts as a phone too.
const EMAIL = /[^\s@<>(),;:"']+@[^\s@<>(),;:"']+\.[a-z]{2,}/i;
export function reachBy(contact) {
  const s = String(contact || '').trim(), email = (EMAIL.exec(s) || [''])[0];
  const marked = splitLinks(email ? s.replace(email, ' ') : s).find(p => p.href?.startsWith('tel:'));
  const bare = /^[+\d\s().-]+$/.test(s) && (s.match(/\d/g) || []).length >= 7 ? dial(s) : '';
  return { tel: marked ? marked.href.slice(4) : bare, email };
}

// Reports as the screen's cards: the same words from the same page on the same day (Send pressed again, or a repeat the
// ledger kept without emailing) are one card, its reports oldest first; the cards newest first (one with no time last).
// A card is handled when every report in it is. The same words after a card was marked handled are a new problem (the ledger
// emailed them as new): a card of their own, which any more join, and which stays its own once handled (the Mark handled
// button gives every report in a card the same handledAt). A repeat the ledger kept just after midnight joins the card it
// repeats.
const words = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const dayOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const when = r => { const t = Date.parse(r.at); return Number.isFinite(t) ? t : -Infinity; };   // no time: last
export function groupReports(reports) {
  const cards = [], open = new Map();   // page and words -> the card a new report of them joins
  for (const r of [...reports].sort((a, b) => when(a) - when(b))) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) { cards.push([r]); continue; }
    const key = [r.system || '', words(r.text)].join('\n'), card = open.get(key);
    const last = card?.at(-1), together = last && (last.status !== 'handled' || (r.status === 'handled' && r.handledAt === last.handledAt));
    if (together && (r.repeat || dayOf(Date.parse(card[0].at)) === dayOf(at))) card.push(r);
    else { cards.push([r]); open.set(key, cards.at(-1)); }
  }
  return cards.map(reps => ({ reports: reps, first: reps[0], last: reps.at(-1), handled: reps.every(r => r.status === 'handled') }))
    .sort((a, b) => when(b.last) - when(a.last));
}
// '2:19 am', and a span of times in a day: '2:19-2:31 am', '11:58 am-12:10 pm'.
export const clock = ms => { const d = new Date(ms); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`; };
export function timeSpan(a, b) {
  const [x, y] = [clock(a), clock(b)];
  if (x === y) return x;
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}-${y}` : `${x}-${y}`;
}

export const SAMPLE = {
  'placard.site': [
    { id: 'house', title: 'House manual', intro: 'Tap any sticker in the house for what that thing is and what to do about it. In an emergency, start here.',
      contact: { name: 'Riverbend Property Care', phone: '555-0142', email: 'help@example.com', note: 'Call any time for a leak, no heat or no power. Text for anything else.' },
      notes: 'Trash goes out Monday night; recycling every other Thursday.' },
    { id: 'water-shutoff', name: 'Main water shutoff', kind: 'water', emergency: true, order: 1, where: 'Basement, left of the pressure tank, at waist height.', photo: 'sample-shutoff.jpg',
      summary: 'Turns off water to the whole house. Use it for any leak you can\'t stop at the fixture.',
      steps: 'Turn the red lever a quarter turn, so it sits across the pipe.\nOpen the lowest faucet in the house to drain the pipes.\nCall the number below.',
      facts: [['Valve', '1" ball valve'], ['Also', 'The well pump has its own breaker, number 14']], warn: 'Turn the water heater off at the panel if the water will be off for more than a day.' },
    { id: 'water-heater', name: 'Water heater', kind: 'water', order: 2, where: 'Basement, beside the furnace room door.',
      summary: 'Electric, 50 gallons. No pilot light.', steps: 'No hot water: check breaker 21 and 23 in the main panel.\nStill none after an hour: call.',
      facts: [['Make', 'Rheem'], ['Model', 'XE50T10'], ['Installed', '2020'], ['Breakers', '21 and 23']], care: 'Flushed once a year by the property manager.' },
    { id: 'panel-main', name: 'Main electrical panel', kind: 'power', emergency: true, order: 3, where: 'Garage, back wall.',
      summary: 'Every circuit in the house, with a map inside the door.', steps: 'A tripped breaker sits in the middle. Push it fully off, then on.\nIf it trips again straight away, leave it off and call.',
      facts: [['Size', '200 A'], ['Map', 'Inside the door']] },
    { id: 'air-handler-up', name: 'Air handler, upstairs', kind: 'heat', order: 4, where: 'Attic hatch in the hall closet.',
      summary: 'Heats and cools the upstairs.', facts: [['Filter', '16 × 25 × 1']], care: 'Spare filters are on the shelf beside it.', task: 'Filter change', every: 3, lastDone: '2026-08-02' },
    { id: 'smoke-co', name: 'Smoke and CO alarms', kind: 'safety', emergency: true, order: 5, where: 'Every bedroom, both hallways, the basement.',
      summary: 'Wired together: when one sounds, they all do.', steps: 'Burnt toast: press the button on the alarm that sounded to quiet it, and open a window.\nA chirp every minute is a low battery: tell us and we will replace it.' },
  ],
  'placard.reports': [
    { id: 'r1', system: 'water-heater', systemName: 'Water heater', kind: 'Problem', name: 'Sam', contact: '555-0101', text: 'Small drip from the valve on the side.', at: '2026-11-20T15:04:00Z', status: 'new' },
  ],
};

// ---- import
// A page from an import file, checked before it goes in: { rec } (its id as a sticker reads it, its details as
// [label, value] pairs) or { why }, naming it for the toast.
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TEXT = ['title', 'intro', 'notes', 'name', 'where', 'kind', 'summary', 'steps', 'care', 'warn', 'manual', 'call', 'photo', 'task', 'lastDone'];
export function checkPage(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { why: 'a line that isn\'t a page' };
  const id = typeof d.id === 'string' ? d.id.trim().toLowerCase() : '';
  if (!PAGE_ID.test(id)) return { why: `id ${JSON.stringify(d.id ?? '')}` };
  const rec = { ...d, id };
  for (const k of TEXT) if (rec[k] != null && typeof rec[k] !== 'string') return { why: `"${id}" (its ${k} isn't text)` };
  if (typeof rec.facts === 'string') rec.facts = parseFacts(rec.facts);
  if (rec.facts != null && (!Array.isArray(rec.facts) || !rec.facts.every(f => Array.isArray(f) && f.length <= 2 && f.every(x => typeof x === 'string'))))
    return { why: `"${id}" (its details aren't "Label: value" lines)` };
  if (rec.facts) rec.facts = rec.facts.map(([k = '', v = '']) => [k.trim(), v.trim()]).filter(([k, v]) => k || v);
  if (rec.contact != null && (typeof rec.contact !== 'object' || Array.isArray(rec.contact) || Object.values(rec.contact).some(x => x != null && typeof x !== 'string')))
    return { why: `"${id}" (its contact isn't name, phone, email and note)` };
  if (rec.every != null && rec.every !== '') {
    if (!everyOf(rec.every)) return { why: `"${id}" (its every isn't a whole number of months)` };
    rec.every = everyOf(rec.every);
  }
  if (rec.numbers != null && (!Array.isArray(rec.numbers) || !rec.numbers.every(n => n && typeof n === 'object' && !Array.isArray(n) && typeof n.id === 'string' && n.id
    && Object.values(n).every(x => x == null || typeof x === 'string'))))
    return { why: `"${id}" (its other numbers aren't name, phone and when to call)` };
  return { rec };
}

// Details by label: the file's labels fill in a blank value or add a line, a value here is never replaced, and lines
// only here stay. A line with no label is added if its text isn't there yet.
const label = s => s.trim().toLowerCase();
export function mergeFacts(here, file) {
  const value = (here || []).map(f => [...f]);
  let filled = false, kept = false;
  for (const [k, v] of file || []) {
    const at = k ? value.find(f => label(f[0]) === label(k)) : v ? value.find(f => !f[0] && label(f[1]) === label(v)) : null;
    if (!v) { if (at?.[1]) kept = true; continue; }
    if (!at) { value.push([k, v]); filled = true; }
    else if (!at[1]) { at[1] = v; filled = true; }
    else if (at[1] !== v) kept = true;
  }
  if (value.some(([k, v]) => v && !(file || []).some(f => (k ? label(f[0]) === label(k) : !f[0] && label(f[1]) === label(v))))) kept = true;
  return { value, filled, kept };
}

// An import file's pages over this phone's. here(id) is the page here, gone(id) true for one deleted here. Each page
// only fills in (the kit's fillIn): a Where line, a contact field or a detail typed here is never blanked or replaced,
// and a page deleted here stays deleted. Returns { puts, res, back } (res for the kit's importSummary). With back (the
// file is a saved copy), a page deleted here goes in back instead, whole, for the app to offer to bring back.
export function mergeImport(docs, here, gone, { back = false } = {}) {
  const puts = [], mine = {}, res = { added: 0, filled: 0, kept: 0, gone: 0, skipped: [] }, offer = [];
  for (const d of docs) {
    const c = checkPage(d);
    if (c.why) { res.skipped.push(c.why); continue; }
    const id = c.rec.id;
    // h/home is the front page's other sticker address, never a page of its own (the front page is the house doc): a
    // page saved there would be counted as added and never shown, so it's skipped and named
    if (id === 'home') { res.skipped.push('"home" (the front page\'s own address; the front page is "house")'); continue; }
    if (gone(id) && !mine[id]) {
      if (back && typeof c.rec.name === 'string' && c.rec.name.trim() && !refusal(c.rec) && !offer.some(d => d.id === id)) offer.push(c.rec); else res.gone++;
      continue;
    }
    const was = mine[id] || here(id);
    const { doc, filled, kept } = was ? fillIn(was, c.rec, { facts: mergeFacts }) : { doc: c.rec, filled: [], kept: [] };
    if (id !== 'house' && (typeof doc.name !== 'string' || !doc.name.trim())) { res.skipped.push(`"${id}" (no name)`); continue; }
    if (refusal(doc)) { res.skipped.push(`"${id}" (too big to save)`); continue; }
    if (!was) res.added++; else if (filled.length && !mine[id]) res.filled++;
    if (kept.length && !mine[id]) res.kept++;
    if (!was || filled.length) { mine[id] = doc; puts.push(doc); }
  }
  return { puts, res, back: offer };
}
