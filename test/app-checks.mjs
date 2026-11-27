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
// the script); L.hang: Google takes each request and never answers (one bar); L.emailed: what a report's answer says. The service worker is off, so every request reaches the routes.
async function phone(browser, base, { published = true, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block' });
  const L = { down: false, delay: 0, hang: false, held: [], emailed: true, reports: [], puts: [], site: structuredClone(SAMPLE['placard.site']) };
  if (published) await ctx.route(base + 'js/config.js', async r => r.fulfill({ contentType: 'text/javascript',
    body: (await readFile(join(root, 'js/config.js'), 'utf8')).replace("LEDGER_URL = ''", `LEDGER_URL = '${LEDGER}'`) }));
  await ctx.route('https://script.google.com/**', async r => {
    if (L.hang) { await new Promise(res => L.held.push(res)); return r.abort().catch(() => {}); }   // taken, never answered
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
  const unhang = () => { L.hang = false; L.held.splice(0).forEach(res => res()); };
  try {
    // nothing kept yet and Google never answering (one bar): after 12 s the page says there's no connection
    L.hang = true;
    await page.goto(base + '#water-heater');
    await page.waitForSelector('text=No connection.', { timeout: 16000 });
    unhang();
    // nothing kept yet and the ledger slow to answer: the page says it's loading, then fills in
    L.delay = 2500;
    await page.reload();
    await page.waitForTimeout(600);
    assert.match(await text('#app'), /^Loading the house manual…/, 'a first tap shows a blank page while the ledger wakes up');
    await page.waitForSelector('.tape >> text=Water heater', { timeout: 8000 });
    L.delay = 0;
    // the report form: an urgent line with the number to call, and the field only robots fill in, out of sight
    await page.click('text=Report a problem or log a visit');
    assert.equal(await text('dialog[open] .call-now'), 'Urgent? Call 555-0142 now.');
    assert.equal(await page.locator('dialog[open] a.call-now').getAttribute('href'), 'tel:5550142');
    // all of the amber band dials, not just its words: at least 44 px tall and as wide as the form
    const band = await page.locator('dialog[open] a.call-now').evaluate(el => { const r = el.getBoundingClientRect(), f = el.closest('form').getBoundingClientRect(); return [r.height >= 44, Math.abs(r.width - f.width) < 1]; });
    assert.deepEqual(band, [true, true], 'the urgent line\'s call link is smaller than the band');
    const trap = await page.locator('dialog[open] #f-website').evaluate(el => ({ tab: el.tabIndex, auto: el.autocomplete, name: el.name,
      hidden: el.closest('[aria-hidden="true"]') !== null, off: el.getBoundingClientRect().right <= 0 }));
    assert.deepEqual(trap, { tab: -1, auto: 'off', name: 'website', hidden: true, off: true }, 'the robot field is missing or in sight');
    // sent on one bar that then drops: Send waits, and nothing typed is lost
    L.delay = 1200; L.down = true;
    await page.fill('dialog[open] #f-text', 'Water on the floor under the tank');
    await page.fill('dialog[open] #f-name', 'Pat');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator('dialog[open] button[type=submit]').evaluate(b => [b.disabled, b.textContent]), [true, 'Sending…'], 'Send isn\'t held while it sends');
    await page.waitForSelector('dialog[open] .msg.bad');
    assert.equal(await text('dialog[open] .msg.bad'), 'Couldn\'t send it. Your message is kept: try again, or call.');
    assert.equal(await page.inputValue('dialog[open] #f-text'), 'Water on the floor under the tank', 'a failed send threw the text away');
    assert.equal(await page.locator('dialog[open] a.sms').getAttribute('href'), 'sms:5550142?&body=' + encodeURIComponent('Water heater: Water on the floor under the tank (Pat)'));
    assert.equal(await page.locator('dialog[open] button[type=submit]').evaluate(b => b.disabled), false, 'Send stays off after a failure');
    // closed, and the page opened again later: the form comes back with what was typed
    await page.click('dialog[open] >> text=Cancel');
    await page.reload();
    await page.waitForSelector('.tape >> text=Water heater');
    await page.click('text=Report a problem or log a visit');
    assert.deepEqual([await page.inputValue('dialog[open] #f-text'), await page.inputValue('dialog[open] #f-name')], ['Water on the floor under the tank', 'Pat'], 'the unsent report was lost');
    // on one bar that never answers: after 20 s it says so, keeps the text and offers Text it instead
    L.delay = 0; L.down = false; L.hang = true;
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('dialog[open] .msg.bad', { timeout: 25000 });
    assert.equal(await text('dialog[open] .msg.bad'), 'Couldn\'t send it. Your message is kept: try again, or call.');
    assert.equal(await page.locator('dialog[open] a.sms').isVisible(), true);
    assert.equal(await page.inputValue('dialog[open] #f-text'), 'Water on the floor under the tank');
    unhang();
    // the signal is back: it goes, the form closes, and a line stays on the page
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Sent. The owner gets it by email.');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.match(await text('.sent'), /^Sent to the owner at \d{1,2}:\d\d [ap]m\.$/);
    assert.deepEqual(L.reports.map(r => [r.system, r.text, r.name, r.website]), [['water-heater', 'Water on the floor under the tank', 'Pat', '']]);
    assert.equal(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('placard.draft') || '{}')['water-heater'] || null)), 'null', 'the draft was kept after it sent');
    await page.click('text=Report a problem or log a visit');
    assert.equal(await page.inputValue('dialog[open] #f-text'), '', 'the sent report came back in the form');
    await page.click('dialog[open] >> text=Cancel');
    // the front page has the form too; when the ledger kept it but couldn't email, it says to call if it's urgent
    await page.goto(base + '#');
    await page.waitForSelector('.urgent-tile');
    L.emailed = false;
    await page.click('text=Report a problem');
    await page.fill('dialog[open] #f-text', 'The porch light is out.');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Saved for the owner. If it\'s urgent, call.');
    assert.match(await text('.sent'), /^Saved for the owner at \d{1,2}:\d\d [ap]m\. If it's urgent, call\.$/);
    assert.deepEqual([L.reports[1].system, L.reports[1].text], ['', 'The porch light is out.']);
    // a sticker whose page was deleted still helps: who to call, the form and the way to the front page
    await page.goto(base + '#old-boiler');
    await page.waitForSelector('text=This sticker\'s page isn\'t in the manual yet.');
    assert.equal(await page.locator('#app .contact a[href^="tel:"]').getAttribute('href'), 'tel:5550142');
    assert.equal(await page.locator('#app button', { hasText: 'Report a problem' }).count(), 1);
    assert.equal(await page.locator('#app a.btn[href="#"]').count(), 1, 'no way to the front page');
    // the front-door sticker (h/house, or h/home) opens the whole manual, not "isn't in the manual yet"
    for (const id of ['house', 'home']) {
      await page.goto(base + '#' + id);
      await page.waitForSelector('.urgent-tile');
      assert.equal(await page.locator('.urgent-tile').count(), 3, `#${id} isn't the front page`);
      assert.equal(await page.locator('text=This sticker\'s page isn\'t in the manual yet.').count(), 0);
    }
    assert.deepEqual(errors, [], 'errors on the tenant pages');
  } finally { await ctx.close(); }
}

