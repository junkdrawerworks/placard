// Placard's own checks, run by test/e2e.mjs on a phone-sized page.
const fakeNfc = () => {
  window.__nfc = { writes: [], locks: 0 };
  window.NDEFReader = class {
    async write(msg) { window.__nfc.writes.push(msg.records[0].data); }
    async makeReadOnly() { window.__nfc.locks++; }
    async scan() {}
  };
};
export async function appChecks({ page, base, assert }) {
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
  await page.click('dialog >> text=Send');
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
