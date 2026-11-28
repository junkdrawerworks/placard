// Placard's own checks, run by test/e2e.mjs on a phone-sized page.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE, STARTER } from '../js/starter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'https://script.google.com/macros/s/AKfyTEST/exec';
// A pretend Chrome NFC reader with one sticker held against the phone (__nfc.sticker: a blank one to start with). A scan
// reads it at once; a write that mustn't write over anything is turned down by a sticker holding a link, and every
// write by a locked one, as Chrome does; a lock locks it. __nfc.hold(url, locked) puts another sticker there.
const fakeNfc = () => {
  window.__nfc = { writes: [], locks: 0, sticker: { url: '', locked: false } };
  window.__nfc.hold = (url = '', locked = false) => { window.__nfc.sticker = { url, locked }; };
  window.NDEFReader = class {
    async write(msg, { overwrite = true } = {}) {
      const s = window.__nfc.sticker;
      if (s.locked) throw new DOMException('', 'NotAllowedError');
      if (!overwrite && s.url) throw new DOMException('NDEFWriteOptions#overwrite does not allow overwrite.', 'NotAllowedError');
      window.__nfc.writes.push(msg.records[0].data);
      s.url = msg.records[0].data;
    }
    async makeReadOnly() { window.__nfc.locks++; window.__nfc.sticker.locked = true; }
    async scan({ signal } = {}) {
      const { url } = window.__nfc.sticker;
      setTimeout(() => { if (!signal?.aborted) this.onreading?.({ serialNumber: '04:5e', message: { records: url ? [{ recordType: 'url', data: new TextEncoder().encode(url) }] : [] } }); }, 20);
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
  await reportsChecks(page, base, assert);
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