// A tenant whose read fails: the page says so with a Try again button, and reads again by itself when the signal comes
// back; a phone with a copy shows it, says how old it is, and the line goes after the next good read.
export async function retryChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  // no signal as the phone sees it: navigator.onLine follows test.offline
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !localStorage.getItem('test.offline') }));
  const offline = on => page.evaluate(on => { if (on) localStorage.setItem('test.offline', '1'); else { localStorage.removeItem('test.offline'); dispatchEvent(new Event('online')); } }, on);
  const text = sel => page.locator(sel).evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  try {
    // a first visit with no signal: No connection, and a Try again a thumb can hit
    L.down = true;
    await page.goto(base + '#water-heater');
    await offline(true);
    await page.waitForSelector('text=No connection.');
    const again = page.locator('#app button', { hasText: 'Try again' });
    assert.ok((await again.boundingBox())?.height >= 44, 'no Try again button, or one too small to tap');
    // the signal comes back: the page loads by itself, with no reload
    L.down = false;
    const t0 = Date.now();
    await offline(false);
    await page.waitForSelector('.tape >> text=Water heater', { timeout: 2000 });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(await page.locator('.stale').count(), 0);
    // the copy kept, and opened again a few days later with no signal: it shows, and says when it was saved
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const was = new Date(Date.now() - 3 * 86400000), when = MON[was.getMonth()] + ' ' + was.getDate() + (was.getFullYear() === new Date().getFullYear() ? '' : ', ' + was.getFullYear());
    await page.evaluate(at => { const k = JSON.parse(localStorage.getItem('placard.public')); localStorage.setItem('placard.public', JSON.stringify({ ...k, at })); }, was.getTime());
    L.down = true;
    await offline(true);
    await page.reload();
    await page.waitForSelector('.stale');
    assert.equal(await text('.stale p'), `No signal. This is the copy saved ${when}. A number may have changed since.`);
    assert.equal(await page.locator('.tape').textContent(), 'Water heater', 'the kept copy isn\'t shown');
    // the manager changed the number meanwhile; back in signal, the line goes and the new number shows
    L.site[0] = { ...L.site[0], contact: { ...L.site[0].contact, phone: '555-0999' } };
    L.down = false;
    await offline(false);
    await page.waitForFunction(() => !document.querySelector('.stale'), null, { timeout: 2000 });
    assert.equal(await page.locator('.contact a[href^="tel:"]').getAttribute('href'), 'tel:5550999');
    // Try again on its own, with no online event: a first visit, then the signal back and a press
    await page.evaluate(() => localStorage.removeItem('placard.public'));
    L.down = true;
    await page.reload();
    await page.waitForSelector('text=No connection.');
    L.down = false;
    await page.click('#app button >> text=Try again');
    await page.waitForSelector('.tape >> text=Water heater', { timeout: 4000 });
    assert.deepEqual(errors, [], 'errors while the manual was retried');
  } finally { await ctx.close(); }
}

