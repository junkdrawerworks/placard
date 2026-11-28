// Placard's own checks, run by test/e2e.mjs on a phone-sized page.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE, STARTER } from '../js/starter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'https://script.google.com/macros/s/AKfyTEST/exec';
// A pretend Chrome NFC reader with one sticker held against the phone (__nfc.sticker: a blank one to start with). A scan
// reads it at once; a write that mustn't write over anything is turned down (NotAllowedError) by a sticker holding a
// link, and every write on a locked one fails as Chrome's IO error (NetworkError); a lock locks it. As in Chrome, a
// write turned down or failed lets go of the sticker (__nfc.held false): a scan reads nothing, and a write waits, until
// __nfc.hold(url, locked, serial) brings a sticker near again. hold() is also how another sticker is put there.
const fakeNfc = () => {
  window.__nfc = { writes: [], locks: 0, sticker: { url: '', locked: false, serial: '04:5e' }, held: true, scans: [], waiting: null };
  window.__nfc.hold = (url = '', locked = false, serial = '04:5e') => {
    const n = window.__nfc;
    n.sticker = { url, locked, serial }; n.held = true;
    for (const s of n.scans.splice(0)) if (!s.signal?.aborted) s.read();
    const w = n.waiting; n.waiting = null; w?.();
  };
  window.NDEFReader = class {
    async write(msg, { overwrite = true } = {}) {
      const n = window.__nfc;
      if (!n.held) await new Promise(res => { n.waiting = res; });
      const s = n.sticker;
      if (!overwrite && s.url) { n.held = false; throw new DOMException('NDEFWriteOptions#overwrite does not allow overwrite.', 'NotAllowedError'); }
      if (s.locked) { n.held = false; throw new DOMException('Failed to write due to an IO error: null', 'NetworkError'); }
      n.writes.push(msg.records[0].data);
      s.url = msg.records[0].data;
    }
    async makeReadOnly() { window.__nfc.locks++; window.__nfc.sticker.locked = true; }
    async scan({ signal } = {}) {
      const n = window.__nfc;
      const read = () => { const { url, serial } = n.sticker; this.onreading?.({ serialNumber: serial, message: { records: url ? [{ recordType: 'url', data: new TextEncoder().encode(url) }] : [] } }); };
      if (n.held) setTimeout(() => { if (!signal?.aborted) read(); }, 20);
      else n.scans.push({ signal, read });
    }
  };
};
// A phone on a published manual: js/config.js as served carries a ledger address (published: true), and a pretend
// ledger answers it with the sample house. L.down: every request fails; L.delay: each waits that long (Google waking
// the script); L.hang: Google takes each request and never answers (one bar); L.emailed: what a report's answer says;
// L.dropPub: how many of the next tenant reads (pub) drop their connection; L.pubGone: the manual's tab renamed or
// deleted in the sheet (the ledger says so); L.repeat: a report's answer says the same
// words went from that page at this time (an ISO string), as the ledger does for a second send within the hour, and
// L.firstEmailed whether that first one was emailed. The service worker is off, so every request reaches the routes.
// published: the address put in js/config.js (true: LEDGER). OTHER is another deployment that answers with the same
// pages; any other script.google.com address answers 404, as a mistyped or archived one does.
const OTHER = 'https://script.google.com/macros/s/AKfyOTHER/exec';
// js/config.js as served, with url in place of whatever address the file holds.
const configAs = url => async r => r.fulfill({ contentType: 'text/javascript',
  body: (await readFile(join(root, 'js/config.js'), 'utf8')).replace(/LEDGER_URL = '[^']*'/, `LEDGER_URL = '${url}'`) });
// The same through the test's own server, for the page the offline checks use: its answer as it is (its ETag, held or
// dropped with the rest, a next release's changes), with the address swapped.
const configThrough = url => async r => {
  let res;
  try { res = await r.fetch(); } catch { return r.abort('internetdisconnected').catch(() => {}); }
  if (res.status() !== 200) return r.fulfill({ response: res });
  return r.fulfill({ response: res, body: (await res.text()).replace(/LEDGER_URL = '[^']*'/, `LEDGER_URL = '${url}'`) });
};
async function phone(browser, base, { published = true, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block' });
  const L = { down: false, delay: 0, hang: false, held: [], emailed: true, dropPub: 0, reports: [], puts: [], site: structuredClone(SAMPLE['placard.site']) };
  // whatever address js/config.js holds (empty quotes, or the owner's own once it's published), this phone gets the
  // test's: LEDGER, another, or none (published false)
  await ctx.route(base + 'js/config.js', configAs(published === true ? LEDGER : published || ''));
  await ctx.route('https://script.google.com/**', async r => {
    if (L.hang) { await new Promise(res => L.held.push(res)); return r.abort().catch(() => {}); }   // taken, never answered
    if (L.delay) await new Promise(res => setTimeout(res, L.delay));
    if (L.down) return r.abort('internetdisconnected');
    const req = r.request(), json = o => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (!req.url().startsWith(LEDGER) && !req.url().startsWith(OTHER)) return r.fulfill({ status: 404, contentType: 'text/html', body: '<!DOCTYPE html><title>Page Not Found</title>' });
    if (req.method() === 'GET' && L.dropPub > 0 && new URL(req.url()).searchParams.get('op') === 'pub') { L.dropPub--; return r.abort('connectionreset'); }
    if (req.method() === 'GET' && L.pubGone && new URL(req.url()).searchParams.get('op') === 'pub') return json({ ok: false, error: 'the sheet has no placard.site tab' });
    if (req.method() === 'GET') return json(new URL(req.url()).searchParams.get('op') === 'pub' ? { ok: true, docs: L.site } : { ok: true, app: 'switchboard-ledger', version: '1.1' });
    const b = JSON.parse(req.postData() || '{}');
    if (b.op === 'report') { L.reports.push(b.doc); return json(L.repeat ? { ok: true, emailed: false, repeat: true, firstAt: L.repeat, ...(L.firstEmailed != null ? { firstEmailed: L.firstEmailed } : {}) } : { ok: true, emailed: L.emailed }); }
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
    // and on the way, after 6 s, that it's taking longer than usual
    await page.waitForTimeout(3000);
    assert.equal(await text('#app'), 'Loading the house manual… The first time takes a few seconds.');
    await page.waitForTimeout(4000);
    assert.equal(await text('#app'), 'Loading the house manual… The first time takes a few seconds. Taking longer than usual.');
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
    // the same words again within the hour: kept, not emailed twice, and the page says when the first went
    L.emailed = true; L.repeat = new Date(Date.UTC(2026, 10, 27, 7, 19)).toISOString();
    await page.click('text=Report a problem');
    await page.fill('dialog[open] #f-text', 'The porch light is out.');
    await page.click('dialog[open] button[type=submit]');
    const first = await page.evaluate(iso => { const d = new Date(iso); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`; }, L.repeat);
    await page.waitForSelector(`.toast.show >> text=Already sent at ${first}. If it's urgent, call.`);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await text('.sent'), `Already sent at ${first}. If it's urgent, call.`);
    assert.equal(L.reports.length, 3);
    // and when that first one was only kept, never emailed (the day's 20 used up), the page doesn't say it went
    L.firstEmailed = false;
    await page.click('text=Report a problem');
    await page.fill('dialog[open] #f-text', 'The porch light is out.');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector(`.toast.show >> text=Already saved at ${first}, but it wasn't emailed. If it's urgent, call.`);
    assert.equal(await text('.sent'), `Already saved at ${first}, but it wasn't emailed. If it's urgent, call.`);
    L.repeat = null; L.firstEmailed = null;
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
// A fire or a CO alarm: 911 first. The front page's In an emergency starts with a fixed 911 line, and so does an
// emergency page in the Safety group, whose report form's urgent line then says 911; every other page, an emergency one
// elsewhere included, keeps the house contact's number. The line is a 44 px band that dials 911 all over.
export async function fireChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  const text = sel => page.locator(sel).first().evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  const FIRE = 'Fire, smoke or a CO alarm: get everyone out, then call 911.';
  const urgent = async () => { await page.click('text=Report a problem'); const u = [await text('dialog[open] .call-now'), await page.locator('dialog[open] a.call-now').getAttribute('href')];
    await page.click('dialog[open] >> text=Cancel'); await page.waitForSelector('dialog[open]', { state: 'detached' }); return u; };
  try {
    await page.goto(base);
    await page.waitForSelector('.urgent-tile');
    // at the top of In an emergency, before the tiles
    assert.deepEqual(await page.locator('section.sos').evaluate(s => [...s.children].map(c => c.tagName + (c.className ? '.' + c.className.split(' ').join('.') : ''))),
      ['H2', 'A.notice.bad.call-now.call-911', 'DIV.urgent']);
    assert.equal(await text('section.sos .call-911'), FIRE);
    assert.equal(await page.locator('section.sos .call-911').getAttribute('href'), 'tel:911');
    const band = await page.locator('section.sos .call-911').evaluate(el => [el.getBoundingClientRect().height >= 44, el.getBoundingClientRect().width === el.parentElement.getBoundingClientRect().width]);
    assert.deepEqual(band, [true, true], 'the 911 line isn\'t a band that dials all over');
    assert.deepEqual(await urgent(), ['Urgent? Call 555-0142 now.', 'tel:5550142'], 'the front page\'s report form');
    // the smoke and CO alarms (Safety, emergency): the line under the name, and 911 in the report form
    await page.goto(base + '#smoke-co');
    await page.waitForSelector('.tape >> text=Smoke and CO alarms');
    assert.equal(await page.locator('.tape-wrap + a.call-911').count(), 1, 'no 911 line under the page\'s name');
    assert.equal(await text('a.call-911'), FIRE);
    assert.deepEqual(await urgent(), ['Urgent? Call 911 now.', 'tel:911'], 'the alarm page\'s report form');
    // its placeholder keeps the page's capitals: CO stays CO
    await page.click('text=Report a problem');
    assert.equal(await page.locator('dialog[open] #f-text').getAttribute('placeholder'), 'About the smoke and CO alarms…');
    await page.click('dialog[open] >> text=Cancel');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    // an emergency page in another group, and a page that isn't one: the house number, and no 911 line
    for (const [id, name] of [['panel-main', 'Main electrical panel'], ['water-heater', 'Water heater']]) {
      await page.goto(base + '#' + id);
      await page.waitForSelector(`.tape >> text=${name}`);
      assert.equal(await page.locator('a.call-911').count(), 0, `a 911 line on ${name}`);
      assert.deepEqual(await urgent(), ['Urgent? Call 555-0142 now.', 'tel:5550142'], name);
    }
    // a manual with no phone number for the house: the alarm page's form still says 911, the others have no urgent line
    L.site = L.site.map(d => d.id === 'house' ? { ...d, contact: { name: 'Riverbend Property Care', email: 'help@example.com' } } : d);
    await page.evaluate(() => localStorage.clear());
    await page.goto(base + '#smoke-co'); await page.reload();
    await page.waitForSelector('.tape >> text=Smoke and CO alarms');
    assert.deepEqual(await urgent(), ['Urgent? Call 911 now.', 'tel:911'], 'no 911 line without a house phone');
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    await page.click('text=Report a problem');
    assert.equal(await page.locator('dialog[open] .call-now').count(), 0, 'an urgent line with no number to call');
    await page.click('dialog[open] >> text=Cancel');
    // a manual with pages but no emergency ones still has the line
    L.site = L.site.map(d => ({ ...d, emergency: false }));
    await page.evaluate(() => localStorage.clear());
    await page.goto(base); await page.reload();
    await page.waitForSelector('text=Water heater');
    assert.deepEqual([await page.locator('section.sos .call-911').count(), await page.locator('.urgent-tile').count()], [1, 0]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
}

// Other numbers: the house gets more than one number (the septic company, a backup), added from the Edit screen and shown
// under Who to call on the front page; a page can pick one for its card, which then names the house contact under it.
// A page that picked none, or whose number was deleted, shows the house contact as before; tenants see the same.
export async function numbersChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  const settled = () => page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
  const card = p => p.locator('.contact').evaluate(c => ({ who: [...c.querySelectorAll('.who')].map(e => e.textContent), heads: [...c.querySelectorAll('h3')].map(e => e.textContent),
    links: [...c.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href'), a.className]) }));
  try {
    await page.goto(base + '#/owner');
    await page.waitForSelector('section.numbers');
    assert.match(await page.locator('section.numbers p.muted').textContent(), /^The septic company, the power company's outage line/);
    // added: a phone number is needed
    await page.click('text=Add a number');
    await page.fill('#f-name', 'Hudson Septic');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('dialog[open] .sheet-msg >> text=Put in a phone number to call.');
    await page.fill('#f-phone', '845-555-0170');
    await page.fill('#f-note', 'The septic alarm sounds, or a drain backs up.');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('section.numbers .row');
    await settled();
    assert.deepEqual(L.puts.at(-1).numbers, [{ id: 'hudson-septic', name: 'Hudson Septic', phone: '845-555-0170', note: 'The septic alarm sounds, or a drain backs up.' }]);
    assert.equal(L.puts.at(-1).contact.phone, '555-0142', 'the house contact changed');
    await page.click('text=Add a number');
    await page.fill('#f-name', 'Backup: Lee');
    await page.fill('#f-phone', '555-0177');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('section.numbers .row').length === 2);
    // a page picks one for its card
    await page.goto(base + '#water-heater');
    await page.click('text=Edit this page');
    assert.deepEqual(await page.locator('#f-call option').allTextContents(), ['Who to call (Riverbend Property Care)', 'Hudson Septic', 'Backup: Lee']);
    assert.equal(await page.inputValue('#f-call'), '');
    await page.selectOption('#f-call', 'hudson-septic');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.contact .who')?.textContent === 'Hudson Septic');
    assert.deepEqual(await card(page), { who: ['Hudson Septic', 'Or Riverbend Property Care'], heads: [],
      links: [['Call 845-555-0170', 'tel:8455550170', 'btn'], ['Call 555-0142', 'tel:5550142', 'btn ghost'], ['Text', 'sms:5550142', 'btn ghost'], ['Email', 'mailto:help@example.com', 'btn ghost']] });
    // the report form's urgent line stays the house contact's
    await page.click('text=Report a problem or log a visit');
    assert.equal(await page.locator('dialog[open] .call-now').textContent(), 'Urgent? Call 555-0142 now.');
    await page.click('dialog[open] >> text=Cancel');
    await page.goto(base + '#/owner');
    await page.waitForSelector('section.numbers .row');
    assert.deepEqual(await page.locator('section.numbers .row .s').allTextContents(), ['845-555-0170 · on Water heater\'s card', '555-0177']);
    // the front page: the house contact, then the other numbers, each with when to call and Call
    await page.goto(base + '#');
    await page.waitForSelector('.contact h3');
    assert.deepEqual(await card(page), { who: ['Riverbend Property Care', 'Hudson Septic', 'Backup: Lee'], heads: ['Other numbers'],
      links: [['Call 555-0142', 'tel:5550142', 'btn'], ['Text', 'sms:5550142', 'btn ghost'], ['Email', 'mailto:help@example.com', 'btn ghost'],
        ['Call 845-555-0170', 'tel:8455550170', 'btn ghost'], ['Call 555-0177', 'tel:5550177', 'btn ghost']] });
    // a tenant sees the same
    await settled();
    const tenant = await phone(browser, base);
    tenant.L.site = L.site;
    await tenant.page.goto(base + '#water-heater');
    await tenant.page.waitForSelector('.contact .who');
    assert.deepEqual((await card(tenant.page)).who, ['Hudson Septic', 'Or Riverbend Property Care']);
    await tenant.page.goto(base);
    await tenant.page.waitForSelector('.contact h3');
    assert.deepEqual((await card(tenant.page)).who, ['Riverbend Property Care', 'Hudson Septic', 'Backup: Lee']);
    assert.deepEqual(tenant.errors, []);
    await tenant.ctx.close();
    // deleted: asked first, naming the page whose card goes back to the house contact
    await page.goto(base + '#/owner');
    await page.click('section.numbers .row >> text=Hudson Septic');
    await page.click('dialog[open] button.danger');
    const ask = page.getByRole('dialog', { name: 'Delete Hudson Septic?' });
    await ask.waitFor();
    assert.equal(await ask.locator('form > p').textContent(), 'Water heater will show Riverbend Property Care on its card instead.');
    await ask.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelectorAll('section.numbers .row').length === 1);
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.contact .who');
    assert.deepEqual((await card(page)).who, ['Riverbend Property Care']);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
}

// A photo on a page: a file in the repo's photos folder, named on the page, shown under Where and larger when tapped.
// The owner types its name (a link or a path is turned down), and is told when the file isn't there; a tenant just
// doesn't see one that isn't. After a tenant's good read every page's photo is kept by the service worker, so a page
// opened later with no signal still has its picture.
export async function photoChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  const shown = () => page.locator('figure.photo img').evaluate(i => i.complete && i.naturalWidth);
  try {
    await page.goto(base + '#water-shutoff');
    await page.waitForSelector('.tape >> text=Main water shutoff');
    // under Where, the sample's made-up picture at its full 1200 px
    assert.deepEqual(await page.locator('.where + figure.photo').count(), 1, 'the photo isn\'t under Where');
    await page.waitForFunction(() => document.querySelector('figure.photo img')?.naturalWidth > 0);
    assert.equal(await shown(), 1200);
    assert.deepEqual(await page.locator('figure.photo img').evaluate(i => [i.getAttribute('src'), i.alt]),
      ['photos/sample-shutoff.jpg', 'Main water shutoff: Basement, left of the pressure tank, at waist height.']);
    assert.ok((await page.locator('figure.photo').boundingBox()).width <= 358, 'the photo is wider than the page');
    // tapped: the whole picture, closed with Close, by a tap, or with Back (Escape)
    for (const close of ['Close', 'tap', 'Escape']) {
      await page.click('.photo-btn');
      const view = page.locator('dialog.photo-view[open]');
      await view.waitFor();
      assert.equal(await view.locator('img').getAttribute('src'), 'photos/sample-shutoff.jpg');
      if (close === 'Close') await view.locator('button', { hasText: 'Close' }).click();
      else if (close === 'tap') await view.locator('img').click();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.photo-view', { state: 'detached' });
    }
    // the owner names it: a link, or a path out of the folder, is turned down with the sheet kept open
    await page.click('text=Edit this page');
    assert.equal(await page.inputValue('#f-photo'), 'sample-shutoff.jpg');
    for (const bad of ['https://example.com/valve.jpg', '../js/app.js', 'valve.pdf', 'photos/sub/valve.jpg']) {
      await page.fill('#f-photo', bad);
      await page.click('dialog[open] button[type=submit]');
      await page.waitForSelector('dialog[open] .sheet-msg >> text=A photo is the name of a file in the photos folder, like water-shutoff.jpg (a .jpg, .png or .webp).');
    }
    // "photos/" typed before it is taken off; a file not in the repo says so, to the owner
    await page.fill('#f-photo', 'photos/valve.jpg');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.photo-missing');
    assert.equal(await page.locator('.photo-missing').textContent(), 'photos/valve.jpg didn\'t load. Is it in the photos folder of the placard repo?');
    assert.equal(await page.evaluate(() => window.__placard.ledger.doc('site', 'water-shutoff').photo), 'valve.jpg');
    assert.equal(await page.locator('figure.photo').count(), 0);
    // cleared: no photo, no line
    await page.click('text=Edit this page');
    await page.fill('#f-photo', '');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(() => window.__placard.ledger.doc('site', 'water-shutoff').photo === '');
    assert.deepEqual([await page.locator('figure.photo').count(), await page.locator('.photo-missing').count()], [0, 0]);
    // a page with a photo typed into the sheet as a link or a path shows none, to the owner or a tenant
    L.site = L.site.map(d => d.id === 'water-shutoff' ? { ...d, photo: 'https://example.com/valve.jpg' } : d.id === 'water-heater' ? { ...d, photo: 'nope.jpg' } : d);
    const tenant = await phone(browser, base);
    tenant.L.site = L.site;
    await tenant.page.goto(base + '#water-shutoff');
    await tenant.page.waitForSelector('.tape >> text=Main water shutoff');
    assert.deepEqual([await tenant.page.locator('figure.photo').count(), await tenant.page.locator('img').count()], [0, 0], 'a photo from another site');
    // and a tenant whose page names a file that isn't there sees nothing about it
    await tenant.page.goto(base + '#water-heater');
    await tenant.page.waitForSelector('.tape >> text=Water heater');
    await tenant.page.waitForFunction(() => !document.querySelector('figure.photo'));
    assert.equal(await tenant.page.locator('.photo-missing').count(), 0);
    assert.deepEqual(tenant.errors, []);
    await tenant.ctx.close();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
  // Offline: a tenant's phone with the service worker on. A visit to the front page alone, once the worker runs it, keeps
  // the shutoff's photo; with no signal the next day, the shutoff's page opens from the copy with its picture.
  const off = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    await off.route(base + 'js/config.js', configAs(LEDGER));
    await off.route('https://script.google.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, docs: SAMPLE['placard.site'] }) }));
    const page = await off.newPage();
    await page.goto(base);
    await page.waitForSelector('.urgent-tile');
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    await page.reload();   // a second visit, run by the worker: the read asks for the photos it hasn't kept
    await page.waitForSelector('.urgent-tile');
    await page.waitForFunction(async () => !!(await caches.match('photos/sample-shutoff.jpg')), null, { timeout: 15000, polling: 250 });
    assert.equal(await page.locator('figure.photo').count(), 0, 'the front page showed a photo');
    await off.setOffline(true);
    await off.unroute(base + 'js/config.js');
    await page.reload();
    await page.waitForSelector('.urgent-tile');
    // the worker's own requests are offline too (some Chromium builds let them through): a file it never kept comes back
    // as the copy's page, not as the server's 404, so the photo below can only have come from the copy
    assert.equal(await page.evaluate(async () => { const r = await fetch('photos/never-kept.jpg'); return `${r.status} ${(await r.text()).includes('<title>Placard</title>')}`; }), '200 true',
      'the service worker reached the server while offline');
    await page.evaluate(() => { location.hash = '#water-shutoff'; });
    await page.waitForSelector('.tape >> text=Main water shutoff');
    await page.waitForFunction(() => document.querySelector('figure.photo img')?.complete, null, { timeout: 10000 });
    assert.equal(await page.locator('figure.photo img').evaluate(i => i.naturalWidth), 1200, 'the photo didn\'t open with no signal');
  } finally { await off.setOffline(false).catch(() => {}); await off.close(); }
}

// A regular job on a page: what it is, every N months and Last done. Tenants read "Last filter change: …. Every 3
// months."; the owner sees when it's next due, and a due chip in the Edit list once it's past. A Service visit report
// marked handled offers to set Last done to the visit's day (not for a visit no later than the date already there).
export async function doneChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  // days around today, as the page counts them
  const days = await page.evaluate(() => { const d = n => { const t = new Date(); t.setDate(t.getDate() + n); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], txt = s => { const [y, m, dd] = s.split('-').map(Number); return `${MON[m - 1]} ${dd}, ${y}`; };
    return { ago100: d(-100), ago10: d(-10), ago3: d(-3), today: d(0), txt: Object.fromEntries([-100, -10, -3, 0].map(n => [d(n), txt(d(n))])) }; });
  const row = name => page.locator('.list .row', { hasText: name });
  try {
    L.site = L.site.map(d => d.id === 'air-handler-up' ? { ...d, task: 'Filter change', every: 3, lastDone: days.ago100 } : d.id === 'water-heater' ? { ...d, lastDone: '', every: '' } : d);
    await page.goto(base + '#/owner');
    await page.waitForSelector('.list .row');
    // past: a due chip; a page with no job: none
    assert.equal(await row('Air handler, upstairs').locator('.chip.due').textContent(), 'due');
    assert.equal(await row('Water heater').locator('.chip.due').count(), 0);
    await page.goto(base + '#air-handler-up');
    await page.waitForSelector('.done');
    assert.equal(await page.locator('.done').textContent(), `Last filter change: ${days.txt[days.ago100]}. Every 3 months.`);
    assert.match(await page.locator('.msg.due').textContent(), /^Due since [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
    assert.equal(await page.locator('.msg.due').getAttribute('class'), 'msg due bad');
    // set on another page from its edit sheet: a whole number of months
    await page.goto(base + '#water-heater');
    await page.click('text=Edit this page');
    await page.fill('#f-task', 'Flush');
    await page.fill('#f-every', '2.5');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('dialog[open] .sheet-msg >> text=Every: a whole number of months, from 1 to 120.');
    await page.fill('#f-every', '12');
    await page.fill('#f-lastDone', days.ago10);
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(t => document.querySelector('.done')?.textContent === t, `Last flush: ${days.txt[days.ago10]}. Every 12 months.`);
    assert.match(await page.locator('.msg.due').textContent(), /^Next due /);
    assert.deepEqual(await page.evaluate(() => { const d = window.__placard.ledger.doc('site', 'water-heater'); return [d.task, d.every, d.lastDone]; }), ['Flush', 12, days.ago10]);
    // a tenant reads the line, without when it's due
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    const tenant = await phone(browser, base);
    tenant.L.site = L.site;
    await tenant.page.goto(base + '#water-heater');
    await tenant.page.waitForSelector('.done');
    assert.deepEqual([await tenant.page.locator('.done').textContent(), await tenant.page.locator('.msg.due').count()], [`Last flush: ${days.txt[days.ago10]}. Every 12 months.`, 0]);
    await tenant.ctx.close();
    // a service visit, handled: offered as the page's Last done, on the visit's day
    const visit = (id, system, day, kind = 'Service visit') => page.evaluate(([id, system, day, kind]) => { const { ledger, render } = window.__placard;
      ledger.put('reports', { id, system, systemName: system, kind, name: 'Sam', contact: '', text: 'Changed the filter.', at: new Date(`${day}T15:00:00`).toISOString(), status: 'new' }); render(); }, [id, system, day, kind]);
    await page.goto(base + '#/reports');
    await visit('v1', 'air-handler-up', days.ago3);
    await page.locator('.report', { hasText: 'Changed the filter.' }).locator('button', { hasText: 'Mark handled' }).click();
    const ask = page.getByRole('dialog', { name: 'Air handler, upstairs: set Last done?' });
    await ask.waitFor();
    assert.deepEqual([await ask.locator('label span').first().textContent(), await ask.locator('#f-day').inputValue(), await ask.locator('small').textContent()],
      ['Last filter change', days.ago3, `The page says ${days.txt[days.ago100]} now.`]);
    assert.deepEqual(await ask.locator('.sheet-bar button').allTextContents(), ['Not now', 'Set it']);
    await ask.locator('button', { hasText: 'Set it' }).click();
    await page.waitForSelector(`.toast.show >> text=Air handler, upstairs: last done ${days.txt[days.ago3]}.`);
    assert.equal(await page.evaluate(() => window.__placard.ledger.doc('site', 'air-handler-up').lastDone), days.ago3);
    // and the due chip goes
    await page.goto(base + '#/owner');
    await page.waitForSelector('.list .row');
    assert.equal(await row('Air handler, upstairs').locator('.chip.due').count(), 0, 'still due after Set it');
    // Not now leaves it; a visit no later than Last done, or a report that isn't a visit, asks nothing
    await page.goto(base + '#/reports');
    await visit('v2', 'water-heater', days.today);
    await page.locator('.report', { hasText: 'Changed the filter.' }).filter({ hasNot: page.locator('.dim') }).locator('button', { hasText: 'Mark handled' }).first().click();
    await page.getByRole('dialog', { name: 'Water heater: set Last done?' }).locator('button', { hasText: 'Not now' }).click();
    assert.equal(await page.evaluate(() => window.__placard.ledger.doc('site', 'water-heater').lastDone), days.ago10, 'Not now changed Last done');
    for (const [id, sys, day, kind] of [['v3', 'air-handler-up', days.ago10, 'Service visit'], ['v4', 'water-heater', days.today, 'Problem']]) {
      await visit(id, sys, day, kind);
      await page.waitForFunction(() => [...document.querySelectorAll('.report:not(.dim) button')].some(b => b.textContent === 'Mark handled'));
      await page.locator('.report:not(.dim) button', { hasText: 'Mark handled' }).first().click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('dialog[open]').count(), 0, `asked about ${id}`);
    }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
}

// The whole manual on paper, from the Edit screen: a cover with the welcome, the 911 line, who to call, Good to know, the
// front door's code and the day it was printed; the emergency pages in full; then every page by group, each group on a
// new sheet and an emergency page there pointing to the front. Every page has its QR code. On Letter it fits the page,
// prints nothing else, and prints in the light palette with its step numbers in rings.
export async function manualChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  L.site = L.site.map(d => d.id === 'house' ? { ...d, numbers: [{ id: 'septic', name: 'Hudson Septic', phone: '845-555-0170', note: 'The septic alarm sounds.' }] }
    : d.id === 'water-heater' ? { ...d, call: 'septic', facts: [...d.facts, ['Anode', '']] } : d);
  try {
    await page.goto(base + '#/owner');
    await page.waitForSelector('.list .row');
    assert.equal(await page.locator('a', { hasText: 'Print the manual' }).getAttribute('href'), '#/manual');
    await page.click('text=Print the manual');
    await page.waitForSelector('.manual .pm-page .qr svg');
    const today = await page.evaluate(() => { const d = new Date(), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; });
    const cover = await page.locator('.pm-cover').evaluate(c => ({ title: c.querySelector('.pm-title').textContent, fire: c.querySelector('.pm-fire').textContent,
      call: [...c.querySelectorAll('.pm-person')].map(p => p.textContent), qr: c.querySelector('.qr').dataset.url, printed: c.querySelector('.pm-printed').textContent,
      notes: [...c.querySelectorAll('section')].find(x => x.querySelector('h3')?.textContent === 'Good to know')?.querySelector('p')?.textContent }));
    assert.deepEqual(cover, { title: 'House manual', fire: 'Fire, smoke or a CO alarm: get everyone out, then call 911.',
      call: ['Riverbend Property Care 555-0142 · help@example.com' + 'Call any time for a leak, no heat or no power. Text for anything else.', 'Hudson Septic 845-555-0170The septic alarm sounds.'],
      qr: 'https://tag.junkdrawer.works/h/house', printed: `Printed ${today}. The live manual may be newer.`, notes: 'Trash goes out Monday night; recycling every other Thursday.' });
    const groups = await page.locator('.pm-group').evaluateAll(gs => gs.map(g => [g.querySelector('h2').textContent,
      [...g.querySelectorAll(':scope > .pm-page, :scope > .pm-see')].map(p => p.classList.contains('pm-see') ? p.textContent : `${p.querySelector('h3').textContent} (${p.querySelectorAll('ol.steps li').length} steps, ${p.querySelector('.qr').dataset.url.split('/').pop()})`)]));
    assert.deepEqual(groups, [
      ['In an emergency', ['Main water shutoff (3 steps, water-shutoff)', 'Main electrical panel (2 steps, panel-main)', 'Smoke and CO alarms (2 steps, smoke-co)']],
      ['Water', ['Main water shutoff: with the emergency pages at the front.', 'Water heater (2 steps, water-heater)']],
      ['Power', ['Main electrical panel: with the emergency pages at the front.']],
      ['Heating and cooling', ['Air handler, upstairs (0 steps, air-handler-up)']],
      ['Safety', ['Smoke and CO alarms: with the emergency pages at the front.']]]);
    // a page as a tenant reads it: no blank details; its own number, its job, its photo
    const wh = page.locator('.pm-page').filter({ has: page.locator('h3', { hasText: /^Water heater$/ }) });
    assert.deepEqual(await wh.locator('dt').allTextContents(), ['Make', 'Model', 'Installed', 'Breakers'], 'a blank detail on paper');
    assert.equal(await wh.locator('.pm-person').textContent(), 'Who to call: Hudson Septic, 845-555-0170');
    assert.deepEqual(await page.locator('.pm-group').first().locator('.pm-person').allTextContents(), Array(3).fill('Who to call: Riverbend Property Care, 555-0142'),
      'an emergency page on paper without the number its steps say to call');
    assert.equal(await page.locator('.pm-page', { hasText: 'Air handler, upstairs' }).locator('.done').textContent(), 'Last filter change: Aug 2, 2026. Every 3 months.');
    assert.equal(await page.locator('.pm-group').first().locator('.pm-page').first().locator('img.pm-photo').getAttribute('src'), 'photos/sample-shutoff.jpg');
    assert.equal(await page.locator('.pm-group').first().locator('.pm-page', { hasText: 'Smoke and CO alarms' }).locator('.pm-fire').count(), 1, 'the alarm page has no 911 line');
    assert.equal(await page.locator('.manual .qr svg').count(), 1 + 3 + 2, 'a page without its QR code');
    // on paper: a new sheet for each group, nothing but the manual, the light palette, step numbers in rings
    await printChecks(page, assert, '.manual');
    await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
    const paper = await page.evaluate(() => ({ breaks: [...document.querySelectorAll('.manual > section')].map(s => getComputedStyle(s).breakBefore),
      ring: (s => [s.backgroundColor, s.color, s.borderTopStyle])(getComputedStyle(document.querySelector('.manual ol.steps li'), '::before')) }));
    assert.deepEqual(paper, { breaks: ['auto', 'page', 'page', 'page', 'page', 'page'], ring: ['rgba(0, 0, 0, 0)', 'rgb(0, 0, 0)', 'solid'] });
    await page.emulateMedia({ media: null, colorScheme: null });
    // a tenant gets the front page there, not the paper manual
    const tenant = await phone(browser, base);
    await tenant.page.goto(base + '#/manual');
    await tenant.page.waitForSelector('.urgent-tile');
    assert.equal(await tenant.page.locator('.manual').count(), 0);
    await tenant.ctx.close();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
}

// Save a copy, beside Import: every page and the front page as a file Import reads back (stickers sent elsewhere stay out).
// After mistakes (a Where line blanked, a page deleted, a locked page deleted with its sticker sent to the front page),
// the copy imported fills the blank back in and offers both pages back, each ticked; brought back, the locked page takes
// its address back from the front page.
export async function copyChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  L.site = L.site.map(d => d.id === 'water-heater' ? { ...d, tagged: '2026-11-20', locked: '2026-11-20' } : d);
  const doc = id => page.evaluate(id => window.__placard.ledger.doc('site', id), id);
  try {
    await page.goto(base + '#/owner');
    await page.waitForSelector('.list .row');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Save a copy')]);
    assert.match(dl.suggestedFilename(), /^placard-copy-\d{4}-\d{2}-\d{2}\.json$/);
    const copy = JSON.parse(await readFile(await dl.path(), 'utf8'));
    assert.equal(copy.copy.app, 'placard');
    assert.deepEqual(copy.docs.map(d => d.id), ['house', 'water-shutoff', 'water-heater', 'panel-main', 'air-handler-up', 'smoke-co']);
    assert.deepEqual(copy.docs.filter(d => Object.keys(d).some(k => k.startsWith('_'))), [], 'the ledger\'s own fields went in the copy');
    assert.deepEqual(copy.docs.find(d => d.id === 'water-heater').locked, '2026-11-20');
    await page.waitForSelector(`.toast.show >> text=Saved ${dl.suggestedFilename()}: 5 pages and the front page. Import reads it back.`);
    // the mistakes
    await page.goto(base + '#water-shutoff');
    await page.click('text=Edit this page');
    await page.fill('#f-where', '');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('.where'));
    for (const [id, name] of [['air-handler-up', 'Air handler, upstairs'], ['water-heater', 'Water heater']]) {
      await page.goto(base + '#' + id);
      await page.click('text=Edit this page');
      await page.click('dialog[open] button.danger');
      await page.getByRole('dialog', { name: `Delete ${name}?` }).locator('button[type=submit]').click();
      await page.waitForSelector('h2 >> text=Edit the manual');
    }
    assert.equal((await doc('water-heater')).to, 'house');
    // a copy that isn't Placard's is just an import file: Mothball's
    const [wrong] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Import')]);
    await wrong.setFiles({ name: 'mothball-copy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ copy: { app: 'mothball', saved: copy.copy.saved }, totes: [] })) });
    await page.waitForSelector('.toast.show >> text=That file isn\'t a Placard import.');
    // the copy imported
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Import')]);
    await chooser.setFiles({ name: dl.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(copy)) });
    const ask = page.getByRole('dialog', { name: 'Bring back 2 pages?' });
    await ask.waitFor();
    assert.deepEqual(await ask.locator('.pick span').allTextContents(), ['Water heater', 'Air handler, upstairs']);
    assert.deepEqual(await ask.locator('.pick input').evaluateAll(bs => bs.map(b => b.checked)), [true, true]);
    await ask.locator('button', { hasText: 'Bring back' }).click();
    await page.waitForSelector('.toast.show >> text=Filled in 1, brought back 2.');
    const wh = await doc('water-heater');
    assert.deepEqual([wh.to, wh.name, wh.locked], [undefined, 'Water heater', '2026-11-20'], 'the locked page didn\'t come back whole');
    assert.equal((await doc('air-handler-up')).name, 'Air handler, upstairs');
    assert.equal((await doc('water-shutoff')).where, 'Basement, left of the pressure tank, at waist height.');
    assert.equal(await page.locator('.sent-on').count(), 0, 'the sticker is still listed as sent elsewhere');
    // and its sticker's address opens its own page again
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    assert.equal(new URL(page.url()).hash, '#water-heater');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
}

export async function retryChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  // no signal as the phone sees it: navigator.onLine is false while the cookie offline=1 is set
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !document.cookie.includes('offline=1') }));
  const offline = async on => {
    if (on) await ctx.addCookies([{ name: 'offline', value: '1', url: base }]);
    else { await ctx.clearCookies(); await page.evaluate(() => dispatchEvent(new Event('online'))).catch(() => {}); }
  };
  const text = sel => page.locator(sel).evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  try {
    // a first visit with no signal: No connection, and a Try again a thumb can hit
    L.down = true;
    await offline(true);
    await page.goto(base + '#water-heater');
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
    // the manual's tab renamed or deleted in the sheet: the ledger says so, and the phone keeps its copy (an answer with
    // no pages would have replaced it with an empty manual)
    L.pubGone = true;
    await page.reload();
    await page.waitForSelector('.stale');
    assert.match(await text('.stale p'), /^The latest didn't load\. This is the copy saved today at \d{1,2}:\d\d [ap]m\. A number may have changed since\.$/);
    assert.equal(await page.locator('.tape').textContent(), 'Water heater', 'the kept copy isn\'t shown');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('placard.public')).docs.length > 1), 'the kept copy was emptied');
    L.pubGone = false;
    // a phone with signal whose read fails (config.js wrong, the deployment gone) isn't told it has no signal
    L.down = true;
    await page.reload();
    await page.waitForSelector('.stale');
    assert.match(await text('.stale p'), /^The latest didn't load\. This is the copy saved today at \d{1,2}:\d\d [ap]m\. A number may have changed since\.$/);
    await page.evaluate(() => localStorage.removeItem('placard.public'));
    await page.reload();
    await page.waitForSelector('#app .notice.warn');
    assert.equal(await text('#app .notice.warn p'), 'The house manual didn\'t load. Try again in a minute, or call the number you were given.');
    // Try again on its own, with no online event: the signal back and a press
    await offline(true);
    await page.reload();
    await page.waitForSelector('text=No connection.');
    L.down = false;
    await page.click('#app button >> text=Try again');
    await page.waitForSelector('.tape >> text=Water heater', { timeout: 4000 });
    assert.deepEqual(errors, [], 'errors while the manual was retried');
  } finally { await ctx.close(); }
}

// A report that couldn't go, once its form is closed: the page says it hasn't gone and when it was typed, across a
// reload, and Send it now sends it once. Nothing sends it by itself.
export async function draftChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  const text = sel => page.locator(sel).evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], day = d => MON[d.getMonth()] + ' ' + d.getDate();
  try {
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    await page.click('text=Report a problem or log a visit');
    await page.fill('dialog[open] #f-text', 'No hot water since the power cut this morning');
    L.down = true;
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('dialog[open] .msg.bad');
    await page.click('dialog[open] >> text=Cancel');
    await page.waitForSelector('.unsent');
    const line = `Not sent yet: "No hot water since the power cut this…" (${day(new Date())}).`;
    assert.equal(await text('.unsent .msg'), line, 'nothing on the page says the report hasn\'t gone');
    // the signal comes back while the page is open: nothing goes by itself
    L.down = false;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForTimeout(800);
    assert.equal(L.reports.length, 0, 'a kept report went by itself');
    // a reload a few days later: still there, with the day it was typed
    const was = new Date(Date.now() - 4 * 86400000);
    await page.evaluate(at => { const d = JSON.parse(localStorage.getItem('placard.draft')); d['water-heater'].at = at; localStorage.setItem('placard.draft', JSON.stringify(d)); }, was.getTime());
    await page.reload();
    await page.waitForSelector('.unsent');
    assert.equal(await text('.unsent .msg'), `Not sent yet: "No hot water since the power cut this…" (${day(was)}).`);
    assert.equal(await page.locator('.unsent').count(), 1, 'the line shows twice');
    // Discard asks, and Cancel keeps it
    await page.click('.unsent >> text=Discard');
    await page.getByRole('dialog', { name: 'Discard this report?' }).waitFor();
    assert.deepEqual(await page.locator('dialog[open] button[type=submit]').evaluate(b => [b.textContent, b.className]), ['Discard', 'btn danger']);
    await page.click('dialog[open] >> text=Cancel');
    assert.equal(await page.locator('.unsent').count(), 1, 'Cancel discarded the report');
    // Send it now: one report, and the line says it went
    await page.click('.unsent >> text=Send it now');
    await page.waitForSelector('.toast.show >> text=Sent. The owner gets it by email.');
    assert.deepEqual(L.reports.map(r => [r.system, r.text, r.website]), [['water-heater', 'No hot water since the power cut this morning', '']]);
    assert.equal(await page.locator('.unsent').count(), 0);
    assert.match(await text('.sent'), /^Sent to the owner at \d{1,2}:\d\d [ap]m\.$/);
    assert.equal(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('placard.draft') || '{}')['water-heater'] || null)), 'null');
    // the front page has no line for another page's report
    await page.goto(base + '#');
    await page.waitForSelector('.urgent-tile');
    assert.equal(await page.locator('.unsent').count(), 0);
    // the form closed while its report is still on the way (Google slow): the line has nothing to press, and the
    // report goes once
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    await page.click('text=Report a problem or log a visit');
    await page.fill('dialog[open] #f-text', 'The relief valve drips into the pan');
    L.delay = 3000;
    await page.click('dialog[open] button[type=submit]');
    await page.waitForTimeout(500);
    await page.click('dialog[open] >> text=Cancel');
    await page.waitForSelector('.unsent');
    assert.deepEqual(await page.locator('.unsent button').evaluateAll(bs => bs.map(b => [b.textContent, b.disabled])), [['Sending…', true]],
      'Send it now offered while the report was still on its way');
    await page.waitForSelector('.unsent', { state: 'detached', timeout: 10000 });
    L.delay = 0;
    assert.deepEqual(L.reports.map(r => r.text).filter(t => /relief valve/.test(t)), ['The relief valve drips into the pan'], 'the report went twice, or not at all');
    assert.match(await text('.sent'), /^Sent to the owner at \d{1,2}:\d\d [ap]m\.$/);
    // typed, then closed without Send (changed their mind, or phoned instead): the line has Discard, which takes it off
    // the phone and the form opens empty
    await page.goto(base + '#');
    await page.waitForSelector('.urgent-tile');
    await page.click('text=Report a problem');
    await page.fill('dialog[open] #f-text', 'The porch light flickers');
    await page.click('dialog[open] >> text=Cancel');
    await page.waitForSelector('.unsent');
    await page.click('.unsent >> text=Discard');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.toast.show >> text=Discarded.');
    assert.equal(await page.locator('.unsent').count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('placard.draft') || '{}')[''] || null)), 'null', 'the discarded report is still on the phone');
    await page.click('text=Report a problem');
    assert.equal(await page.inputValue('dialog[open] #f-text'), '', 'the discarded report came back in the form');
    await page.click('dialog[open] >> text=Cancel');
    assert.ok(!L.reports.some(r => /porch light flickers/.test(r.text)), 'a discarded report was sent');
    assert.deepEqual(errors, [], 'errors with a kept report');
  } finally { await ctx.close(); }
}

// The owner, connected (not the sample): the status line on every page, whether a save has reached tenants, and the
// guide part that puts the ledger address in js/config.js.
export async function ownerChecks({ browser, base, assert }) {
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  await ctx.addInitScript(fakeNfc);
  const text = sel => page.locator(sel).evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  try {
    await page.goto(base + '#/owner');
    await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Up to date');
    // js/config.js has this phone's address and it answers a tenant's read: no notice, and the way back is the front page
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#app .notice').count(), 0, 'a notice about tenants when they can read the manual');
    assert.equal(await text('.crumb a'), '‹ Front page');
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
    // Write again on the sticker still against the phone: it holds a link, so Chrome turns the write down and lets go of
    // it. The panel asks for it to be taken off and held there again, and reads it only then: this page's link already
    await page.click('text=Write sticker');
    await page.waitForFunction(() => /^This sticker already holds/.test(document.querySelector('.nfc > .msg:last-child')?.textContent));
    assert.equal(await said(), 'This sticker already holds something. Take it off the phone, then hold it there again.');
    await page.waitForTimeout(300);
    assert.deepEqual([await said(), await page.locator('.nfc button', { hasText: 'Stop' }).count(), await page.evaluate(() => window.__nfc.writes.length)],
      ['This sticker already holds something. Take it off the phone, then hold it there again.', 1, 1], 'the panel went on without the sticker held there again');
    await page.evaluate(() => window.__nfc.hold('https://tag.junkdrawer.works/h/water-heater'));
    await page.waitForFunction(() => document.querySelector('.nfc > .msg:last-child')?.textContent === 'Already holds this link.');
    assert.equal(await page.evaluate(() => window.__nfc.writes.length), 1, 'written over its own link');
    assert.match(await state(), /not locked yet\.$/);
    // Lock reads the sticker first: another page's sticker, or a blank one, isn't locked, and the panel says why
    for (const [held, line] of [['https://tag.junkdrawer.works/h/smoke-co', 'This sticker opens Smoke and CO alarms, not Water heater. Nothing was locked.'],
      ['https://tag.junkdrawer.works/h/house', 'This sticker opens the front page, not Water heater. Nothing was locked.'],
      ['https://tag.junkdrawer.works/t/02', 'This sticker opens Mothball tote 02, not Water heater. Nothing was locked.'],
      ['', 'This sticker is blank. Write it first, then lock it.']]) {
      await page.evaluate(u => window.__nfc.hold(u), held);
      await page.click('text=Lock sticker');
      await page.click('dialog >> text=Lock it');
      await page.waitForFunction(l => document.querySelector('.nfc > .msg:last-child')?.textContent === l, line);
      assert.equal(await page.locator('.nfc > .msg:last-child').getAttribute('class'), 'msg bad');
      assert.equal(await page.evaluate(() => window.__nfc.locks), 0, 'locked a sticker that isn\'t this page\'s: ' + held);
      assert.match(await state(), /not locked yet\.$/);
    }
    // its own sticker: locked. The question ends with the way a locked page's sticker is sent elsewhere, as the locked
    // line does: deleting the page here
    await page.evaluate(() => window.__nfc.hold('https://tag.junkdrawer.works/h/water-heater'));
    await page.click('text=Lock sticker');
    assert.equal(await page.locator('dialog[open] form > p').textContent(), 'Locking is permanent: nobody can rewrite it, you included. Do it only after a tap opens the right page. '
      + 'To send it to another page, delete this one (Edit this page, then Delete) and pick where its sticker goes.');
    await page.click('dialog >> text=Lock it');
    await page.waitForFunction(() => window.__nfc.locks === 1);
    // locked: no Write or Lock to press by mistake, and where a change of address is made instead
    await page.waitForFunction(() => /^Locked /.test(document.querySelector('.nfc .state')?.textContent));
    assert.match(await state(), /^Locked [A-Z][a-z]{2} \d{1,2}, \d{4}\. To send it to another page, delete this one \(Edit this page, then Delete\) and pick where its sticker goes\.$/);
    assert.equal(await page.locator('.nfc button', { hasText: /Write sticker|Lock sticker/ }).count(), 0, 'Write and Lock offered for a locked sticker');
    assert.equal(await said(), 'Locked. It will open this page for good.');
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    assert.ok(L.puts.at(-1).locked, 'the lock was not saved');
    // another sticker for a locked page: once it's written the panel asks whether it replaces the one on the wall or is
    // a spare to keep. A spare leaves the page locked, and says so under the locked line; locking it too says that.
    const doc = () => page.evaluate(() => window.__placard.ledger.doc('site', 'water-heater'));
    const lockedOn = (await doc()).locked, day = await page.evaluate(() => { const d = new Date(); return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${d.getFullYear()}`; });
    const spareLine = () => page.locator('.nfc .msg.spare').allTextContents();
    const ask = page.getByRole('dialog', { name: 'Replacing the one on the wall, or a spare to keep?' });
    await page.click('.nfc >> text=Replace or make a spare');
    await page.waitForSelector('.nfc >> text=Use a new blank sticker. The old one, wherever it is, keeps opening this page.');
    await page.evaluate(() => window.__nfc.hold());
    await page.click('.nfc >> text=Write sticker');
    await page.waitForFunction(() => window.__nfc.writes.length === 2);
    await ask.waitFor();
    assert.deepEqual(await ask.locator('button').allTextContents(), ['Replacing it', 'A spare to keep'], 'the question has more than its two answers');
    await ask.locator('button', { hasText: 'A spare to keep' }).click();
    await page.waitForFunction(() => document.querySelector('.nfc .msg.spare'));
    assert.deepEqual(await spareLine(), [`Spare written ${day}.`]);
    assert.match(await state(), /^Locked /, 'a spare unlocked the page');
    assert.deepEqual([(await doc()).locked, (await doc()).spare, (await doc()).spareLocked], [lockedOn, await page.evaluate(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)), null]);
    assert.equal(await said(), 'Written. Tap it with the phone to check, then lock it.');
    // locked too: the page keeps its own locked day, and the spare's line says it's locked
    await page.click('.nfc >> text=Lock sticker');
    await page.click('dialog >> text=Lock it');
    await page.waitForFunction(() => window.__nfc.locks === 2);
    await page.waitForFunction(() => /^Spare locked/.test(document.querySelector('.nfc .msg.spare')?.textContent));
    assert.deepEqual(await spareLine(), [`Spare locked ${day}.`]);
    assert.equal((await doc()).locked, lockedOn, 'locking the spare moved the page\'s locked day');
    assert.ok((await doc()).spareLocked, 'the spare\'s lock was not saved');
    // the question closed without an answer (Back) counts as a spare: the page stays as it was, locked
    await page.click('.nfc >> text=Replace or make a spare');
    await page.evaluate(() => window.__nfc.hold());
    await page.click('.nfc >> text=Write sticker');
    await ask.waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /^Spare written/.test(document.querySelector('.nfc .msg.spare')?.textContent));
    assert.match(await state(), /^Locked /);
    // a spare written and not locked yet: the panel stays open on Write and Lock, for the lock that comes next
    assert.equal(await page.locator('.nfc button', { hasText: /^(Write sticker|Lock sticker)$/ }).count(), 2);
    // a replacement: written and not locked until it is, as before
    await page.evaluate(() => window.__nfc.hold());
    await page.click('.nfc >> text=Write sticker');
    await ask.waitFor();
    await ask.locator('button', { hasText: 'Replacing it' }).click();
    await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.nfc .state')?.textContent));
    assert.equal((await doc()).locked, null);
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
    await page.evaluate(() => window.__nfc.hold());
    await front.locator('text=Write sticker').click();
    await page.waitForFunction(() => window.__nfc.writes.length === 5);
    await page.waitForFunction(() => /not locked yet\.$/.test(document.querySelector('.front-tag .state')?.textContent));
    await front.locator('text=Lock sticker').click();
    // the front page can't be deleted: OVERRIDES, as its locked line says
    assert.equal(await page.locator('dialog[open] form > p').textContent(), 'Locking is permanent: nobody can rewrite it, you included. Do it only after a tap opens the right page. '
      + 'To send it somewhere else, add it to OVERRIDES in Switchboard\'s 404.html.');
    await page.click('dialog >> text=Lock it');
    await page.waitForFunction(() => window.__nfc.locks === 3);
    await page.waitForFunction(() => /^Locked /.test(document.querySelector('.front-tag .state')?.textContent));
    const hs = await page.evaluate(() => window.__placard.ledger.doc('site', 'house'));
    assert.ok(hs.tagged && hs.locked, 'the front page sticker was not saved as written and locked');
    assert.deepEqual([hs.title, hs.contact?.phone, hs.notes], [SAMPLE['placard.site'][0].title, '555-0142', SAMPLE['placard.site'][0].notes], 'the house page lost its title, contact or notes');
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    assert.ok(L.puts.at(-1).id === 'house' && L.puts.at(-1).locked, 'the lock never reached the ledger');
    assert.deepEqual(errors, [], 'errors on the owner pages');
  } finally { await ctx.close(); }
}

// What the owner is told about what tenants get: js/config.js empty, an address that answers 404 (mistyped, or a
// deployment since archived), and another deployment's address. "Tenants see it now" only when they do.
// A page deleted while its sticker is locked: Delete asks where its sticker should go instead (the front page unless
// picked), and a small record in the manual sends it there, for tenants too, offline included. The Edit list shows
// "sticker → …", where it can be sent elsewhere or stopped. A page a sticker was sent to asks too, and passes it on.
// A locked page's line says this is the way.
export async function forwardChecks({ browser, base, assert }) {
  const day = '2026-11-20', site = structuredClone(SAMPLE['placard.site']);
  for (const d of site) if (d.id === 'water-heater' || d.id === 'smoke-co' || d.id === 'house') Object.assign(d, { tagged: day, locked: day });
  const { ctx, L, errors, page } = await phone(browser, base);
  L.site = site;
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  await ctx.addInitScript(fakeNfc);
  const settled = () => page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
  const doc = id => page.evaluate(id => window.__placard.ledger.doc('site', id), id);
  const del = async name => {
    await page.click('text=Edit this page');
    await page.click('dialog[open] button.danger');
    const ask = page.getByRole('dialog', { name: `Delete ${name}?` });
    await ask.waitFor();
    return ask;
  };
  try {
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    assert.equal(await page.locator('.nfc .state').textContent(), 'Locked Nov 20, 2026. To send it to another page, delete this one (Edit this page, then Delete) and pick where its sticker goes.');
    // the front page can't be deleted: the front-door sticker's line still names OVERRIDES
    await page.goto(base + '#/owner');
    await page.waitForFunction(() => /^Locked/.test(document.querySelector('.front-tag .state')?.textContent));
    assert.equal(await page.locator('.front-tag .state').textContent(), 'Locked Nov 20, 2026. To send it somewhere else, add it to OVERRIDES in Switchboard\'s 404.html.');
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    let ask = await del('Water heater');
    assert.equal(await ask.locator('form p').first().textContent(), 'Its page goes. Its sticker (locked) will keep opening this page\'s address. Send it to another page instead?');
    assert.equal(await ask.locator('#f-to').inputValue(), 'house', 'the front page isn\'t picked to start with');
    assert.deepEqual(await ask.locator('#f-to option').allTextContents(), ['The front page', 'Main water shutoff', 'Main electrical panel', 'Air handler, upstairs', 'Smoke and CO alarms',
      'Nowhere: a page saying it isn\'t in the manual']);
    assert.deepEqual(await ask.locator('button[type=submit]').evaluate(b => [b.textContent, b.className]), ['Delete', 'btn danger']);
    await ask.locator('#f-to').selectOption('panel-main');
    await ask.locator('button[type=submit]').click();
    await page.waitForSelector('.toast.show >> text=Deleted. Its sticker opens Main electrical panel.');
    await settled();
    const { _updated, ...rec } = L.puts.at(-1);
    assert.deepEqual(rec, { id: 'water-heater', to: 'panel-main', name: 'Water heater', tagged: day, locked: day }, 'the record that sends it didn\'t reach the sheet');
    // not a page in the Edit list any more, nor on the QR sheet; a row says where its sticker goes
    assert.equal(await page.locator('.list:not(.sent-on) .row', { hasText: 'Water heater' }).count(), 0);
    const row = () => page.locator('.sent-on .row').evaluate(r => [r.querySelector('.t').textContent, r.querySelector('.s').textContent, r.querySelector('.chip').textContent]);
    assert.deepEqual(await row(), ['Water heater', 'sticker → Main electrical panel', 'locked']);
    // its sticker's address opens that page, at that page's own address
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.tape >> text=Main electrical panel');
    assert.equal(new URL(page.url()).hash, '#panel-main');
    // that page deleted in turn (no sticker of its own): asked too, and the sticker sent there goes on with it
    ask = await del('Main electrical panel');
    assert.equal(await ask.locator('form p').first().textContent(), 'Its page goes. The sticker sent here from Water heater will keep opening this page\'s address. Send it to another page instead?');
    await ask.locator('#f-to').selectOption('water-shutoff');
    await ask.locator('button[type=submit]').click();
    await page.waitForSelector('.toast.show >> text=Deleted. Water heater\'s sticker opens Main water shutoff.');
    assert.equal(await doc('panel-main'), null, 'a page with no sticker of its own left a record behind');
    assert.equal((await doc('water-heater')).to, 'water-shutoff');
    assert.deepEqual(await row(), ['Water heater', 'sticker → Main water shutoff', 'locked']);
    // an import file with the page in it leaves it out, as one deleted here
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Import')]);
    await chooser.setFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ docs: [{ id: 'water-heater', name: 'Water heater', kind: 'water' }] })) });
    await page.waitForSelector('.toast.show >> text=/left out 1 you deleted/');
    assert.equal((await doc('water-heater')).to, 'water-shutoff', 'an import put the page back over its sticker\'s record');
    // from the Edit list: sent to the front page instead
    await page.click('.sent-on .row');
    let sheet = page.getByRole('dialog', { name: 'Water heater\'s sticker' });
    await sheet.waitFor();
    assert.equal(await sheet.locator('#f-to').inputValue(), 'water-shutoff');
    await sheet.locator('#f-to').selectOption('house');
    await sheet.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.sent-on .row .s')?.textContent === 'sticker → the front page');
    await settled();
    await page.goto(base + '#water-heater');
    await page.waitForSelector('.urgent-tile');
    assert.equal(new URL(page.url()).hash, '#house');
    // a tenant: the record comes with the manual, so the sticker goes there for them too, and with no signal from their copy
    const t = await phone(browser, base);
    try {
      t.L.site = structuredClone(L.site);
      await t.page.goto(base + '#water-heater');
      await t.page.waitForSelector('.urgent-tile');
      assert.equal(new URL(t.page.url()).hash, '#house');
      t.L.down = true;
      await t.page.goto('about:blank');
      await t.page.goto(base + '#water-heater');
      await t.page.waitForSelector('.stale');
      assert.equal(await t.page.locator('.urgent-tile').count(), 3);
      assert.equal(new URL(t.page.url()).hash, '#house', 'offline, the tenant\'s copy didn\'t send the sticker on');
      assert.deepEqual(t.errors, []);
    } finally { await t.ctx.close(); }
    // stopped: its address says the page isn't in the manual, with Make this page
    await page.goto(base + '#/owner');
    await page.click('.sent-on .row');
    await sheet.waitFor();
    await sheet.locator('button.danger').click();
    const stop = page.getByRole('dialog', { name: 'Stop sending Water heater\'s sticker?' });
    await stop.waitFor();
    await stop.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('.sent-on'));
    assert.equal(await doc('water-heater'), null);
    await page.goto(base + '#water-heater');
    await page.waitForSelector('text=This sticker\'s page isn\'t in the manual yet.');
    assert.equal(await page.locator('text=Make this page').count(), 1);
    // Nowhere: deleted as before, with no record
    await page.goto(base + '#smoke-co');
    await page.waitForSelector('.tape >> text=Smoke and CO alarms');
    ask = await del('Smoke and CO alarms');
    await ask.locator('#f-to').selectOption('');
    await ask.locator('button[type=submit]').click();
    await page.waitForSelector('.toast.show >> text=Deleted.');
    assert.equal(await doc('smoke-co'), null);
    assert.equal(await page.locator('.sent-on').count(), 0);
    assert.deepEqual(errors, [], 'errors while sending stickers on');
  } finally { await ctx.close(); }
}

