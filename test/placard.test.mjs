import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacts, factsText, lines, STARTER, SAMPLE, checkPage, mergeFacts, mergeImport, dial, splitLinks, reachBy, groupReports, timeSpan,
  isoDay, everyOf, nextDue, isDue, job, doneText } from '../js/starter.js';

test('details lines round-trip', () => {
  const f = parseFacts('Model: XE50T10\n\nFilter: 16 × 25 × 1\nno colon here\nTime: 3:30');
  assert.deepEqual(f, [['Model', 'XE50T10'], ['Filter', '16 × 25 × 1'], ['', 'no colon here'], ['Time', '3:30']]);
  assert.equal(factsText(f), 'Model: XE50T10\nFilter: 16 × 25 × 1\nno colon here\nTime: 3:30');
});
test('a link or a time on a details line of its own stays one value, and survives an edit', () => {
  const f = parseFacts('https://example.com/valve-manual.pdf\nPumped 10:30 am Tuesdays\nManual: https://example.com/m.pdf\nModel:XE50T10\nFilter:\nAlso: 1:30 or 2:45\n' +
    'Breakers:21 and 23\nSize:200 A\nTime: 10:30');
  assert.deepEqual(f, [['', 'https://example.com/valve-manual.pdf'], ['', 'Pumped 10:30 am Tuesdays'], ['Manual', 'https://example.com/m.pdf'],
    ['Model', 'XE50T10'], ['Filter', ''], ['Also', '1:30 or 2:45'], ['Breakers', '21 and 23'], ['Size', '200 A'], ['Time', '10:30']]);
  assert.deepEqual(parseFacts(factsText(f)), f, 'a second edit changed the details');
});
test('Call dials the first number, without its extension', () => {
  for (const [typed, number] of [['800-555-0100 ext. 12', '8005550100'], ['800-555-0100 x12', '8005550100'], ['800-555-0100, ext 12', '8005550100'],
    ['(800) 555-0100 Ext 4', '8005550100'], ['800-555-0100 or 800-555-0199', '8005550100'], ['+1 (800) 555-0100', '+18005550100'], ['555-0142', '5550142'], ['', ''],
    ['800-555-0100 / 800-555-0199', '8005550100'], ['800-555-0100/0199', '8005550100'], ['800-555-0100 & 800-555-0199', '8005550100'],
    ['800-555-0100 and 800-555-0199', '8005550100'], ['800-555-0100 (after 6 pm 800-555-0199)', '8005550100'], ['800-555-0100(nights 800-555-0199)', '8005550100'],
    ['(800)555-0100', '8005550100']])
    assert.equal(dial(typed), number, typed);
});
test('phone numbers and https links in a page\'s text are marked, and nothing else is', () => {
  const links = t => splitLinks(t).filter(p => p.href).map(p => [p.text, p.href]);
  assert.deepEqual(links('Plumber: Acme Plumbing 555-0123'), [['555-0123', 'tel:5550123']]);
  assert.deepEqual(links('Call 800-555-0100 ext. 12 days, (800) 555.0199 nights'), [['800-555-0100', 'tel:8005550100'], ['(800) 555.0199', 'tel:8005550199']]);
  assert.deepEqual(links('The manual: https://example.com/valve.pdf.'), [['https://example.com/valve.pdf', 'https://example.com/valve.pdf']]);
  assert.equal(splitLinks('See https://example.com/a. Then call.').map(p => p.text).join(''), 'See https://example.com/a. Then call.', 'text was lost');
  for (const t of ['16 × 25 × 1', 'XE50T10', 'SN 123-4567-89', '2026-11-27', 'Model 410 2020', '1234-5678', 'http://example.com', 'Breakers 21 and 23',
    'Heater 120-1500 W', 'Tank 80 gal (303-1100 lb full)', 'Elevation 750.1234 ft'])
    assert.deepEqual(links(t), [], t);
  assert.deepEqual(links('Call 555-0142 in an emergency.'), [['555-0142', 'tel:5550142']], 'a number before "in" isn\'t a link');
  // a unit rules out only the short form's ranges: "A/C" after a number isn't amps, and a whole number is never a range
  assert.deepEqual(links('Acme Cooling 555-0123 A/C repair'), [['555-0123', 'tel:5550123']], '"A/C" after a number read as amps');
  assert.deepEqual(links('Call 800-555-0100 A/C and heat'), [['800-555-0100', 'tel:8005550100']], 'a whole number before "A/C" isn\'t a link');
  assert.deepEqual(links('Panel 100-2000 A main'), [], 'a range in amps');
  // nothing in the sample house is a link: its models, sizes, breakers and years stay text
  for (const d of SAMPLE['placard.site']) for (const v of [d.where, d.summary, d.steps, d.care, d.warn, d.notes, ...(d.facts || []).flat()])
    assert.deepEqual(links(v), [], v);
});
test('steps drop their own numbering', () => {
  assert.deepEqual(lines('1. Turn it\n2) Wait\n- Call\n\n'), ['Turn it', 'Wait', 'Call']);
  // and keep a number a line starts with
  assert.deepEqual(lines('0.5 inch of water in the tray is normal.\n-5°F or colder: leave the kitchen tap dripping.\n1.5 turns opens it'),
    ['0.5 inch of water in the tray is normal.', '-5°F or colder: leave the kitchen tap dripping.', '1.5 turns opens it']);
});
test('starter ids are unique and tag-safe', () => {
  const ids = STARTER.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.ok(SAMPLE['placard.site'].some(d => d.id === 'house'));
});

