// dispatch/placard_slip.py, the Dispatch slip's rental lines, run here with Python: it reads a page's regular job as
// starter.js does (the same pages are due on the same day as the Edit list's due chip), prints what's due, and on the
// Pi's command line reads the manual as a tenant's phone does, from a pretend ledger on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextDue, isDue } from '../js/starter.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dispatch');
// Python with no __pycache__ left in the repo (-B), the slip's folder on its path
const py = (code, input = '') => execFileSync('python3', ['-B', '-c', `import sys, json, datetime; sys.path.insert(0, ${JSON.stringify(dir)})\n${code}`], { input, encoding: 'utf8', timeout: 60000 });

const CASES = [
  ['2026-11-03', 3], ['2026-08-31', 6], ['2027-08-31', 6], ['2026-01-31', 1], ['2026-12-15', 1], ['2026-05-10', 120], ['2026-03-31', '2'], ['2026-03-31', ' 3 '],
  ['2026-03-31', '3.0'], ['2026-11-03', 0], ['2026-11-03', 2.5], ['2026-11-03', 121], ['2026-11-03', '0x10'], ['2026-11-03', true], ['2026-11-03', ''], ['2026-11-03', null],
  ['2026-02-30', 3], ['2028-02-29', 12], ['Nov 3', 3], ['0999-01-01', 3], ['2026-11-03\n', 3], [null, 3], [20261103, 3], ['2026-1-3', 3]];

test('the slip works out next due as the page does, for every way a page can hold it', () => {
  const got = JSON.parse(py(`from placard_slip import next_due
cases = json.load(sys.stdin)
print(json.dumps([(lambda d: d.isoformat() if d else '')(next_due({'lastDone': l, 'every': e})) for l, e in cases]))`, JSON.stringify(CASES)));
  assert.deepEqual(got, CASES.map(([lastDone, every]) => nextDue({ lastDone, every })));
});

const DOCS = [
  { id: 'house', title: 'House manual', lastDone: '2020-01-01', every: 1 },
  { id: 'air-handler-up', name: 'Air handler, upstairs', task: 'Filter change', every: 3, lastDone: '2026-08-02' },
  { id: 'septic', name: 'Septic system', task: 'Pump-out', every: '36', lastDone: '2023-06-30' },
  { id: 'water-heater', name: 'Water heater', task: 'Flush', every: 12, lastDone: '2026-10-01' },   // not due till next October
  { id: 'well-tank', name: 'Well pressure tank', every: 6, lastDone: '2026-05-28' },                // due today, no job named
  { id: 'washer', name: 'Washer', task: 'Hose check', every: 6 },                                   // never done: not due
  { id: 'old-fridge', to: 'house', name: 'Old fridge', every: 1, lastDone: '2020-01-01' },        // a deleted page's sticker
];
const TODAY = '2026-11-28';

test('the slip lists what is due, the longest overdue first, as Rental lines 32 wide', () => {
  const lines = py(`from placard_slip import slip
print('\\n'.join(slip(json.load(sys.stdin), today=datetime.date(2026, 11, 28))))`, JSON.stringify(DOCS)).trimEnd().split('\n');
  assert.deepEqual(lines, ['Rental: Septic system - pump-out', '  due (last Jun 30, 2023)', 'Rental: Air handler, upstairs -', '  filter change due (last Aug 2)',
    'Rental: Well pressure tank due', '  (last May 28)']);
  for (const l of lines) assert.ok(l.length <= 32, l);
  // the same pages the Edit list calls due
  assert.deepEqual(DOCS.filter(d => d.id !== 'house' && !d.to && isDue(d, TODAY)).map(d => d.name), ['Air handler, upstairs', 'Septic system', 'Well pressure tank']);
  assert.equal(py(`from placard_slip import slip
print(json.dumps(slip([{'id': 'washer', 'name': 'Washer', 'every': 6}])))`).trim(), '[]', 'nothing due is no lines');
});

// A pretend ledger: GET ?op=pub&app=placard&coll=site answers with the manual, as Code.gs does for a tenant.
async function ledger(answer) {
  const asked = [];
  const srv = createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    asked.push(Object.fromEntries(q));
    res.writeHead(200, { 'content-type': answer.html ? 'text/html' : 'application/json' });
    res.end(answer.html ? '<!DOCTYPE html><title>Sign in</title>' : JSON.stringify(answer));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/macros/s/TEST/exec`, asked, close: () => new Promise(r => srv.close(r)) };
}
// the command line, run without holding up this process (the pretend ledger answers from it)
const run = (...args) => new Promise((resolve, reject) => {
  const p = spawn('python3', ['-B', join(dir, 'placard_slip.py'), ...args]);
  let stdout = '', stderr = '';
  p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
  const t = setTimeout(() => { p.kill(); reject(new Error('placard_slip.py took over 60 s')); }, 60000);
  p.on('close', status => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});

test('run by hand on the Pi: the lines, or (nothing due), or a Ledger: line for an address that is not the ledger', async () => {
  let L = await ledger({ ok: true, docs: DOCS });
  try {
    const p = await run(L.url);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^Rental: Septic system - pump-out\n/);
    assert.deepEqual(L.asked, [{ op: 'pub', app: 'placard', coll: 'site' }], 'it read the manual some other way than a tenant does');
  } finally { await L.close(); }
  L = await ledger({ ok: true, docs: [{ id: 'house' }] });
  try { const p = await run(L.url); assert.deepEqual([p.status, p.stdout], [0, '(nothing due)\n']); } finally { await L.close(); }
  for (const [answer, said] of [[{ ok: false, error: 'not public' }, 'Ledger: not public\n'],
    [{ html: true }, 'Ledger: got a web page, not the ledger (check the address ends /exec and access is Anyone)\n']]) {
    L = await ledger(answer);
    try { const p = await run(L.url); assert.deepEqual([p.status, p.stdout], [1, said]); } finally { await L.close(); }
  }
  // nothing answering there at all
  const gone = await ledger({ ok: true, docs: [] }); await gone.close();
  const p = await run(gone.url);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /^Ledger: couldn't reach it \(/);
  // and from Dispatch's own code it never raises: no lines
  assert.equal(py(`from placard_slip import due_lines
print(json.dumps(due_lines(${JSON.stringify(gone.url)}, deadline=5)))`).trim(), '[]');
});