// The owner, connected (not the sample): the status line on every page, whether a save has reached tenants, and the
// guide part that puts the ledger address in js/config.js.
export async function ownerChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base, { published: false });
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  await ctx.addInitScript(fakeNfc);
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
    // write and lock the sticker; the page saves and draws again, and the next step stays on screen under the state
    await page.click('text=Write sticker');
    await page.waitForFunction(() => window.__nfc.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__nfc.writes), ['https://tag.junkdrawer.works/h/water-heater']);
    const said = () => page.locator('.nfc > .msg:last-child').textContent();
    const state = () => page.locator('.nfc .state').textContent();
    await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.nfc .state')?.textContent));
    assert.equal(await said(), 'Written. Tap it with the phone to check, then lock it.');
    assert.equal(await page.locator('.nfc .msg.sample').count(), 0, 'the sample\'s lines on the owner\'s own manual');
    await page.click('text=Lock sticker');
    await page.click('dialog >> text=Lock it');
    await page.waitForFunction(() => window.__nfc.locks === 1);
    // locked: no Write or Lock to press by mistake, and where a change of address is made instead
    await page.waitForFunction(() => /^Locked /.test(document.querySelector('.nfc .state')?.textContent));
    assert.match(await state(), /^Locked [A-Z][a-z]{2} \d{1,2}, \d{4}\. To send it somewhere else, use Switchboard\.$/);
    assert.equal(await page.locator('.nfc button', { hasText: /Write sticker|Lock sticker/ }).count(), 0, 'Write and Lock offered for a locked sticker');
    assert.equal(await said(), 'Locked. It will open this page for good.');
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    assert.ok(L.puts.at(-1).locked, 'the lock was not saved');
    // a replacement (or a spare) for a locked sticker: a new one for the same page, written and not locked until it is
    await page.click('.nfc >> text=Replace or make a spare');
    await page.waitForSelector('.nfc >> text=Use a new blank sticker. The old one, wherever it is, keeps opening this page.');
    await page.click('.nfc >> text=Write sticker');
    await page.waitForFunction(() => window.__nfc.writes.length === 2);
    await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.nfc .state')?.textContent));
    assert.equal(await page.evaluate(() => window.__placard.ledger.doc('site', 'water-heater').locked), null);
    assert.equal(await said(), 'Written. Tap it with the phone to check, then lock it.');
    assert.equal(await page.locator('.nfc button', { hasText: 'Lock sticker' }).count(), 1);
    // the front page's own sticker: h/house opens the whole manual, so the owner gets no Make this page there (it
    // would save a page over the house's title, contact and notes), and writes and locks it from the Edit screen
    await page.goto(base + '#house');
    await page.waitForSelector('.urgent-tile');
    assert.equal(await page.locator('text=Make this page').count(), 0, 'Make this page offered for the front page');
    await page.goto(base + '#/owner');
    const front = page.locator('.front-tag');
    assert.equal(await front.locator('.url').textContent(), 'https://tag.junkdrawer.works/h/house');
    await front.locator('text=Write sticker').click();
    await page.waitForFunction(() => window.__nfc.writes.length === 3);
    await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.front-tag .state')?.textContent));
    await front.locator('text=Lock sticker').click();
    await page.click('dialog >> text=Lock it');
    await page.waitForFunction(() => window.__nfc.locks === 2);
    await page.waitForFunction(() => /^Locked /.test(document.querySelector('.front-tag .state')?.textContent));
    const hs = await page.evaluate(() => window.__placard.ledger.doc('site', 'house'));
    assert.ok(hs.tagged && hs.locked, 'the front page sticker was not saved as written and locked');
    assert.deepEqual([hs.title, hs.contact?.phone, hs.notes], [SAMPLE['placard.site'][0].title, '555-0142', SAMPLE['placard.site'][0].notes], 'the house page lost its title, contact or notes');
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    assert.ok(L.puts.at(-1).id === 'house' && L.puts.at(-1).locked, 'the lock never reached the ledger');
    assert.deepEqual(errors, [], 'errors on the owner pages');
  } finally { await ctx.close(); }
}