test('an updated import file only fills in: Where lines, the contact card and typed details stay, deleted pages stay deleted', () => {
  const here = {
    house: { id: 'house', title: 'House manual', intro: 'Tap any sticker.', contact: { name: 'Lab Owner', phone: '555-0144', email: 'owner@example.com', note: '' } },
    'water-heater': { id: 'water-heater', name: 'Water heater', kind: 'water', order: 2, where: 'Basement, next to the furnace.', summary: 'Gas, 40 gallons.',
      facts: [['Model', 'AW-40G'], ['Installed', ''], ['Gas valve', 'red knob at the bottom']], tagged: '2026-11-27' },
    'water-shutoff': { id: 'water-shutoff', name: 'Main water shutoff', kind: 'water', where: 'Basement, behind the stairs.', steps: 'Turn the red handle.' },
  };
  const file = [
    { id: 'house', title: 'House manual', intro: '', contact: { name: '', phone: '', email: '', note: 'Call any time for a leak.' } },
    { id: 'water-heater', name: 'Water heater', kind: 'water', order: 2, where: '', summary: 'Gas, 40 gallons.', facts: [['Model', 'AW40G'], ['Installed', '2019'], ['Anode', 'Checked 2025']] },
    { id: 'water-shutoff', name: 'Main water shutoff', kind: 'water', where: '', steps: 'Turn the red handle.', facts: 'Valve: 1" ball valve' },
    { id: 'garage-door', name: 'Garage door', kind: 'other', where: '' },
    { id: 'well-tank', name: 'Well pressure tank', kind: 'water' },
    { id: 'Back Door', name: 'Back door' }, { id: 'attic', where: 'Hall closet' }, { id: 'septic', name: 'Septic', facts: [['a', 'b', 'c']] }, { id: 'dryer', name: 7 },
  ];
  const { puts, res } = mergeImport(file, id => here[id], id => id === 'garage-door');
  const put = Object.fromEntries(puts.map(d => [d.id, d]));
  assert.deepEqual(Object.keys(put).sort(), ['house', 'water-heater', 'water-shutoff', 'well-tank']);
  assert.deepEqual(put.house.contact, { ...here.house.contact, note: 'Call any time for a leak.' }, 'the contact card was emptied');
  assert.equal(put.house.intro, 'Tap any sticker.');
  assert.equal(put['water-heater'].where, 'Basement, next to the furnace.', 'the Where line was blanked');
  assert.deepEqual(put['water-heater'].facts, [['Model', 'AW-40G'], ['Installed', '2019'], ['Gas valve', 'red knob at the bottom'], ['Anode', 'Checked 2025']],
    'details: a typed value replaced, a blank not filled, a typed line lost or a new one not added');
  assert.equal(put['water-heater'].tagged, '2026-11-27');
  assert.deepEqual(put['water-shutoff'].facts, [['Valve', '1" ball valve']], 'details as text');
  assert.deepEqual(res, { added: 1, filled: 3, kept: 3, gone: 1,
    skipped: ['id "Back Door"', '"attic" (no name)', '"septic" (its details aren\'t "Label: value" lines)', '"dryer" (its name isn\'t text)'] });
  // again, over what it just did: nothing new
  const after = { ...here, ...put };
  assert.deepEqual(mergeImport(file, id => after[id], id => id === 'garage-door').puts, []);
  assert.equal(checkPage({ id: 'Water-Heater', name: 'x' }).rec.id, 'water-heater');
  assert.deepEqual(mergeFacts([['', 'Spare filters on the shelf']], [['', 'spare filters on the shelf'], ['', 'Filter: 16x25']]).value,
    [['', 'Spare filters on the shelf'], ['', 'Filter: 16x25']]);
});