export async function configChecks({ browser, base, assert }) {
  for (const [config, notice, said] of [
    [false, /^Tenants can't see this yet\. Put the ledger address in js\/config\.js in the repo \(Part 1 of the guide\)\.$/, 'Saved. Tenants see it once js/config.js has the ledger address.'],
    ['https://script.google.com/macros/s/AKfyARCHIVED/exec', /^Tenants can't open the manual: the address in js\/config\.js didn't answer\. Put this phone's address in it \(Part 1 of the guide\)\.$/,
      'Saved. Tenants can\'t open the manual: the address in js/config.js didn\'t answer.'],
    [OTHER, /^Tenants may be reading another ledger: the address in js\/config\.js isn't this phone's ledger address\. Put this phone's address in it \(Part 1 of the guide\)\.$/,
      'Saved. Tenants may not see it: js/config.js has another ledger address.']]) {
    const { ctx, L, errors, page } = await phone(browser, base, { published: config });
    await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
    try {
      await page.goto(base + '#/owner');
      await page.waitForSelector('#app .notice.warn', { timeout: 8000 });
      assert.match(await page.locator('#app .notice.warn').evaluate(el => el.textContent), notice);
      await page.goto(base + '#water-heater');
      await page.click('text=Edit this page');
      await page.fill('#f-where', 'Basement, under the stairs.');
      await page.click('dialog >> button[type=submit]');
      await page.waitForSelector('#toast.show');
      assert.equal(await page.locator('#toast').textContent(), said);
      assert.equal(L.puts.at(-1).where, 'Basement, under the stairs.', 'the edit didn\'t reach the ledger');
      assert.deepEqual(errors, [], 'errors on the owner pages');
    } finally { await ctx.close(); }
  }
  // js/config.js has this phone's own address and its ledger answers, but one tenant read drops on a poor line (a
  // basement): this phone's own line, not the address, so no notice, and a save never says tenants can't open it
  const { ctx, L, errors, page } = await phone(browser, base);
  await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
  try {
    L.dropPub = 2;
    await page.goto(base + '#/owner');
    await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Up to date');
    await page.waitForFunction(() => document.querySelector('.list .row'));
    for (let i = 0; i < 20 && L.dropPub > 1; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    assert.equal(L.dropPub, 1, 'the Edit screen didn\'t read the manual as a tenant would');
    assert.equal(await page.locator('#app .notice').count(), 0, 'one dropped read said tenants can\'t open the manual');
    await page.goto(base + '#water-heater');
    await page.click('text=Edit this page');
    await page.fill('#f-where', 'Basement, under the stairs.');
    await page.click('dialog >> button[type=submit]');
    await page.waitForSelector('#toast.show');
    assert.equal(await page.locator('#toast').textContent(), 'Saved.', 'a dropped read after a save said tenants can\'t open the manual');
    assert.equal(L.dropPub, 0);
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
    assert.deepEqual(await off(), [['House and contact', true], ['Add a system', true], ['Import', true], ['Save a copy', true]], 'a new page, or a copy, offered before the ledger answered');
    await page.goto(base + '#attic');
    assert.equal(await page.locator('text=Make this page').count(), 0, 'Make this page offered before the ledger answered');
    await page.goto(base + '#/owner');
    await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Up to date', null, { timeout: 10000 });
    await page.locator('#app button:enabled', { hasText: 'Add a system' }).waitFor({ timeout: 2000 });
    assert.deepEqual(await off(), [['House and contact', false], ['Add a system', false], ['Import', false], ['Save a copy', false]]);
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
    await page.waitForSelector('dialog[open] .sheet-msg >> text=Still loading from the ledger. Try again in a moment.');
    assert.equal(await page.inputValue('dialog[open] #f-pick'), 'septic');
    assert.deepEqual(L.puts.map(d => d.id), ['well-tank']);
    // and a new page typed out: the sheet stays open with it
    await page.click('dialog[open] >> text=Cancel');
    await page.click('text=Add a system');
    await page.selectOption('dialog[open] #f-pick', '__new');
    await page.click('dialog[open] button[type=submit]');
    await page.fill('dialog[open] #f-name', 'Attic fan');
    await page.fill('dialog[open] #f-steps', 'Switch on the hall wall.');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('dialog[open] .sheet-msg >> text=Still loading from the ledger. Try again in a moment.');
    assert.deepEqual([await page.inputValue('dialog[open] #f-name'), await page.inputValue('dialog[open] #f-steps')], ['Attic fan', 'Switch on the hall wall.'], 'the refused Save lost what was typed');
    await page.click('dialog[open] >> text=Cancel');
    // House and contact with no house page in the copy, the same (the page isn't drawn again, so its buttons still work)
    await page.evaluate(() => { delete window.__placard.ledger.m('site').docs.house; });
    await page.click('text=House and contact');
    await page.fill('dialog[open] #f-phone', '555-0100');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('dialog[open] .sheet-msg >> text=Still loading from the ledger. Try again in a moment.');
    assert.equal(await page.inputValue('dialog[open] #f-phone'), '555-0100');
    await page.click('dialog[open] >> text=Cancel');
    assert.deepEqual(L.puts.map(d => d.id), ['well-tank']);
    // pages another device made come in while this one makes them: Make this page and Add a system leave them as they
    // were, whether they arrive in the press's own catch-up or while the sheet is open
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => window.__placard.ledger.synced('site'));
    const fan = { id: 'attic-fan', name: 'Attic fan', kind: 'other', where: 'Attic, by the hatch', summary: 'Pulls hot air out in summer.', steps: 'Switch on the hall wall.',
      facts: [['Switch', 'Hall, by the closet']], order: 20 };
    const bib = { id: 'hose-bib', name: 'Outside tap', kind: 'water', where: 'Back wall, by the deck', summary: 'Shut it off inside before the first frost.', order: 21 };
    const septic = { ...STARTER.find(d => d.id === 'septic'), where: 'Front lawn, under the green lid', summary: 'Pumped every three years.' };
    const unchanged = (d, what) => assert.deepEqual(L.site.find(x => x.id === d.id), d, what);
    L.site.push(structuredClone(fan));
    await page.goto(base + '#attic-fan');
    await page.waitForSelector("text=This sticker's page isn't in the manual yet.");
    L.delay = 1000;
    await page.evaluate(() => { window.__placard.ledger.listedAt = 0; });   // the last list was a while ago: the press asks first
    await page.click('text=Make this page');
    await page.waitForSelector('dialog[open], .tape >> text=Attic fan');
    const sheetUp = await page.locator('dialog[open]').count();
    if (sheetUp) { await page.fill('dialog[open] #f-name', 'Typed'); await page.click('dialog[open] button[type=submit]'); }
    await page.waitForTimeout(300);
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    unchanged(fan, 'Make this page replaced the page another device made');
    assert.equal(sheetUp, 0, 'Make this page opened a sheet for a page that had come in, instead of the page');
    await page.waitForSelector('.tape >> text=Attic fan');
    L.delay = 0;
    await page.goto(base + '#hose-bib');
    await page.waitForSelector("text=This sticker's page isn't in the manual yet.");
    await page.click('text=Make this page');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog[open] #f-name', 'Typed');
    L.site.push(structuredClone(bib));
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !!window.__placard.ledger.doc('site', 'hose-bib'));
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.toast.show >> text=That page is in the manual now. Open it to edit it.');
    await page.waitForSelector('.tape >> text=Outside tap');
    unchanged(bib, 'a page that came in while the sheet was open was saved over');
    await page.goto(base + '#/owner');
    await page.click('text=Add a system');
    await page.waitForSelector('dialog[open]');
    L.site.push(structuredClone(septic));
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !!window.__placard.ledger.doc('site', 'septic'));
    await page.selectOption('dialog[open] #f-pick', 'septic');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.toast.show >> text=That page is in the manual now.');
    await page.waitForSelector('.tape >> text=Septic system');
    await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
    unchanged(septic, 'Add a system put the usual page over the one another device added');
    assert.deepEqual(L.puts.map(d => d.id), ['well-tank']);
    assert.deepEqual(errors, [], 'errors on the second owner device');
  } finally { await ctx.close(); }
  // no house page on the sheet yet: one comes in from another device while House and contact is open, and isn't replaced
  {
    const { ctx, L, errors, page } = await phone(browser, base, { published: false });
    const hs = L.site.find(d => d.id === 'house');
    L.site = L.site.filter(d => d.id !== 'house');
    await ctx.addInitScript(u => { try { localStorage.getItem('placard.ledger') || localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })); } catch {} }, LEDGER);
    try {
      await page.goto(base + '#/owner');
      await page.waitForFunction(() => document.querySelector('.sync')?.textContent === 'Up to date');
      await page.click('text=House and contact');
      await page.waitForSelector('dialog[open]');
      await page.fill('dialog[open] #f-title', 'Typed');
      L.site.push(structuredClone(hs));
      await page.evaluate(() => dispatchEvent(new Event('online')));
      await page.waitForFunction(() => !!window.__placard.ledger.doc('site', 'house'));
      await page.click('dialog[open] button[type=submit]');
      await page.waitForSelector('.toast.show >> text=The house page came in from the ledger. Open House and contact again.');
      await page.waitForTimeout(300);
      await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
      assert.deepEqual(L.puts.map(d => d.id), [], 'the house page another device saved was replaced');
      assert.deepEqual(L.site.find(d => d.id === 'house'), hs);
      assert.deepEqual(errors, [], 'errors with a house page arriving');
    } finally { await ctx.close(); }
  }
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
    L.site[0].contact.phone = '800-555-0100 ext. 12';   // an extension: Call dials the number, and shows all of it
    // a page half filled in (a detail still blank, a line with no label, a service number) and one with only its name
    Object.assign(L.site.find(d => d.id === 'air-handler-up'), { care: 'Filters from https://example.com/filters.', facts: [['Filter', ''], ['Changed', 'Every 3 months'],
      ['', 'Spare filters are on the shelf beside it'], ['Service', 'Acme Heating 555-0123']] });
    L.site.push({ id: 'trash', name: 'Trash and recycling', kind: 'other', order: 30 });
    if (who === 'owner') await ctx.addInitScript(u => localStorage.setItem('placard.ledger', JSON.stringify({ url: u, key: 'k'.repeat(40) })), LEDGER);
    if (who === 'owner') await ctx.addInitScript(fakeNfc);
    const rows = () => page.locator('.list .row .t').allTextContents();
    // the shed's details were typed into the sheet as text, not a list: they read as Label: value lines
    const shedFacts = async () => { await page.goto(base + '#shed'); await page.waitForSelector('.tape >> text=Shed');
      return [await page.locator('.facts dt').allTextContents(), await page.locator('.facts dd').allTextContents()]; };
    try {
      await page.goto(base + (who === 'owner' ? '#/owner' : ''));
      await page.waitForSelector('.list .row', { timeout: 8000 });
      const all = await rows();
      for (const name of ['Attic', 'Crawl space', 'Boiler', 'Shed', 'Water heater']) assert.ok(all.includes(name), `${who}: "${name}" isn't listed (${all.join(', ')})`);
      if (who === 'tenant') {
        assert.deepEqual(await page.locator('.contact .btns a').evaluateAll(as => as.map(a => [a.textContent, a.getAttribute('href')])),
          [['Call 800-555-0100 ext. 12', 'tel:8005550100'], ['Text', 'sms:8005550100'], ['Email', 'mailto:help@example.com']], 'the extension was dialled as part of the number');
        await page.click('text=Report a problem');
        assert.equal(await page.locator('dialog[open] a.call-now').getAttribute('href'), 'tel:8005550100');
        await page.click('dialog[open] >> text=Cancel');
        const other = await page.locator('section', { has: page.locator('h2', { hasText: 'Everything else' }) }).locator('.row .t').allTextContents();
        assert.deepEqual(other.sort(), ['Attic', 'Boiler', 'Crawl space', 'Shed', 'Trash and recycling'], 'a page in a group Placard doesn\'t know isn\'t listed');
        await page.goto(base + '#attic');
        await page.waitForSelector('.tape >> text=Attic');
        assert.deepEqual(await shedFacts(), [['Lock'], ['blue']], 'details typed into the sheet as text were dropped');
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
        // and writing its sticker, which saves the page, keeps them
        assert.deepEqual(await shedFacts(), [['Lock'], ['blue']], 'details typed into the sheet as text were dropped (owner)');
        await page.click('text=Write sticker');
        await page.waitForFunction(() => window.__nfc.writes.length === 1);
        await page.waitForFunction(() => /^(Saved|Up to date)$/.test(document.querySelector('.sync')?.textContent));
        assert.deepEqual([L.puts.at(-1).id, L.puts.at(-1).facts], ['shed', [['Lock', 'blue']]], 'writing the sticker saved the page without its details');
      }
      assert.deepEqual(errors, [], `errors with odd records (${who})`);
    } finally { await ctx.close(); }
  }
}