// A second owner device (the laptop), connected while Google takes 3 s to answer its first list: Add a system, House
// and contact and Import wait for it, and then the usual list leaves out the pages the sheet already has.
export async function secondOwnerChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base, { published: false });
  await ctx.addInitScript(u => { try { localStorage.getItem('placard.ledger') || localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })); } catch {} }, LEDGER);
  try {
    L.delay = 3000;
    await page.goto(base + '#/owner');
    await page.waitForSelector('#app .empty >> text=Loading…');
    const off = () => page.locator('#app > .btns button').evaluateAll(bs => bs.map(b => [b.textContent, b.disabled]));
    assert.deepEqual(await off(), [['House and contact', true], ['Add a system', true], ['Import', true]], 'a new page offered before the ledger answered');
    await page.goto(base + '#attic');
    assert.equal(await page.locator('text=Make this page').count(), 0, 'Make this page offered before the ledger answered');
    await page.goto(base + '#/owner');
    await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Up to date', null, { timeout: 10000 });
    await page.locator('#app button:enabled', { hasText: 'Add a system' }).waitFor({ timeout: 2000 });
    assert.deepEqual(await off(), [['House and contact', false], ['Add a system', false], ['Import', false]]);
    L.delay = 0;
    await page.click('text=Add a system');
    const offered = await page.locator('dialog[open] #f-pick option').evaluateAll(os => os.map(o => o.value));
    assert.ok(!offered.includes('water-shutoff') && offered.includes('well-tank'), 'the usual list offers a page the sheet already has');
    await page.selectOption('dialog[open] #f-pick', 'well-tank');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.tape >> text=Well pressure tank');
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    assert.deepEqual(L.puts.map(d => d.id), ['well-tank'], 'a page already on the sheet was saved over');
    // a sheet opened, then the copy forgotten before Add: nothing is saved from nothing
    await page.goto(base + '#/owner');
    await page.click('text=Add a system');
    await page.waitForSelector('dialog[open]');
    await page.evaluate(() => { const m = window.__placard.ledger.m('site'); m.since = 0; m.listed = false; });
    await page.selectOption('dialog[open] #f-pick', 'septic');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Still loading from the ledger. Try again in a moment.');
    assert.deepEqual(L.puts.map(d => d.id), ['well-tank']);
    assert.deepEqual(errors, [], 'errors on the second owner device');
  } finally { await ctx.close(); }
}

