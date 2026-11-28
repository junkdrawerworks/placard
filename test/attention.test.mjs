import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLLS, look } from '../js/attention.js';
import { SAMPLE } from '../js/starter.js';

// Switchboard's read(coll): the collection's records as the ledger lists them, deleted ones left out.
const reader = data => coll => (data[coll] || []).filter(d => !d._deleted);
const data = Object.fromEntries(COLLS.map(c => [c, SAMPLE['placard.' + c]]));
const nov = new Date(2026, 10, 26, 15, 30);

test('reads the manual and the reports', () => {
  assert.deepEqual(COLLS, ['site', 'reports']);
});

test('Needs a look: the new reports, then the jobs due, in the slip\'s words', () => {
  assert.deepEqual(look(reader(data), nov), [{ text: 'Rental: 1 new report', href: '#/reports' },
    { text: 'Rental: Air handler, upstairs - filter change due', href: '#air-handler-up' }]);
  assert.deepEqual(look(reader(data), new Date(2026, 10, 1)), [{ text: 'Rental: 1 new report', href: '#/reports' }], 'the filter change comes due on Nov 2');
});

test('reports counted as the Reports screen\'s cards: the same words sent twice are one, a handled one is none', () => {
  const r = (id, at, text, more = {}) => ({ id, system: 'water-heater', text, at, status: 'new', ...more });
  const reports = [r('a', '2026-11-25T10:00:00Z', 'Drip'), r('b', '2026-11-25T10:05:00Z', 'Drip'), r('c', '2026-11-24T09:00:00Z', 'No heat'),
    r('d', '2026-11-20T09:00:00Z', 'Fixed now', { status: 'handled', handledAt: 1 }), r('e', '2026-11-26T09:00:00Z', 'Gone', { _deleted: true })];
  assert.deepEqual(look(reader({ reports }), nov), [{ text: 'Rental: 2 new reports', href: '#/reports' }]);
});

test('several jobs due: the longest overdue first, on the owner\'s list; the front page and a sent-on sticker aren\'t pages', () => {
  const site = [{ id: 'house', task: 'x', every: 1, lastDone: '2026-01-01' }, { id: 'old-heater', to: 'water-heater', task: 'x', every: 1, lastDone: '2026-01-01' },
    { id: 'water-heater', name: 'Water heater', task: 'Flush', every: 12, lastDone: '2025-11-01' }, { id: 'crawl-space', every: 6, lastDone: '2026-04-30' },
    { id: 'furnace', name: 'Furnace', task: 'HVAC service', every: 12, lastDone: '2025-12-15' }];
  assert.deepEqual(look(reader({ site }), nov), [{ text: 'Rental: Crawl space due; Water heater - flush due', href: '#/owner' }]);
  assert.deepEqual(look(reader({}), nov), []);
});
