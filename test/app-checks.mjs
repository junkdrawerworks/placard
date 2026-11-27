// Placard's own checks, run by test/e2e.mjs on a phone-sized page.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE } from '../js/starter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'https://script.google.com/macros/s/AKfyTEST/exec';
const fakeNfc = () => {
  window.__nfc = { writes: [], locks: 0 };
  window.NDEFReader = class {
    async write(msg) { window.__nfc.writes.push(msg.records[0].data); }
    async makeReadOnly() { window.__nfc.locks++; }
    async scan() {}
  };
};
// A phone on a published manual: js/config.js as served carries a ledger address (published: true), and a pretend
// ledger answers it with the sample house. L.down: every request fails; L.delay: each waits that long (Google waking
// the script); L.emailed: what a report's answer says. The service worker is off, so every request reaches the routes.
async function phone(browser, base, { published = true, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block' });
  const L = { down: false, delay: 0, emailed: true, reports: [], puts: [], site: structuredClone(SAMPLE['placard.site']) };
  if (published) await ctx.route(base + 'js/config.js', async r => r.fulfill({ contentType: 'text/javascript',
    body: (await readFile(join(root, 'js/config.js'), 'utf8')).replace("LEDGER_URL = ''", `LEDGER_URL = '${LEDGER}'`) }));
  await ctx.route('https://script.google.com/**', async r => {
    if (L.delay) await new Promise(res => setTimeout(res, L.delay));
    if (L.down) return r.abort('internetdisconnected');
    const req = r.request(), json = o => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (req.method() === 'GET') return json(new URL(req.url()).searchParams.get('op') === 'pub' ? { ok: true, docs: L.site } : { ok: true, app: 'switchboard-ledger', version: '1.1' });
    const b = JSON.parse(req.postData() || '{}');
    if (b.op === 'report') { L.reports.push(b.doc); return json({ ok: true, emailed: L.emailed }); }
    if (b.op === 'batch') {
      for (const o of b.ops) if (o.op === 'put' && o.coll === 'site') { L.puts.push(o.doc); L.site = L.site.filter(d => d.id !== o.id).concat({ ...o.doc, id: o.id }); }
      return json({ ok: true, results: b.ops.map(o => ({ ok: true, id: o.id, updated: Date.now() })) });
    }
    if (b.op === 'list') return json({ ok: true, time: Date.now(), docs: b.coll === 'site' ? L.site.map(d => ({ ...d, _updated: 1 })) : [] });
    return json({ ok: true, version: '1.1', time: Date.now() });
  });
  const errors = [];
  ctx.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  return { ctx, L, errors, page: await ctx.newPage() };
}

// A tenant: the first tap while Google wakes the script, and a report sent on one bar.
export async function tenantChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  const text = sel => page.locator(sel).evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  try {
    // nothing kept yet and the ledger slow to answer: the page says it's loading, then fills in
    L.delay = 2500;
    await page.goto(base + '#water-heater');
    await page.waitForTimeout(600);
    assert.match(await text('#app'), /^Loading the house manual…/, 'a first tap shows a blank page while the ledger wakes up');
    await page.waitForSelector('.tape >> text=Water heater', { timeout: 8000 });
    L.delay = 0;
    // the report form: an urgent line with the number to call, and the field only robots fill in, out of sight
    await page.click('text=Report a problem or log a visit');
    assert.equal(await text('dialog .call-now'), 'Urgent? Call 555-0142 now.');
    assert.equal(await page.locator('dialog .call-now a').getAttribute('href'), 'tel:5550142');
    const trap = await page.locator('#f-website').evaluate(el => ({ tab: el.tabIndex, auto: el.autocomplete, name: el.name,
      hidden: el.closest('[aria-hidden="true"]') !== null, off: el.getBoundingClientRect().right <= 0 }));
    assert.deepEqual(trap, { tab: -1, auto: 'off', name: 'website', hidden: true, off: true }, 'the robot field is missing or in sight');
    // sent on one bar that then drops: Send waits, and nothing typed is lost
    L.delay = 1200; L.down = true;
    await page.fill('#f-text', 'Water on the floor under the tank');
    await page.fill('#f-name', 'Pat');
    await page.click('dialog button[type=submit]');
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator('dialog button[type=submit]').evaluate(b => [b.disabled, b.textContent]), [true, 'Sending…'], 'Send isn\'t held while it sends');
    await page.waitForSelector('dialog .msg.bad');
    assert.equal(await text('dialog .msg.bad'), 'Couldn\'t send it. Your message is kept: try again, or call.');
    assert.equal(await page.inputValue('#f-text'), 'Water on the floor under the tank', 'a failed send threw the text away');
    assert.equal(await page.locator('dialog a.sms').getAttribute('href'), 'sms:5550142?body=' + encodeURIComponent('Water heater: Water on the floor under the tank (Pat)'));
    assert.equal(await page.locator('dialog button[type=submit]').evaluate(b => b.disabled), false, 'Send stays off after a failure');
    // closed, and the page opened again later: the form comes back with what was typed
    await page.click('dialog >> text=Cancel');
    await page.reload();
    await page.waitForSelector('.tape >> text=Water heater');
    await page.click('text=Report a problem or log a visit');
    assert.deepEqual([await page.inputValue('#f-text'), await page.inputValue('#f-name')], ['Water on the floor under the tank', 'Pat'], 'the unsent report was lost');
    // the signal is back: it goes, the form closes, and a line stays on the page
    L.delay = 0; L.down = false;
    await page.click('dialog button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Sent. The owner gets it by email.');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.match(await text('.sent'), /^Sent to the owner at \d{1,2}:\d\d [ap]m\.$/);
    assert.deepEqual(L.reports.map(r => [r.system, r.text, r.name, r.website]), [['water-heater', 'Water on the floor under the tank', 'Pat', '']]);
    assert.equal(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('placard.draft') || '{}')['water-heater'] || null)), 'null', 'the draft was kept after it sent');
    await page.click('text=Report a problem or log a visit');
    assert.equal(await page.inputValue('#f-text'), '', 'the sent report came back in the form');
    await page.click('dialog >> text=Cancel');
    // the front page has the form too; when the ledger kept it but couldn't email, it says to call if it's urgent
    await page.goto(base + '#');
    await page.waitForSelector('.urgent-tile');
    L.emailed = false;
    await page.click('text=Report a problem');
    await page.fill('#f-text', 'The porch light is out.');
    await page.click('dialog button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Saved for the owner. If it\'s urgent, call.');
    assert.match(await text('.sent'), /^Saved for the owner at \d{1,2}:\d\d [ap]m\. If it's urgent, call\.$/);
    assert.deepEqual([L.reports[1].system, L.reports[1].text], ['', 'The porch light is out.']);
    // a sticker whose page was deleted still helps: who to call, the form and the way to the front page
    await page.goto(base + '#old-boiler');
    await page.waitForSelector('text=This sticker\'s page isn\'t in the manual yet.');
    assert.equal(await page.locator('#app .contact a[href^="tel:"]').getAttribute('href'), 'tel:5550142');
    assert.equal(await page.locator('#app button', { hasText: 'Report a problem' }).count(), 1);
    assert.equal(await page.locator('#app a.btn[href="#"]').count(), 1, 'no way to the front page');
    assert.deepEqual(errors, [], 'errors on the tenant pages');
  } finally { await ctx.close(); }
}