// A phone with the page resized above its on-screen keyboard (390 x 500): the Edit sheet and the report form open with
// the focus on their title, not a field (so the keyboard waits for a tap), are named by it, and every field, focused
// in turn, sits above the Save bar.
async function keyboardChecks({ browser, base, assert }) {
  const { fieldsUnderBar } = await import('./kit-checks.mjs');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 500 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    for (const [open, name] of [['text=Edit this page', 'Edit Water heater'], ['text=Report a problem or log a visit', 'Tell the owner']]) {
      await page.goto('about:blank');
      await page.goto(base + '?demo#water-heater');
      await page.click(open);
      const dlg = page.getByRole('dialog', { name });
      await dlg.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2', `${name}: a field took the focus on a touch screen, so the keyboard covered the sheet`);
      assert.deepEqual(await fieldsUnderBar(page), [], `${name}: a focused field sits under the Save bar`);
    }
  } finally { await ctx.close(); }
}

// A first tap on one bar: before any script has come, the page already says it's loading, and it asks for app.js's
// modules at once (modulepreload) rather than one after another as each is read.
async function firstWordsChecks({ browser, base, assert }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    await ctx.route(base + 'js/config.js', configAs(LEDGER));
    await ctx.route('https://script.google.com/**', r => r.abort());
    const held = [], asked = [];
    await ctx.route(/\.js$/, async r => { asked.push(r.request().url().replace(base, '')); await new Promise(res => held.push(res)); await r.continue(); });
    const page = await ctx.newPage();
    await page.goto(base + '#water-heater', { waitUntil: 'commit' });
    await page.waitForSelector('#app .empty');
    assert.equal(await page.locator('#app').textContent(), 'Loading the house manual…', 'a first tap shows a blank page until the scripts have come');
    for (let i = 0; i < 30 && asked.length < 8; i++) await page.waitForTimeout(100);
    assert.deepEqual(asked.sort(), ['js/app.js', 'js/config.js', 'js/kit/ledger.js', 'js/kit/nfc.js', 'js/kit/panel.js', 'js/kit/tags.js', 'js/kit/ui.js', 'js/starter.js'],
      'the modules weren\'t all asked for before app.js came');
    held.splice(0).forEach(res => res());
  } finally { await ctx.close(); }
}

