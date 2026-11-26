import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacts, factsText, lines, STARTER, SAMPLE } from '../js/starter.js';

test('details lines round-trip', () => {
  const f = parseFacts('Model: XE50T10\n\nFilter: 16 × 25 × 1\nno colon here\nTime: 3:30');
  assert.deepEqual(f, [['Model', 'XE50T10'], ['Filter', '16 × 25 × 1'], ['', 'no colon here'], ['Time', '3:30']]);
  assert.equal(factsText(f), 'Model: XE50T10\nFilter: 16 × 25 × 1\nno colon here\nTime: 3:30');
});
test('steps drop their own numbering', () => {
  assert.deepEqual(lines('1. Turn it\n2) Wait\n- Call\n\n'), ['Turn it', 'Wait', 'Call']);
});
test('starter ids are unique and tag-safe', () => {
  const ids = STARTER.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.ok(SAMPLE['placard.site'].some(d => d.id === 'house'));
});