// The owner, connected (not the sample): the status line on every page, whether a save has reached tenants, and the
// guide part that puts the ledger address in js/config.js.
export async function ownerChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base, { published: false });
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  const text = sel => page.locator(sel).evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  try {
    await page.goto(base + '#/owner');
    await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Up to date');
    assert.match(await text('#app .notice.warn'), /Put the ledger address in js\/config\.js in the repo \(Part 1 of the guide\)\./);
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    assert.equal(await text('#app > .sync:first-child'), 'Up to date', 'no status line on a page the owner edits');
    await page.click('text=Edit this page');
    await page.fill('#f-where', 'Basement, under the stairs.');
    await page.click('dialog >> button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Saved. Tenants see it now.');
    assert.equal(L.puts.at(-1).where, 'Basement, under the stairs.');
    // with no signal the edit waits on this phone, and says so
    L.down = true;
    await page.click('text=Edit this page');
    await page.fill('#f-where', 'Basement, left of the stairs.');
    await page.click('dialog >> button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Saved on this device. Tenants see it once it\'s sent.');
    await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Offline — 1 waiting');
    L.down = false;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    assert.equal(L.puts.at(-1).where, 'Basement, left of the stairs.');
    assert.deepEqual(errors, [], 'errors on the owner pages');
  } finally { await ctx.close(); }
}