// A page opened from a sticker doesn't fetch the QR library; the QR sheet fetches it once, saying so meanwhile, then
// draws the codes.
async function qrLoadChecks({ browser, base, assert }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage(), asked = [];
    page.on('request', r => { if (r.url().includes('qrcode.js')) asked.push(r.url()); });
    let release;
    await ctx.route('**/js/kit/qrcode.js', async r => { await new Promise(res => { release = res; }); await r.continue(); });
    await page.goto(base + '?demo#water-heater');
    await page.waitForSelector('.tape >> text=Water heater');
    assert.deepEqual(asked, [], 'a sticker\'s page fetched the QR library');
    await page.evaluate(() => { location.hash = '#/print'; });
    await page.waitForSelector('#app .empty >> text=Making the QR codes…');
    for (let i = 0; i < 50 && !release; i++) await page.waitForTimeout(100);
    release();
    await page.waitForSelector('.qr-card svg');
    assert.equal(asked.length, 1);
  } finally { await ctx.close(); }
}

export async function appChecks({ page, ctx, base, assert, problems }) {
  // The page the offline checks use is a tenant's on an unpublished manual, whatever address js/config.js holds (yours,
  // once Placard is published: Part 1 of its guide), so it never asks Google. Its first load, before these checks, read
  // the file as it is: what that asked of Google is left out, and its offline copy is made again.
  await ctx.route(base + 'js/config.js', configThrough(''));
  if (!/LEDGER_URL = ''/.test(await readFile(join(root, 'js/config.js'), 'utf8'))) {
    await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); });
    await page.reload();
    for (let i = problems.length - 1; i >= 0; i--) if (/script\.google\.com|ERR_NAME_NOT_RESOLVED/.test(problems[i])) problems.splice(i, 1);
  }
  await tenantChecks({ browser: ctx.browser(), base, assert });
  await fireChecks({ browser: ctx.browser(), base, assert });
  await photoChecks({ browser: ctx.browser(), base, assert });
  await doneChecks({ browser: ctx.browser(), base, assert });
  await manualChecks({ browser: ctx.browser(), base, assert });
  await copyChecks({ browser: ctx.browser(), base, assert });
  await numbersChecks({ browser: ctx.browser(), base, assert });
  await ownerChecks({ browser: ctx.browser(), base, assert });
  await forwardChecks({ browser: ctx.browser(), base, assert });
  await secondOwnerChecks({ browser: ctx.browser(), base, assert });
  await oddRecordChecks({ browser: ctx.browser(), base, assert });
  await retryChecks({ browser: ctx.browser(), base, assert });
  await configChecks({ browser: ctx.browser(), base, assert });
  await draftChecks({ browser: ctx.browser(), base, assert });
  await keyboardChecks({ browser: ctx.browser(), base, assert });
  await qrLoadChecks({ browser: ctx.browser(), base, assert });
  await firstWordsChecks({ browser: ctx.browser(), base, assert });
  // Back from a page 40 rows down the owner's front page lands where the list was
  const { backKeepsPlace } = await import('./kit-checks.mjs');
  // every link, button and card header on the sample's screens is a 44 px target
  await (await import('./kit-checks.mjs')).targetsAudit({ browser: ctx.browser(), base, assert, hashes: ['', '#water-heater', '#/owner', '#/print', '#/reports', '#nope'] });
  await backKeepsPlace({ browser: ctx.browser(), base, assert, app: 'placard', colls: { reports: [],
    site: [{ id: 'house', title: 'House manual' }, ...Array.from({ length: 50 }, (_, i) => ({ id: `system-${i + 1}`, name: `System ${i + 1}`, kind: 'other', where: 'Basement', order: i + 1 }))] } });
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
  await page.fill('#f-warn', 'Hot water: 120 °F at the dial.');
  await page.click('dialog >> button[type=submit]');
  await page.waitForSelector('dialog[open] .sheet-msg >> text=Too long to save: over 45,000 characters. Shorten it, or link the manual instead.');
  assert.equal(await page.inputValue('#f-warn'), 'Hot water: 120 °F at the dial.', 'the refused Save lost what was typed');
  assert.equal(await page.evaluate(() => (window.__placard.ledger.doc('site', 'water-heater').care || '').length < 46000), true);
  await page.click('dialog[open] >> text=Cancel');
  // a page that doesn't fit is deleted, then an updated import file comes (blank Where lines and contact, new details):
  // it fills in, never blanks or replaces what's here, and the deleted page stays deleted; twice over, nothing changes
  await page.evaluate(() => { location.hash = '#smoke-co'; });
  await page.click('text=Edit this page');
  await page.click('dialog[open] >> text=Delete');
  // the confirmation says what a tenant tapping its sticker gets then, without ids
  assert.equal(await page.locator('dialog[open] form > p').textContent(),
    'Its page goes. A sticker written for it will open a page saying it isn\'t in the manual yet, with Who to call and the whole manual.');
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
  await cardStepsChecks(page, base, assert);
  await reportsChecks(page, base, assert);
}

