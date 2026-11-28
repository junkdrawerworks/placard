// What Switchboard's front page says about Placard. Switchboard imports this file from placard.junkdrawer.works and
// hands it the records it has read from the ledger (read only, with the key it holds), so its lines follow Placard's
// own rules in starter.js, and names its pages as it does. No DOM and no ledger here: unit-tested in
// test/attention.test.mjs.
// read(coll): that collection's records, deleted ones left out. A link is relative to Placard's address.
import { KINDS, groupReports, nextDue, isDue, job } from './starter.js';
import { today } from './kit/ui.js';

export const COLLS = ['site', 'reports'];
// The manual's pages, as app.js has them: not the front page, and not a deleted page's record that sends its sticker
// on ({ to }); a page without a name goes by its id ('crawl-space' as 'Crawl space').
const FRONT = new Set(['house', 'home']);
const sendsOn = d => typeof d?.to === 'string' && !!d.to;
const pageName = d => (typeof d.name === 'string' && d.name.trim() ? d.name : (d.id.charAt(0).toUpperCase() + d.id.slice(1)).replace(/-/g, ' '));
const pagesOf = read => read('site').filter(d => d && typeof d.id === 'string' && d.id && !d._bad && !FRONT.has(d.id) && !sendsOn(d));

// Needs a look: [{ text, href }], [] when nothing does. The reports not marked handled, counted as the Reports button
// counts them ('Rental: 1 new report'), and the pages whose regular job is due, as the morning slip says them, the
// longest overdue first ('Rental: Air handler, upstairs - filter change due'). The second opens the page when there's one.
export function look(read, now = new Date()) {
  const out = [], n = groupReports(read('reports')).filter(c => !c.handled).length, day = today(now);
  if (n) out.push({ text: `Rental: ${n} new report${n > 1 ? 's' : ''}`, href: '#/reports' });
  const due = pagesOf(read).filter(p => isDue(p, day)).sort((a, b) => nextDue(a).localeCompare(nextDue(b)) || pageName(a).localeCompare(pageName(b)));
  if (due.length) out.push({ text: 'Rental: ' + due.map(p => `${pageName(p)}${String(p.task ?? '').trim() ? ' - ' + job(p.task) : ''} due`).join('; '),
    href: due.length === 1 ? '#' + due[0].id : '#/owner' });
  return out;
}

// Find anything: every page of the manual, in its order, by its name and where it is (or its group when it doesn't
// say), opening the page. texts: the name and where, which Switchboard matches with the kit's find.js.
const order = d => (Number.isFinite(Number(d.order)) && d.order !== '' && d.order != null ? Number(d.order) : 99);
const group = d => (KINDS.find(([k]) => k === d.kind) || KINDS.at(-1))[1];
const placeOf = d => (typeof d.where === 'string' && d.where.trim() ? d.where : group(d));
export function things(read) {
  return pagesOf(read).sort((a, b) => order(a) - order(b) || pageName(a).localeCompare(pageName(b)))
    .map(p => ({ name: pageName(p), where: placeOf(p), href: '#' + p.id, texts: [pageName(p), p.where] }));
}

// Check a tag: what each sticker is for, { id: { name, where } }. A page's sticker: the page and where it is; the front
// page's (h/house, or h/home): the manual's title; a deleted page's sticker sent on to another page ({ to }): the page
// it lands on, as Placard follows it (a few steps at most). Nothing until the manual has a page.
export function tags(read) {
  const site = read('site').filter(d => d && typeof d.id === 'string' && d.id && !d._bad), out = {};
  if (!site.length) return out;
  const house = site.find(d => d.id === 'house'), front = { name: String(house?.title || 'House manual'), where: 'Front page' };
  out.house = out.home = front;
  for (const p of pagesOf(read)) out[p.id] = { name: pageName(p), where: placeOf(p) };
  const sent = id => site.find(d => d.id === id && sendsOn(d));
  for (const d of site.filter(sendsOn)) {
    let at = d.id;
    for (let i = 0; i < 5 && sent(at); i++) at = sent(at).to.toLowerCase();
    if (!sent(at) && out[at]) out[d.id] = out[at];
  }
  return out;
}