export async function appChecks({ page, ctx, base, assert }) {
  await tenantChecks({ browser: ctx.browser(), base, assert });
  await ownerChecks({ browser: ctx.browser(), base, assert });
  // a tenant on an unpublished manual
  assert.match(await page.locator('#app').innerText(), /Not published yet/);
  // the sample house, as a tenant would see it after tapping a sticker
  await page.addInitScript(fakeNfc);
  await page.goto(base + '?demo');
  await page.waitForSelector('.urgent-tile');
  assert.equal(await page.locator('.urgent-tile').count(), 3, 'three emergency tiles');
  assert.equal(await page.locator('.contact a[href^="tel:"]').getAttribute('href'), 'tel:5550142');
  await page.click('text=Water heater');
  await page.waitForSelector('.tape >> text=Water heater');
  assert.equal(await page.locator('ol.steps li').count(), 2);
  assert.match(await page.locator('.facts').innerText(), /XE50T10/);
  // report a problem
  await page.click('text=Report a problem or log a visit');
  await page.fill('#f-text', 'The tank is making a ticking noise.');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('.toast.show >> text=Sent');
  // owner: write and lock the sticker, then edit the page
  await page.click('text=Write sticker');
  await page.waitForFunction(() => window.__nfc.writes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__nfc.writes), ['https://tag.junkdrawer.works/h/water-heater']);
  // the page saves and draws again: the next step stays on screen, under the saved state
  const said = () => page.locator('.nfc > .msg:last-child').textContent();
  const state = () => page.locator('.nfc .state').textContent();
  await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.nfc .state')?.textContent));
  assert.equal(await said(), 'Written. Tap it with the phone to check, then lock it.');
  await page.click('text=Lock sticker');
  await page.click('dialog >> text=Lock it');
  await page.waitForFunction(() => window.__nfc.locks === 1);
  // locked: no Write or Lock to press by mistake, and where a change of address is made instead
  await page.waitForFunction(() => /^Locked /.test(document.querySelector('.nfc .state')?.textContent));
  assert.match(await state(), /^Locked [A-Z][a-z]{2} \d{1,2}, \d{4}\. To send it somewhere else, use Switchboard\.$/);
  assert.equal(await page.locator('.nfc button', { hasText: /Write sticker|Lock sticker/ }).count(), 0, 'Write and Lock offered for a locked sticker');
  assert.equal(await said(), 'Locked. It will open this page for good.');
  // a replacement (or a spare) for a locked sticker: a new one for the same page, written and not locked until it is
  await page.click('.nfc >> text=Replace or make a spare');
  await page.waitForSelector('.nfc >> text=Use a new blank sticker. The old one, wherever it is, keeps opening this page.');
  await page.click('.nfc >> text=Write sticker');
  await page.waitForFunction(() => window.__nfc.writes.length === 2);
  await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.nfc .state')?.textContent));
  assert.equal(await page.evaluate(() => window.__placard.ledger.doc('site', 'water-heater').locked), null);
  assert.equal(await said(), 'Written. Tap it with the phone to check, then lock it.');
  assert.equal(await page.locator('.nfc button', { hasText: 'Lock sticker' }).count(), 1);
  await page.click('text=Edit this page');
  await page.fill('#f-where', 'Basement, under the stairs.');
  await page.click('dialog >> button[type=submit]');
  await page.waitForSelector('.where >> text=under the stairs');
  // a page too long for the ledger (a whole manual pasted in) says so, and the page keeps what it had
  await page.click('text=Edit this page');
  await page.fill('#f-care', 'x'.repeat(46000));
  await page.click('dialog >> button[type=submit]');
  await page.waitForSelector('.toast.show >> text=Too long to save');
  assert.equal(await page.evaluate(() => (window.__placard.ledger.doc('site', 'water-heater').care || '').length < 46000), true);
  // the owner list shows it written and locked, the QR sheet has every page, the report is there to handle
  await page.goto(base + '?demo#/owner');
  await page.waitForSelector('.row');
  assert.equal(await page.locator('.list .row').count(), 5);
  assert.equal(await page.locator('.list .row', { hasText: 'Water heater' }).locator('.chip').textContent(), 'written');
  await page.goto(base + '?demo#/print');
  await page.waitForSelector('.qr-card svg');
  assert.equal(await page.locator('.qr-card').count(), 5);
  await printChecks(page, assert, '.qr-card');
  await page.goto(base + '?demo#/reports');
  await page.click('text=Mark handled');
  await page.waitForSelector('.report.dim');
}

// On Letter with 0.4 in margins the page is 739 px across: the printed thing fits inside it, nothing else prints, and a
// browser in dark mode prints the light palette.
export async function printChecks(page, assert, sel) {
  for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width: 739, height: 1000 });
    await page.emulateMedia({ media: 'print', colorScheme });
    const p = await page.evaluate(sel => ({
      right: Math.max(...[...document.querySelectorAll(sel)].map(c => c.getBoundingClientRect().right)),
      shown: ['header.top', '#edit-link', '#demo-note', '.no-print', '.sync', '.jd-foot'].filter(s => [...document.querySelectorAll(s)].some(el => el.getClientRects().length)),
      ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(), bg: getComputedStyle(document.body).backgroundColor }), sel);
    assert.ok(p.right > 0 && p.right <= 739, `${colorScheme}: ${sel} reaches ${Math.round(p.right)} px of the 739 px printable width`);
    assert.deepEqual(p.shown, [], `${colorScheme}: printed beside the ${sel}`);
    assert.deepEqual([p.ink, p.bg], ['#000', 'rgb(255, 255, 255)'], `${colorScheme}: not the light palette in print`);
  }
  await page.emulateMedia({ media: null, colorScheme: null });
  await page.setViewportSize({ width: 390, height: 844 });
}