// An emergency page's QR card carries its first steps under the code (the 911 line first on a Safety page); the others
// don't. Printed on Letter, it's two cards tall (108 mm, two rows of the sheet), and every card's words fit inside it,
// a page with more steps than fit ending with a line saying there's more on the page.
async function cardStepsChecks(page, base, assert) {
  const cards = () => page.locator('.qr-card').evaluateAll(cs => cs.map(c => ({ name: c.querySelector('b').textContent, fire: c.querySelector('.qr-fire')?.textContent || '',
    steps: [...c.querySelectorAll('.qr-steps li')].map(l => l.textContent), more: c.querySelector('.qr-more')?.textContent || '', call: c.querySelector('.qr-call')?.textContent || '' })));
  const sample = Object.fromEntries(SAMPLE['placard.site'].map(d => [d.id, d]));
  const steps = id => sample[id].steps.split('\n');
  const call = 'Call Riverbend Property Care, 555-0142', none = { fire: '', steps: [], more: '', call: '' };
  assert.deepEqual(await cards(), [
    { name: 'House manual', ...none }, { name: 'Main water shutoff', fire: '', steps: steps('water-shutoff'), more: '', call },
    { name: 'Water heater', ...none }, { name: 'Main electrical panel', fire: '', steps: steps('panel-main'), more: '', call },
    { name: 'Air handler, upstairs', ...none }, { name: 'Garage door opener', ...none }],
    'the cards\' steps (the sample\'s alarm page was deleted above, and the garage door imported)');
  // the alarm page back, with more steps than a card holds, and long ones
  await page.evaluate(s => { const { ledger, render } = window.__placard; ledger.put('site', { ...s, steps: [s.steps, 'Test every alarm once a month with its button: hold it until it sounds, then let go.',
    'A CO alarm that sounds and stays on: open the windows, get everyone out and call 911 from outside; do not go back in until the fire department says so.',
    'Never take the battery out to stop a chirp. Tell us and we will replace it the same day.'].join('\n') }); render(); }, sample['smoke-co']);
  await page.waitForFunction(() => [...document.querySelectorAll('.qr-card b')].some(b => b.textContent === 'Smoke and CO alarms'));
  const alarm = (await cards()).find(c => c.name === 'Smoke and CO alarms');
  assert.deepEqual(alarm, { name: 'Smoke and CO alarms', fire: 'Fire, smoke or a CO alarm: get everyone out, then call 911.', steps: [...steps('smoke-co'),
    'Test every alarm once a month with its button: hold it until it sounds, then let go.', 'A CO alarm that sounds and stays on: open the windows, get everyone out and call 911 from outside; do not go back in until the fire department says so.'],
    more: '1 more on the page: tap or scan.', call });
  for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width: 739, height: 1000 });
    await page.emulateMedia({ media: 'print', colorScheme });
    const got = await page.locator('.qr-card').evaluateAll(cs => cs.map(c => ({ name: c.querySelector('b').textContent, mm: Math.round(c.getBoundingClientRect().height / 96 * 25.4),
      fits: c.scrollHeight <= c.clientHeight + 1 && [...c.querySelectorAll('*')].every(e => e.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5), rows: getComputedStyle(c).gridRowStart })));
    for (const c of got) {
      const sos = ['Main water shutoff', 'Main electrical panel', 'Smoke and CO alarms'].includes(c.name);
      assert.deepEqual([c.name, c.mm, c.fits, c.rows], [c.name, sos ? 108 : 52, true, sos ? 'span 2' : 'auto'], `${colorScheme}: the printed card for ${c.name}`);
    }
  }
  await page.emulateMedia({ media: null, colorScheme: null });
  await page.setViewportSize({ width: 390, height: 844 });
}