test('the QR library is not on the page: only the screen that draws codes loads it, and it stays in the offline copy', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /qrcode\.js/, 'index.html loads js/kit/qrcode.js on every page, a tenant\'s first tap too');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw.match(/SHELL = \[([^\]]*)\]/)[1], /'js\/kit\/qrcode\.js'/, 'printing offline needs qrcode.js in the offline copy');
});

test('index.html asks for every module app.js imports at once, and says it is loading before any of them has come', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const preloaded = [...page.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]).sort();
  // app.js's static imports, and theirs, as paths from the site's root
  const seen = new Set(), todo = ['js/app.js'];
  while (todo.length) {
    const file = todo.pop(), src = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm)) {
      const to = new URL(m[1] || m[2], 'https://x/' + file).pathname.slice(1);
      if (!seen.has(to)) { seen.add(to); todo.push(to); }
    }
  }
  assert.deepEqual(preloaded, [...seen].sort(), 'the modulepreload list in index.html isn\'t what app.js imports');
  assert.match(page, /<div id="app"[^>]*><p class="empty">Loading the house manual…<\/p><\/div>/, 'a first tap shows a blank page until the scripts have come');
});

test('Reports: a phone number or an email in a report\'s contact, and one card for the same words from one page on one day', () => {
  for (const [contact, tel, email] of [['555-0101', '5550101', ''], ['5550101', '5550101', ''], ['+1 845 555 0101', '+18455550101', ''], ['(845) 555-0101', '8455550101', ''],
    ['Pat, 555-0101 after 6 pm', '5550101', ''], ['pat@example.com', '', 'pat@example.com'], ['555-0101 or pat@example.com', '5550101', 'pat@example.com'],
    ['call me', '', ''], ['12 Elm St', '', ''], ['', '', '']])
    assert.deepEqual(reachBy(contact), { tel, email }, contact);
  const at = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();
  const r = (id, text, when, more = {}) => ({ id, system: 'water-heater', text, at: when, status: 'new', ...more });
  const cards = groupReports([r('a', 'No hot water', at(27, 2, 19)), r('b', '  no hot WATER ', at(27, 2, 25), { repeat: true }), r('c', 'No hot water', at(27, 2, 31), { status: 'handled' }),
    r('d', 'No hot water', at(28, 9, 0)), r('e', 'No hot water', at(27, 3, 0), { system: 'well-tank' }), r('f', 'Drip', at(27, 4, 0)), r('g', 'Odd', 'not a time')]);
  assert.deepEqual(cards.map(c => [c.reports.map(x => x.id).join(''), c.handled]), [['d', false], ['f', false], ['e', false], ['abc', false], ['g', false]]);
  assert.equal(groupReports([r('a', 'x', at(27, 1, 0), { status: 'handled' }), r('b', 'x', at(27, 1, 5), { status: 'handled' })])[0].handled, true);
  // the same words after the first was marked handled: a new problem, a card of its own (the ledger emailed it as new)
  assert.deepEqual(groupReports([r('a', 'No hot water', at(27, 7, 0), { status: 'handled' }), r('b', 'No hot water', at(27, 18, 0))]).map(c => [c.reports.map(x => x.id).join(''), c.handled]),
    [['b', false], ['a', true]], 'a report after the first was handled joined its card');
  // handled in one press, a card stays one; the new one handled later stays its own
  const press = (at, ...reps) => reps.map(x => ({ ...x, status: 'handled', handledAt: at }));
  assert.deepEqual(groupReports([...press(1, r('a', 'No hot water', at(27, 7, 0)), r('b', 'No hot water', at(27, 7, 5), { repeat: true })), ...press(2, r('c', 'No hot water', at(27, 18, 0)))])
    .map(c => [c.reports.map(x => x.id).join(''), c.handled]), [['c', true], ['ab', true]], 'two problems handled in turn read as one sent again');
  // and one sent again after that joins the new card, not the handled one
  assert.deepEqual(groupReports([r('a', 'No hot water', at(27, 7, 0), { status: 'handled' }), r('b', 'No hot water', at(27, 18, 0)), r('c', 'No hot water', at(27, 18, 5), { repeat: true })])
    .map(c => c.reports.map(x => x.id).join('')), ['bc', 'a']);
  // a repeat the ledger kept just after midnight joins the card it repeats
  assert.deepEqual(groupReports([r('a', 'No heat', at(27, 23, 50)), r('b', 'No heat', at(28, 0, 10), { repeat: true }), r('c', 'No heat', at(28, 9, 0))]).map(c => c.reports.map(x => x.id).join('')),
    ['c', 'ab'], 'a repeat after midnight started a card of its own');
  const t = (h, m) => new Date(2026, 10, 27, h, m).getTime();
  assert.deepEqual([timeSpan(t(2, 19), t(2, 31)), timeSpan(t(11, 58), t(12, 10)), timeSpan(t(9, 0), t(9, 0)), timeSpan(t(12, 5), t(13, 0))],
    ['2:19-2:31 am', '11:58 am-12:10 pm', '9:00 am', '12:05-1:00 pm']);
});