// Records typed into the sheet by hand, or from an old import: two with no name and no order, one in a group that isn't
// one of the six, one whose details aren't a list. The tenant's front page and the owner's list still draw, each page
// is listed (an odd group under Everything else), and editing the odd group's page keeps its group.
const ODD = [{ id: 'attic', where: 'Hall closet hatch' }, { id: 'crawl-space', where: 'Under the porch' },
  { id: 'boiler', name: 'Boiler', kind: 'heating', order: 16, where: 'Basement', summary: 'Heats the radiators.' }, { id: 'shed', name: 'Shed', facts: 'Lock: blue', order: '7' }];
export async function oddRecordChecks({ browser, base, assert }) {
  for (const who of ['tenant', 'owner']) {
    const { ctx, L, errors, page } = await phone(browser, base, { published: who === 'tenant' });
    L.site.push(...structuredClone(ODD));
    L.site[0].contact.phone = '845-555-0100 ext. 12';   // an extension: Call dials the number, and shows all of it
    // a page half filled in (a detail still blank, a line with no label, a service number) and one with only its name
    Object.assign(L.site.find(d => d.id === 'air-handler-up'), { care: 'Filters from https://example.com/filters.', facts: [['Filter', ''], ['Changed', 'Every 3 months'],
      ['', 'Spare filters are on the shelf beside it'], ['Service', 'Acme Heating 555-0123']] });
    L.site.push({ id: 'trash', name: 'Trash and recycling', kind: 'other', order: 30 });
    if (who === 'owner') await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
    const rows = () => page.locator('.list .row .t').allTextContents();
    try {
      await page.goto(base + (who === 'owner' ? '#/owner' : ''));
      await page.waitForSelector('.list .row', { timeout: 8000 });
      const all = await rows();
      for (const name of ['Attic', 'Crawl space', 'Boiler', 'Shed', 'Water heater']) assert.ok(all.includes(name), `${who}: "${name}" isn't listed (${all.join(', ')})`);
      if (who === 'tenant') {
        assert.deepEqual(await page.locator('.contact .btns a').evaluateAll(as => as.map(a => [a.textContent, a.getAttribute('href')])),
          [['Call 845-555-0100 ext. 12', 'tel:8455550100'], ['Text', 'sms:8455550100'], ['Email', 'mailto:help@example.com']], 'the extension was dialled as part of the number');
        await page.click('text=Report a problem');
        assert.equal(await page.locator('dialog[open] a.call-now').getAttribute('href'), 'tel:8455550100');
        await page.click('dialog[open] >> text=Cancel');
        const other = await page.locator('section', { has: page.locator('h2', { hasText: 'Everything else' }) }).locator('.row .t').allTextContents();
        assert.deepEqual(other.sort(), ['Attic', 'Boiler', 'Crawl space', 'Shed', 'Trash and recycling'], 'a page in a group Placard doesn\'t know isn\'t listed');
        await page.goto(base + '#attic');
        await page.waitForSelector('.tape >> text=Attic');
        await page.goto(base + '#shed');
        await page.waitForSelector('.tape >> text=Shed');
        // a blank detail isn't shown to a tenant, a line with no label takes the whole row, and numbers and links tap
        await page.goto(base + '#air-handler-up');
        await page.waitForSelector('.facts');
        assert.deepEqual(await page.locator('.facts dt').allTextContents(), ['Changed', 'Service'], 'a blank detail, or a "·" label, on the tenant\'s page');
        assert.equal(await page.locator('.facts dd.whole').textContent(), 'Spare filters are on the shelf beside it');
        assert.deepEqual(await page.locator('#app a[href^="tel:"]').evaluateAll(as => as.map(a => [a.textContent, a.getAttribute('href')])).then(l => l[0]), ['555-0123', 'tel:5550123'], 'the service number isn\'t a link');
        assert.equal(await page.locator('#app a[href="https://example.com/filters"]').textContent(), 'https://example.com/filters');
        await page.goto(base + '#trash');
        await page.waitForSelector('.tape >> text=Trash and recycling');
        assert.equal(await page.locator('#app .empty').textContent(), 'Nothing written here yet. Call or report below.');
        // the sample's numbers that aren't phone numbers stay text: a model, a year, breakers, a valve, a filter size
        for (const id of ['water-heater', 'water-shutoff', 'panel-main']) {
          await page.goto(base + '#' + id);
          await page.waitForSelector('.facts');
          assert.equal(await page.locator('main a[href^="tel:"]:not(.btn)').count(), 0, `a number on ${id} became a phone link`);
        }
      } else {
        // the owner sees which pages still have blank details, and the blank lines themselves, to fill in
        assert.equal(await page.locator('.row', { hasText: 'Air handler, upstairs' }).locator('.chip', { hasText: 'blank details' }).count(), 1, 'no "blank details" in the owner list');
        assert.equal(await page.locator('.row', { hasText: 'Water heater' }).locator('.chip', { hasText: 'blank details' }).count(), 0);
        await page.goto(base + '#air-handler-up');
        await page.waitForSelector('.facts');
        assert.deepEqual(await page.locator('.facts dt').allTextContents(), ['Filter', 'Changed', 'Service']);
        assert.equal(await page.locator('.facts dd.blank').textContent(), 'to fill in');
        await page.goto(base + '#boiler');
        await page.click('text=Edit this page');
        assert.equal(await page.locator('#f-kind').evaluate(s => s.value), 'heating', 'Edit shows another group for the page');
        await page.fill('#f-where', 'Basement, back corner');
        await page.click('dialog[open] button[type=submit]');
        await page.waitForSelector('.where >> text=back corner');
        await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
        assert.deepEqual([L.puts.at(-1).id, L.puts.at(-1).kind], ['boiler', 'heating'], 'a Where change saved the page in another group');
      }
      assert.deepEqual(errors, [], `errors with odd records (${who})`);
    } finally { await ctx.close(); }
  }
}

