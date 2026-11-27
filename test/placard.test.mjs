import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacts, factsText, lines, STARTER, SAMPLE, checkPage, mergeFacts, mergeImport } from '../js/starter.js';

test('details lines round-trip', () => {
  const f = parseFacts('Model: XE50T10\n\nFilter: 16 × 25 × 1\nno colon here\nTime: 3:30');
  assert.deepEqual(f, [['Model', 'XE50T10'], ['Filter', '16 × 25 × 1'], ['', 'no colon here'], ['Time', '3:30']]);
  assert.equal(factsText(f), 'Model: XE50T10\nFilter: 16 × 25 × 1\nno colon here\nTime: 3:30');
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