test('an import with a page under "home" (the front page\'s other address) skips it and says so, rather than counting a page no one sees', () => {
  const { puts, res } = mergeImport([{ id: 'home', name: 'Home', summary: 'Welcome' }, { id: 'Home', title: 'House manual' }, { id: 'house', title: 'House manual' },
    { id: 'water-heater', name: 'Water heater' }], () => null, () => false);
  assert.deepEqual(puts.map(d => d.id), ['house', 'water-heater']);
  assert.deepEqual(res, { added: 2, filled: 0, kept: 0, gone: 0, skipped: ['"home" (the front page\'s own address; the front page is "house")', '"home" (the front page\'s own address; the front page is "house")'] });
});

test('an import\'s other numbers are a list of name, phone and when to call, each with an id', () => {
  const ok = checkPage({ id: 'house', numbers: [{ id: 'septic', name: 'Hudson Septic', phone: '845-555-0170', note: '' }] });
  assert.deepEqual(ok.rec.numbers, [{ id: 'septic', name: 'Hudson Septic', phone: '845-555-0170', note: '' }]);
  for (const numbers of ['Hudson Septic 845-555-0170', [{ name: 'No id', phone: '555-0101' }], [{ id: 'x', phone: 5550101 }], [['x', 'y']]])
    assert.equal(checkPage({ id: 'house', numbers }).why, '"house" (its other numbers aren\'t name, phone and when to call)', JSON.stringify(numbers));
  assert.equal(checkPage({ id: 'septic', name: 'Septic', call: 3 }).why, '"septic" (its call isn\'t text)');
});