// The Reports screen: the same words from the same page on one day are one card that says how many times and when,
// with one Mark handled for all of them; a phone number left in a report gets Call and Text, an email address Email.
async function reportsChecks(page, base, assert) {
  await page.goto(base + '?demo#/owner');
  await page.waitForSelector('.row');
  assert.equal(await page.locator('#app a', { hasText: /^Reports/ }).textContent(), 'Reports (1)');
  // the sample's report sent twice more within twelve minutes (the ledger keeps the repeats), and a question by email
  const r1 = (await import('../js/starter.js')).SAMPLE['placard.reports'][0], at = Date.parse(r1.at);
  await page.evaluate(([r1, at]) => {
    const { ledger, render } = window.__placard;
    ledger.put('reports', { ...r1, id: 'r2', text: '  small drip from the valve   on the side.', at: new Date(at + 6 * 60000).toISOString(), repeat: true });
    ledger.put('reports', { ...r1, id: 'r3', at: new Date(at + 12 * 60000).toISOString(), repeat: true });
    ledger.put('reports', { id: 'r4', system: '', systemName: '', kind: 'Question', name: 'Pat', contact: 'pat@example.com', text: 'Which day is trash?', at: new Date(at + 3600e3).toISOString(), status: 'new' });
    render();
  }, [r1, at]);
  assert.equal(await page.locator('#app a', { hasText: /^Reports/ }).textContent(), 'Reports (2)', 'a report sent three times counts three');
  await page.evaluate(() => { location.hash = '#/reports'; });   // the same page: the sample keeps the reports added
  await page.waitForSelector('.report');
  const cards = () => page.locator('.report').evaluateAll(ls => ls.map(l => ({ text: l.querySelector('p:nth-child(2)').textContent, times: l.querySelector('.times')?.textContent || '',
    links: [...l.querySelectorAll('.btns a')].map(a => [a.textContent, a.getAttribute('href')]), handled: l.classList.contains('dim') })));
  const span = await page.evaluate(at => { const c = ms => { const d = new Date(ms); return [d.getHours() % 12 || 12, String(d.getMinutes()).padStart(2, '0'), d.getHours() < 12 ? 'am' : 'pm']; };
    const [a, b] = [c(at), c(at + 12 * 60000)]; return a[2] === b[2] ? `${a[0]}:${a[1]}-${b[0]}:${b[1]} ${b[2]}` : `${a.join(':').replace(/:(am|pm)$/, ' $1')}-${b.join(':').replace(/:(am|pm)$/, ' $1')}`; }, at);
  assert.deepEqual(await cards(), [
    { text: 'Which day is trash?', times: '', links: [['Email', 'mailto:pat@example.com']], handled: false },
    { text: 'Small drip from the valve on the side.', times: `Sent 3 times, ${span}`, links: [['Call', 'tel:5550101'], ['Text', 'sms:5550101']], handled: false }],
    'the Reports screen\'s cards');
  // one Mark handled for the three
  await page.locator('.report', { hasText: 'Small drip' }).locator('button', { hasText: 'Mark handled' }).click();
  await page.waitForSelector('.report.dim');
  assert.deepEqual(await page.evaluate(() => ['r1', 'r2', 'r3', 'r4'].map(id => window.__placard.ledger.doc('reports', id).status)), ['handled', 'handled', 'handled', 'new']);
  assert.ok(await page.locator('.report.dim').evaluate(el => Number(getComputedStyle(el).opacity)) < 1, 'a handled report isn\'t greyed out');
  assert.equal(await page.locator('.report.dim button').count(), 0, 'Mark handled offered for a card already handled');
  assert.deepEqual((await cards())[1].links, [['Call', 'tel:5550101'], ['Text', 'sms:5550101']], 'a handled report lost its Call and Text');
  // the same words later that morning, after they were marked handled: a new problem, so a card of its own, not "Sent 4 times"
  await page.evaluate(([r1, at]) => { const { ledger, render } = window.__placard;
    ledger.put('reports', { ...r1, id: 'r5', at: new Date(at + 40 * 60000).toISOString(), status: 'new' }); render(); }, [r1, at]);
  await page.waitForFunction(() => document.querySelectorAll('.report').length === 3);
  assert.deepEqual((await cards()).map(c => [c.text, c.times, c.handled]), [['Which day is trash?', '', false], ['Small drip from the valve on the side.', '', false],
    ['Small drip from the valve on the side.', `Sent 3 times, ${span}`, true]], 'a report after the first was handled joined its card');
  // two people with the same words: each button names whose number or address it is
  await page.evaluate(() => { const { ledger, render } = window.__placard, t = m => new Date(2026, 10, 21, 10, m).toISOString();
    ledger.put('reports', { id: 'r6', system: 'well-tank', systemName: 'Well tank', kind: 'Problem', name: 'Pat', contact: '555-0123', text: 'No water at all', at: t(0), status: 'new' });
    ledger.put('reports', { id: 'r7', system: 'well-tank', systemName: 'Well tank', kind: 'Problem', name: 'Sam', contact: 'sam@example.com, 555-0199', text: 'No water at all', at: t(5), status: 'new' });
    ledger.put('reports', { id: 'r8', system: 'well-tank', systemName: 'Well tank', kind: 'Problem', contact: 'upstairs.tenant.longname.flat2@exampleproperty.com', text: 'no water at all', at: t(9), status: 'new' });
    render(); });
  await page.waitForSelector('.report >> text=No water at all');
  assert.deepEqual((await cards())[0].links, [['Call Pat', 'tel:5550123'], ['Text Pat', 'sms:5550123'], ['Call Sam', 'tel:5550199'], ['Text Sam', 'sms:5550199'],
    ['Email Sam', 'mailto:sam@example.com'], ['Email upstairs.tenant.longname.flat2@exampleproperty.com', 'mailto:upstairs.tenant.longname.flat2@exampleproperty.com']],
  'two people\'s Call buttons look the same');
  assert.deepEqual(await page.locator('.report').first().evaluate(l => [...l.querySelectorAll('.btn')].filter(b => b.getBoundingClientRect().right > l.getBoundingClientRect().right).map(b => b.textContent)),
    [], 'a button runs off its card');
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