export async function appChecks({ page, ctx, base, assert }) {
  await tenantChecks({ browser: ctx.browser(), base, assert });
  await ownerChecks({ browser: ctx.browser(), base, assert });
  await secondOwnerChecks({ browser: ctx.browser(), base, assert });
  await oddRecordChecks({ browser: ctx.browser(), base, assert });
  await retryChecks({ browser: ctx.browser(), base, assert });
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
  // owner, in the sample: Write writes a real sticker (and says so), but Lock is off, since it can't be undone
  await page.click('text=Write sticker');
  await page.waitForFunction(() => window.__nfc.writes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__nfc.writes), ['https://tag.junkdrawer.works/h/water-heater']);
  await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.nfc .state')?.textContent));
  assert.equal(await page.locator('.nfc > .msg:last-child').textContent(), 'Written. Tap it with the phone to check it opens this page.');
  assert.deepEqual(await page.locator('.nfc .msg.sample').allTextContents(),
    ['This writes a real sticker with the sample\'s link.', 'Locking is off in the sample: it can\'t be undone.']);
  const lockBtn = page.locator('.nfc button', { hasText: 'Lock sticker' });
  assert.equal(await lockBtn.isDisabled(), true, 'Lock sticker offered in the sample');
  await lockBtn.click({ force: true });
  await page.waitForTimeout(300);
  assert.deepEqual([await page.evaluate(() => window.__nfc.locks), await page.locator('dialog[open]').count()], [0, 0], 'the sample locked a real sticker');
  // the way out of the sample is in its note
  assert.equal(await page.locator('#demo-note a.sample-out').getAttribute('href'), './');
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
  // a page that doesn't fit is deleted, then an updated import file comes (blank Where lines and contact, new details):
  // it fills in, never blanks or replaces what's here, and the deleted page stays deleted; twice over, nothing changes
  await page.evaluate(() => { location.hash = '#smoke-co'; });
  await page.click('text=Edit this page');
  await page.click('dialog[open] >> text=Delete');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForSelector('h2 >> text=Edit the manual');
  const file = { docs: [{ id: 'house', title: 'House manual', intro: '', contact: { name: '', phone: '', email: '', note: '' }, notes: '' },
    { id: 'water-heater', name: 'Water heater', kind: 'water', order: 2, where: '', facts: [['Model', 'XE50T10'], ['Installed', '2019'], ['Anode', 'Checked 2025']] },
    { id: 'smoke-co', name: 'Smoke and CO alarms', kind: 'safety', emergency: true, where: '' }, { id: 'garage-door', name: 'Garage door opener', kind: 'other', order: 9 },
    { id: 'Back Door', name: 'Back door' }] };
  for (const said of ['Added 1 page, filled in 1, kept your edits; left out 1 you deleted; skipped 1 (id "Back Door").',
    'Nothing new in the file; your edits stay; left out 1 you deleted; skipped 1 (id "Back Door").']) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Import')]);
    await chooser.setFiles({ name: 'placard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await page.waitForSelector(`.toast.show >> text=${said}`);
  }
  const doc = id => page.evaluate(id => window.__placard.ledger.doc('site', id), id);
  assert.equal((await doc('house')).contact.phone, '555-0142', 'the contact card was emptied');
  const wh = await doc('water-heater');
  assert.equal(wh.where, 'Basement, under the stairs.', 'the Where line was blanked');
  assert.deepEqual(wh.facts, [['Make', 'Rheem'], ['Model', 'XE50T10'], ['Installed', '2020'], ['Breakers', '21 and 23'], ['Anode', 'Checked 2025']]);
  assert.equal(await doc('smoke-co'), null, 'a deleted page came back');
  assert.equal((await doc('garage-door')).name, 'Garage door opener');
  assert.equal(await page.locator('.list .row', { hasText: 'Smoke and CO alarms' }).count(), 0);
  // the owner list shows it written and locked, the QR sheet has every page, the report is there to handle
  await page.goto(base + '?demo#/owner');
  await page.waitForSelector('.row');
  assert.equal(await page.locator('.list .row').count(), 5);
  assert.equal(await page.locator('.list .row', { hasText: 'Water heater' }).locator('.chip').textContent(), 'written');
  await page.goto(base + '?demo#/print');
  await page.waitForSelector('.qr-card svg');
  // one card per page, and first the front page's, for inside the front door
  assert.equal(await page.locator('.qr-card').count(), 5 + 1);
  assert.equal(await page.locator('.qr-card').first().locator('b').textContent(), 'House manual');
  assert.equal(await page.locator('.qr-card').first().locator('span').textContent(), 'Tap or scan for the whole manual.');
  assert.equal(await page.locator('.qr-card .qr').first().getAttribute('data-url'), 'https://tag.junkdrawer.works/h/house');
  await printChecks(page, assert, '.qr-card');
  await page.goto(base + '?demo#/reports');
  await page.click('text=Mark handled');
  await page.waitForSelector('.report.dim');
  assert.ok(await page.locator('.report.dim').evaluate(el => Number(getComputedStyle(el).opacity)) < 1, 'a handled report isn\'t greyed out');
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