test('a regular job: next due is Last done plus every N months, the day kept or the month\'s last', () => {
  for (const [last, every, due] of [['2026-11-03', 3, '2027-02-03'], ['2026-08-31', 6, '2027-02-28'], ['2027-08-31', 6, '2028-02-29'], ['2026-01-31', 1, '2026-02-28'],
    ['2026-12-15', 1, '2027-01-15'], ['2026-05-10', 12, '2027-05-10'], ['2026-05-10', 120, '2036-05-10'], ['2026-03-31', '2', '2026-05-31'], ['2026-03-31', ' 3 ', '2026-06-30']])
    assert.equal(nextDue({ lastDone: last, every }), due, `${last} + ${JSON.stringify(every)}`);
  // without both, or with either unreadable: never due
  for (const p of [{}, { lastDone: '2026-11-03' }, { every: 3 }, { lastDone: '2026-02-30', every: 3 }, { lastDone: 'Nov 3', every: 3 }, { lastDone: '0999-01-01', every: 3 },
    { lastDone: '2026-11-03', every: 0 }, { lastDone: '2026-11-03', every: 2.5 }, { lastDone: '2026-11-03', every: 121 }, { lastDone: '2026-11-03', every: '0x10' },
    { lastDone: '2026-11-03', every: true }, { lastDone: '2026-11-03', every: '' }, { lastDone: '2026-11-03\n', every: 3 }])
    assert.equal(nextDue(p), '', JSON.stringify(p));
  assert.equal(isDue({ lastDone: '2026-08-02', every: 3 }, '2026-11-01'), false);
  assert.equal(isDue({ lastDone: '2026-08-02', every: 3 }, '2026-11-02'), true, 'due on the day');
  assert.equal(isDue({ every: 3 }, '2030-01-01'), false, 'never done reads as due');
  assert.deepEqual([everyOf('3'), everyOf(3), everyOf('3.0'), everyOf('-3'), everyOf(null)], [3, 3, 3, 0, 0]);
  assert.deepEqual([isoDay('2026-02-29'), isoDay('2028-02-29'), isoDay(' 2026-01-01')], ['', '2028-02-29', '']);
});
test('a regular job reads as a line for tenants', () => {
  assert.equal(doneText({ task: 'Filter change', every: 3, lastDone: '2026-11-03' }), 'Last filter change: Nov 3, 2026. Every 3 months.');
  assert.equal(doneText({ task: 'HVAC service', lastDone: '2026-11-03' }), 'Last HVAC service: Nov 3, 2026.');
  assert.equal(doneText({ lastDone: '2026-11-03', every: 1 }), 'Last done: Nov 3, 2026. Every month.');
  assert.equal(doneText({ task: '  Flush ', every: '12' }), 'Flush every 12 months.');
  assert.equal(doneText({ every: 6 }), 'Every 6 months.');
  assert.equal(doneText({ task: 'Filter change' }), '', 'a job with no date or months says nothing');
  assert.equal(doneText({ task: 'Pump-out', every: 'often', lastDone: 'last spring' }), '');
  assert.deepEqual([job('Filter change'), job('HVAC service'), job('A'), job('Élan check')], ['filter change', 'HVAC service', 'A', 'élan check']);
});
test('an import\'s every N months is a whole number, typed as digits or not', () => {
  assert.equal(checkPage({ id: 'air', name: 'Air', every: '3' }).rec.every, 3);
  assert.equal(checkPage({ id: 'air', name: 'Air', every: 6, lastDone: '2026-08-02', task: 'Filter change' }).rec.every, 6);
  assert.equal(checkPage({ id: 'air', name: 'Air', every: 'quarterly' }).why, '"air" (its every isn\'t a whole number of months)');
  assert.equal(checkPage({ id: 'air', name: 'Air', lastDone: 20260802 }).why, '"air" (its lastDone isn\'t text)');
});

test('a saved copy imported: pages deleted here since, or whose sticker was sent elsewhere, are offered back whole', () => {
  const docs = [{ id: 'house', title: 'House manual' }, { id: 'water-heater', name: 'Water heater', where: 'Basement', tagged: '2026-11-20', locked: '2026-11-20' },
    { id: 'attic', name: 'Attic fan', where: 'Attic' }, { id: 'water-shutoff', name: 'Main water shutoff', where: 'Basement, left of the tank' }, { id: 'nameless' }];
  const here = { house: docs[0], 'water-shutoff': { id: 'water-shutoff', name: 'Main water shutoff', where: '' } };
  const gone = id => ['water-heater', 'attic', 'nameless'].includes(id);
  const r = mergeImport(docs, id => here[id] || null, gone, { back: true });
  assert.deepEqual(r.back, [docs[1], docs[2]], 'a page deleted here since the copy wasn\'t offered back whole');
  assert.deepEqual(r.puts.map(d => [d.id, d.where]), [['water-shutoff', 'Basement, left of the tank']]);
  assert.equal(r.res.gone, 1, 'a page with no name can\'t come back, and counts as left out');
  assert.deepEqual(mergeImport(docs, id => here[id] || null, gone).back, [], 'an import file that isn\'t a copy offered a deleted page back');
});
