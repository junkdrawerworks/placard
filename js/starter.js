// The systems most houses have, as a starting list for the owner, and a made-up house for the sample mode; and how an
// import file goes over the pages already here.
import { fillIn, refusal } from './kit/ledger.js';
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

// "Label: value" lines to [[label, value], …] and back.
export function parseFacts(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf(':');
    return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : ['', l];
  });
}
export const factsText = facts => (facts || []).map(([k, v]) => (k ? `${k}: ${v}` : v)).join('\n');
export const lines = text => String(text || '').split('\n').map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);

export const SAMPLE = {
  'placard.site': [
    { id: 'house', title: 'House manual', intro: 'Tap any sticker in the house for what that thing is and what to do about it. In an emergency, start here.',
      contact: { name: 'Riverbend Property Care', phone: '555-0142', email: 'help@example.com', note: 'Call any time for a leak, no heat or no power. Text for anything else.' },
      notes: 'Trash goes out Monday night; recycling every other Thursday.' },
    { id: 'water-shutoff', name: 'Main water shutoff', kind: 'water', emergency: true, order: 1, where: 'Basement, left of the pressure tank, at waist height.',
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
      summary: 'Heats and cools the upstairs.', facts: [['Filter', '16 × 25 × 1'], ['Changed', 'Every 3 months']], care: 'Spare filters are on the shelf beside it.' },
    { id: 'smoke-co', name: 'Smoke and CO alarms', kind: 'safety', emergency: true, order: 5, where: 'Every bedroom, both hallways, the basement.',
      summary: 'Wired together: when one sounds, they all do.', steps: 'Smoke or CO alarm: get everyone out, then call 911.\nA chirp every minute is a low battery: tell us and we will replace it.' },
  ],
  'placard.reports': [
    { id: 'r1', system: 'water-heater', systemName: 'Water heater', kind: 'Problem', name: 'Sam', contact: '555-0101', text: 'Small drip from the valve on the side.', at: '2026-11-20T15:04:00Z', status: 'new' },
  ],
};

// ---- import
// A page from an import file, checked before it goes in: { rec } (its id as a sticker reads it, its details as
// [label, value] pairs) or { why }, naming it for the toast.
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TEXT = ['title', 'intro', 'notes', 'name', 'where', 'kind', 'summary', 'steps', 'care', 'warn', 'manual'];
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
// and a page deleted here stays deleted. Returns { puts, res } (res for the kit's importSummary).
export function mergeImport(docs, here, gone) {
  const puts = [], mine = {}, res = { added: 0, filled: 0, kept: 0, gone: 0, skipped: [] };
  for (const d of docs) {
    const c = checkPage(d);
    if (c.why) { res.skipped.push(c.why); continue; }
    const id = c.rec.id;
    if (gone(id) && !mine[id]) { res.gone++; continue; }
    const was = mine[id] || here(id);
    const { doc, filled, kept } = was ? fillIn(was, c.rec, { facts: mergeFacts }) : { doc: c.rec, filled: [], kept: [] };
    if (id !== 'house' && (typeof doc.name !== 'string' || !doc.name.trim())) { res.skipped.push(`"${id}" (no name)`); continue; }
    if (refusal(doc)) { res.skipped.push(`"${id}" (too big to save)`); continue; }
    if (!was) res.added++; else if (filled.length && !mine[id]) res.filled++;
    if (kept.length && !mine[id]) res.kept++;
    if (!was || filled.length) { mine[id] = doc; puts.push(doc); }
  }
  return { puts, res };
}
