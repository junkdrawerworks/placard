// Placard: a house manual on stickers. Tenants tap a sticker and get that system's page with no app and no sign-in;
// the owner, connected to the ledger, edits the pages, writes and locks the stickers and reads the reports.
import { $, h, mount, toast, sheet, confirmSheet, route, go, stampText, qrSvg, loadQr, today, held, sampleLink, onRoute, dayText } from './kit/ui.js';
import { Ledger, watchConnectLinks, publicRead, publicReport, refusal, importSummary, STILL_LOADING } from './kit/ledger.js';
import { tagUrl } from './kit/tags.js';
import { nfcPanel } from './kit/panel.js';
import { LEDGER_URL } from './config.js';
import { KINDS, STARTER, SAMPLE, parseFacts, factsText, lines, mergeImport, dial, splitLinks, reachBy, groupReports, clock, timeSpan, photoName,
  isoDay, everyOf, nextDue, isDue, job, doneText } from './starter.js';

const params = new URLSearchParams(location.search);
const demo = params.has('demo');
watchConnectLinks('placard', toast);
const ledger = new Ledger('placard', { demo: demo ? SAMPLE : null });
const owner = () => ledger.connected;
const app = $('#app');
let site = [];          // the docs everyone sees
let siteError = '';
let loading = false;    // a tenant's first visit, nothing kept yet, waiting on the ledger
let copyAt = 0;         // when the tenant's kept copy came from the ledger (0: a copy kept before that was noted)
let stale = '';         // the tenant's read failed, and the kept copy is on screen: why ('offline')

const jget = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// The front page is the house doc. Its own sticker, tag.junkdrawer.works/h/house (or h/home), opens it, so those two
// ids are never a system's page.
const FRONT = new Set(['house', 'home']);
// A page deleted while its sticker was written or locked can leave a small record in its place, { id, to, name,
// tagged, locked }, that sends its sticker to another page (to: a page's id, or house for the front page). It's in the
// manual like any page, so a tenant's phone has it offline, and no script changes; it's never listed as a page.
const sendsOn = d => typeof d?.to === 'string' && !!d.to;
const house = () => site.find(d => d.id === 'house') || { title: 'House manual' };
const systems = () => site.filter(d => !FRONT.has(d.id) && !sendsOn(d)).sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)));
const sys = id => FRONT.has(id) ? null : site.find(d => d.id === id && !sendsOn(d));
const sentOn = () => site.filter(sendsOn).sort((a, b) => String(a.name).localeCompare(String(b.name)));
const sentFrom = id => site.find(d => d.id === id && sendsOn(d));
// The house's other numbers, and the one a page shows on its card (s.call: a number's id), or null: the house contact.
const numbers = () => house().numbers || [];
const numberOf = s => (s?.call && numbers().find(n => n.id === s.call)) || null;
// Where a sticker sent elsewhere lands: its record's page, or where that one's sticker was sent in turn (a few steps at
// most, so two records sending to each other can't go round for ever). A page, the front page, or a page gone.
function landing(id) {
  let at = id;
  for (let i = 0; i < 5 && sentFrom(at); i++) at = sentFrom(at).to;
  return sentFrom(at) ? id : at;
}
// "Main water shutoff", "the front page", or the id of a page no longer in the manual
const pageName = id => FRONT.has(id) ? 'the front page' : sys(id)?.name || `${id} (not in the manual)`;
// The pages as the screens use them. A record typed into the sheet by hand, or from an old import, can lack a name or an
// order, have details typed as text instead of a list, or a group that isn't one of the six: each page still draws
// and is listed (a page without a name goes by its id, 'crawl-space' as 'Crawl space'; details typed as text read as
// "Label: value" lines, as an import reads them; an unknown group under Everything else, and kept as it is when the
// page is saved). A row whose JSON didn't read never reaches the screens.
const str = v => (v == null ? '' : typeof v === 'string' ? v : String(v));
const group = s => (KINDS.some(([k]) => k === s.kind) ? s.kind : 'other');
function normal(d) {
  if (sendsOn(d)) return { ...d, to: d.to.toLowerCase(), name: typeof d.name === 'string' && d.name.trim() ? d.name : d.id };
  if (d.id === 'house') {
    const c = d.contact && typeof d.contact === 'object' && !Array.isArray(d.contact) ? d.contact : null;
    // Other numbers (the septic company, the outage line, a backup): each { id, name, phone, note }; one typed into the
    // sheet without a name goes by its id, and anything that isn't one is left out
    const numbers = (Array.isArray(d.numbers) ? d.numbers : []).filter(n => n && typeof n === 'object' && typeof n.id === 'string' && n.id)
      .map(n => ({ id: n.id, name: str(n.name).trim() || n.id, phone: str(n.phone), note: str(n.note) }));
    return { ...d, ...(c ? { contact: { name: str(c.name), phone: str(c.phone), email: str(c.email), note: str(c.note) } } : {}), numbers };
  }
  const named = typeof d.name === 'string' && d.name.trim() ? d.name : '';
  return { ...d, name: named || (d.id.charAt(0).toUpperCase() + d.id.slice(1)).replace(/-/g, ' '),
    facts: Array.isArray(d.facts) ? d.facts.filter(Array.isArray).map(([k, v]) => [str(k), str(v)]) : typeof d.facts === 'string' ? parseFacts(d.facts) : [],
    order: Number.isFinite(Number(d.order)) && d.order !== '' && d.order != null ? Number(d.order) : 99 };
}
const pages = docs => (Array.isArray(docs) ? docs : []).filter(d => d && typeof d === 'object' && typeof d.id === 'string' && d.id && !d._bad && !d._deleted).map(normal);
const fromLedger = () => { site = pages(ledger.docs('site')); };
// A new page (or the house page, the first time) waits until this phone has heard from the ledger: before that its
// copy can't say which pages are there, and a save would replace the page in the sheet. It asks for the latest first.
const fresh = then => e => held(e.currentTarget, ledger.catchUp(['site'])).then(() => { fromLedger(); return then(); });

async function load() {
  if (owner()) {
    fromLedger();
    render();
    ledger.keepUp(['site', 'reports'], () => { fromLedger(); render(); });
    return;
  }
  // A tenant: the copy kept from last time straight away, then the ledger's. With no copy, a line while Google wakes
  // the script (a few seconds).
  const kept = jget(PUBLIC);
  site = pages(Array.isArray(kept) ? kept : kept?.docs);
  copyAt = Number(kept?.at) || 0;
  if (!LEDGER_URL) { siteError = 'unset'; render(); return; }
  readPublic();
}

// A tenant's read of the manual. The copy is kept with the time it came ({ at, docs } in placard.public). When the read
// fails, the page says so (no copy: No connection, with Try again; with one: a line at the top saying how old it is) and
// reads again when the phone comes back online or the page is looked at again, and every 20 s while it says so. A good
// read ends it.
const PUBLIC = 'placard.public', AGAIN = 20000;
// Google gives up after 12 s (No connection); after 6 s the loading line says it's slow.
let reading = null, again = null, slow = false;
function readPublic() {
  if (reading) return reading;
  clearTimeout(again);
  if (!site.length && !loading) { loading = true; slow = false; render(); }
  const slowly = setTimeout(() => { slow = true; if (loading) render(); }, 6000);
  reading = (async () => {
    try {
      const docs = await publicRead(LEDGER_URL, 'placard', 'site');
      copyAt = Date.now(); jset(PUBLIC, { at: copyAt, docs });
      site = pages(docs); siteError = ''; stale = '';
      warmPhotos();
    } catch (e) {
      // no signal (or one bar that never answers), or a phone online whose read failed: the address in config.js
      // is wrong or its deployment gone, which a signal won't mend
      const why = !navigator.onLine || e.kind === 'offline' ? 'offline' : 'noload';
      if (site.length) stale = why; else siteError = why;
      again = setTimeout(readPublic, AGAIN);
    } finally { loading = false; reading = null; clearTimeout(slowly); }
    render();
  })();
  return reading;
}
const failing = () => !owner() && !!LEDGER_URL && (!!stale || siteError === 'offline' || siteError === 'noload');
// After a tenant's good read, every page's photo the phone hasn't kept yet is asked for once, through the service worker,
// which keeps it: a tap on another sticker later, with no signal in the basement, still shows its picture. It waits until
// the worker runs the page (a first visit's photos go at the next one), and asks nothing on a phone saving data.
async function warmPhotos() {
  if (demo || !('serviceWorker' in navigator) || !('caches' in window) || navigator.connection?.saveData) return;
  try {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    for (const s of systems()) {
      const n = photoName(s.photo);
      if (n && !(await caches.match('photos/' + n))) await fetch('photos/' + n).catch(() => {});
    }
  } catch {}
}
window.addEventListener('online', () => { if (failing()) readPublic(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && failing()) readPublic(); });
const tryAgain = () => h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn ghost', onclick: e => {
  e.currentTarget.disabled = true; e.currentTarget.textContent = 'Trying…'; readPublic(); } }, 'Try again'));
// "today at 3:04 pm", "Nov 20", "Nov 20, 2025"
const savedWhen = at => {
  if (!at) return 'on this phone';
  const d = new Date(at), now = new Date();
  if (today(d) === today(now)) return `today at ${clock(at)}`;
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`;
};
function staleNotice() {
  if (owner() || !stale || !site.length) return null;
  return h('div', { class: 'notice warn stale' },
    h('p', {}, h('b', {}, stale === 'offline' ? 'No signal. ' : 'The latest didn\'t load. '), `This is the copy saved ${savedWhen(copyAt)}. A number may have changed since.`));
}

// ---------------------------------------------------------------- tenant pages
// The fixed line for a fire or a CO alarm, where 911 comes before the house contact: at the top of In an emergency on the
// front page, and on an emergency page in the Safety group (the smoke and CO alarms), whose report form then says 911
// too. The whole band dials, a target a thumb can't miss.
const FIRE = 'Fire, smoke or a CO alarm: get everyone out, then call 911.';
const lifeSafety = s => !!s?.emergency && group(s) === 'safety';
const fireLine = () => h('a', { class: 'notice bad call-now call-911', href: 'tel:911' }, 'Fire, smoke or a CO alarm: get everyone out, then ', h('b', {}, 'call 911'), '.');
// Call and Text dial the first number written, without an extension (dial()); the button shows all of it.
// One person or company on the card: its name (who, when given: "Or Riverbend Property Care"), when to call, and Call,
// with Text and Email for the house contact (an outage line or a septic company may not take a text).
function person(c, { main = true, text = true, who = c.name } = {}) {
  const tel = dial(c.phone);
  return [
    h('p', { class: 'who' }, who || ''),
    c.note ? h('p', { class: 'muted' }, c.note) : null,
    c.phone && !tel ? h('p', {}, c.phone) : null,
    h('div', { class: 'btns' },
      tel ? h('a', { class: main ? 'btn' : 'btn ghost', href: 'tel:' + tel }, 'Call ' + c.phone) : null,
      tel && text ? h('a', { class: 'btn ghost', href: 'sms:' + tel }, 'Text') : null,
      c.email ? h('a', { class: 'btn ghost', href: 'mailto:' + c.email }, 'Email') : null)];
}
const reachable = c => !!(c && (c.phone || c.email));
// Who to call. On the front page: the house contact, then the house's other numbers, each with when to call. On a page
// that picked one of them (the septic page, the septic company): that number first, and the house contact under it. A
// page with none, or whose number has since been deleted: the house contact, as before.
function contactCard(c, { others = [], first = null } = {}) {
  others = others.filter(n => n.phone);
  if (first?.phone) return h('section', { class: 'card contact' }, h('h2', {}, 'Who to call'), person(first, { text: false }),
    reachable(c) ? h('div', { class: 'also' }, person(c, { main: false, who: 'Or ' + (c.name || 'the house contact') })) : null);
  if (!reachable(c) && !others.length) return null;
  return h('section', { class: 'card contact' },
    h('h2', {}, 'Who to call'),
    reachable(c) ? person(c) : null,
    others.length ? [h('h3', {}, 'Other numbers'), h('ul', { class: 'others' }, others.map(n => h('li', {}, person(n, { main: false, text: false }))))] : null);
}

function renderHome() {
  const hs = house();
  const list = systems();
  const urgent = list.filter(s => s.emergency);
  return [
    h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, 'Welcome'), h('div', { class: 'tape' }, hs.title || 'House manual')),
    hs.intro ? h('p', { class: 'lead' }, hs.intro) : null,
    list.length ? h('section', { class: 'sos' }, h('h2', {}, 'In an emergency'), fireLine(),
      urgent.length ? h('div', { class: 'urgent' }, urgent.map(s => h('a', { class: 'urgent-tile', href: '#' + s.id }, h('b', {}, s.name), h('span', {}, s.where || '')))) : null) : null,
    contactCard(hs.contact, { others: numbers() }),
    reportButton(null, 'Report a problem'),
    KINDS.map(([k, label]) => {
      const in_ = list.filter(s => group(s) === k);
      return in_.length ? h('section', {}, h('h2', {}, label), h('ul', { class: 'list' }, in_.map(s =>
        h('li', {}, h('a', { class: 'row', href: '#' + s.id }, h('span', { class: 'main' }, h('span', { class: 't' }, s.name), s.where ? h('span', { class: 's' }, s.where) : null), h('span', { class: 'meta' }, '›')))))) : null;
    }),
    hs.notes ? h('section', { class: 'card' }, h('h2', {}, 'Good to know'), lines(hs.notes).map(l => h('p', {}, linked(l)))) : null,
    !list.length ? h('p', { class: 'empty' }, owner() ? ledger.notReady('site') || 'No systems yet. Add them under Edit.' : 'This house manual is empty for now.') : null,
  ];
}

// A page's photo, under Where: tap it for the whole picture. One that doesn't load (not in the repo yet, or not kept on a
// phone with no signal) goes from a tenant's page; the owner is told which file it was.
function photoFig(s) {
  const n = photoName(s.photo);
  if (!n) return null;
  const src = 'photos/' + n, alt = `${s.name}${s.where ? ': ' + s.where : ''}`;
  const img = h('img', { src, alt, decoding: 'async' });
  const fig = h('figure', { class: 'photo' }, h('button', { type: 'button', class: 'photo-btn', 'aria-label': `The photo of ${s.name}, larger`, onclick: () => enlarge(src, alt) }, img));
  img.addEventListener('error', () => fig.replaceWith(owner() ? h('p', { class: 'msg bad photo-missing' }, `${src} didn't load. Is it in the photos folder of the placard repo?`) : ''));
  return fig;
}
function enlarge(src, alt) {
  const dlg = h('dialog', { class: 'photo-view', 'aria-label': alt },
    h('img', { src, alt }),
    h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Close')));
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.tagName === 'IMG') dlg.close(); });
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 50));
  document.body.append(dlg);
  dlg.showModal();
}

// A link or a phone number in a page's text, tappable (text nodes and links only, never HTML).
const linked = t => splitLinks(t).map(p => !p.href ? p.text : p.href.startsWith('tel:') ? h('a', { href: p.href }, p.text)
  : h('a', { href: p.href, target: '_blank', rel: 'noopener' }, p.text));

function renderSystem(s) {
  const hs = house();
  const steps = lines(s.steps);
  // a detail with no value yet: the owner sees it, to fill in; a tenant doesn't
  const facts = s.facts.filter(([, v]) => v.trim() || owner());
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ ' + (hs.title || 'House manual'))),
    h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, KINDS.find(k => k[0] === group(s))[1]), h('div', { class: 'tape' }, s.name)),
    lifeSafety(s) ? fireLine() : null,
    s.where ? h('p', { class: 'where' }, h('b', {}, 'Where: '), s.where) : null,
    photoFig(s),
    s.summary ? h('p', { class: 'lead' }, s.summary) : null,
    s.warn ? h('div', { class: 'notice warn' }, h('p', {}, s.warn)) : null,
    steps.length ? h('section', {}, h('h2', {}, 'What to do'), h('ol', { class: 'steps' }, steps.map(l => h('li', {}, linked(l))))) : null,
    facts.length ? h('section', { class: 'card' }, h('h2', {}, 'Details'), h('dl', { class: 'facts' }, facts.map(([k, v]) =>
      !k ? h('dd', { class: 'whole' }, linked(v)) : [h('dt', {}, k), v ? h('dd', {}, linked(v)) : h('dd', { class: 'blank' }, 'to fill in')]))) : null,
    s.care || doneText(s) ? h('section', {}, h('h2', {}, 'Looking after it'), lines(s.care).map(l => h('p', {}, linked(l))),
      doneText(s) ? h('p', { class: 'done' }, doneText(s)) : null,
      // the owner also sees when it's next due
      owner() && nextDue(s) ? h('p', { class: 'msg due ' + (isDue(s, today()) ? 'bad' : '') }, `${isDue(s, today()) ? 'Due since' : 'Next due'} ${dayText(nextDue(s))}.`) : null) : null,
    s.manual ? h('p', {}, h('a', { class: 'btn ghost', href: s.manual, target: '_blank', rel: 'noopener' }, 'The manual')) : null,
    // the starter's pages are blank until the owner walks the house: say so rather than show an empty page
    !(s.where || photoName(s.photo) || s.summary || s.warn || steps.length || facts.length || s.care || doneText(s) || s.manual) ? h('p', { class: 'empty' }, 'Nothing written here yet. Call or report below.') : null,
    contactCard(hs.contact, { first: numberOf(s) }),
    reportButton(s, 'Report a problem or log a visit'),
    owner() ? ownerTools(s) : null,
  ];
}

// The report form. A report typed on one bar in a basement must not be lost: what's typed stays on the phone
// (placard.draft, one per page, with the time it was typed) until a send works, and the form opens with it next time.
// Send waits for the answer; if it fails the form stays open with the text, says so, and offers a text message to the
// house contact instead. Once the form is closed, a line under the report button says it hasn't gone, with Send it now,
// and Discard for one that isn't wanted after all (typed and closed, or phoned in instead). Nothing sends it by itself:
// a report Google got but answered late would go twice.
const DRAFTS = 'placard.draft';
const draftOf = key => (jget(DRAFTS) || {})[key] || null;
const keepDraft = (key, v) => {
  const all = jget(DRAFTS) || {};
  if (v && (v.text || v.name || v.contact)) all[key] = { ...v, at: Date.now() }; else delete all[key];
  jset(DRAFTS, all);
};
// Sends a report from this page (s: the page, or null for the front page); resolves to what the ledger said
// ({ emailed, repeat, firstAt, firstEmailed }: repeat when the same words went from this page in the last hour, and
// weren't emailed again; firstEmailed false when that first one wasn't emailed either), or throws if it didn't go. The draft goes once the ledger has it. One send per page at a time: a form closed
// while its report is on the way leaves the line under the button saying Sending…, so the same report can't go twice.
const sending = {};
function sendReport(s, v, website = '') {
  const key = s?.id || '';
  if (sending[key]) return sending[key];
  return (sending[key] = (async () => {
    const doc = { kind: v.kind, text: v.text, name: v.name, contact: v.contact, website, system: s?.id || '', systemName: s?.name || '' };
    const j = demo ? ledger.demo.handle({ op: 'report', app: 'placard', coll: 'reports', doc })
      : await publicReport(owner() ? ledger.cfg.url : LEDGER_URL, 'placard', 'reports', doc);
    const done = { at: Date.now(), emailed: j?.emailed !== false };  // a ledger script before 1.1 doesn't say: it always tried
    if (j?.repeat) Object.assign(done, { repeat: true, firstAt: Date.parse(j.firstAt) || 0, firstEmailed: j.firstEmailed !== false });
    keepDraft(key, null);
    sent[key] = done;
    try { sessionStorage.setItem('placard.sent', JSON.stringify(sent)); } catch {}
    return done;
  })()).finally(() => { delete sending[key]; render(); });
}
// A repeat: when the first went, and whether it was emailed (the ledger kept it without an email past the day's 20, say)
const already = d => d.firstEmailed === false ? `Already saved${d.firstAt ? ` at ${clock(d.firstAt)}` : ''}, but it wasn't emailed. If it's urgent, call.`
  : d.firstAt ? `Already sent at ${clock(d.firstAt)}. If it's urgent, call.` : 'Already sent. If it\'s urgent, call.';
const sentToast = d => toast(d.repeat ? already(d) : d.emailed ? 'Sent. The owner gets it by email.' : 'Saved for the owner. If it\'s urgent, call.');
const failLine = err => /too many/.test(err.message) ? 'Too many reports this hour. Your message is kept: please call.' : 'Couldn\'t send it. Your message is kept: try again, or call.';
// "No hot water since the power cut this…"
const excerpt = t => (t.length > 40 ? t.slice(0, 40).replace(/\s+\S*$/, '') + '…' : t);
const dayShort = at => {
  const d = new Date(at), day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.getFullYear() === new Date().getFullYear() ? day : `${day}, ${d.getFullYear()}`;
};
// When a report from each page went in this tab, for the line under its button.
let sent = {};
try { sent = JSON.parse(sessionStorage.getItem('placard.sent') || '{}'); } catch {}

function reportButton(s, label) {
  const key = s?.id || '', done = sent[key], kept = draftOf(key);
  const unsent = kept?.text ? h('div', { class: 'unsent' },
    h('p', { class: 'msg wait' }, `Not sent yet: "${excerpt(kept.text)}"${kept.at ? ` (${dayShort(kept.at)})` : ''}.`),
    h('div', { class: 'btns' }, sending[key] ? h('button', { type: 'button', class: 'btn', disabled: true }, 'Sending…') : [h('button', { type: 'button', class: 'btn', onclick: async e => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = 'Sending…';
      try { const done = await sendReport(s, kept); render(); sentToast(done); }
      catch (err) { b.disabled = false; b.textContent = 'Send it now'; toast(failLine(err), 'bad'); }
    } }, 'Send it now'),
    h('button', { type: 'button', class: 'btn ghost', onclick: async () => {
      if (!await confirmSheet('Discard this report?', `"${excerpt(kept.text)}" goes from this phone, and the form opens empty.`, 'Discard', { danger: true })) return;
      keepDraft(key, null); render(); toast('Discarded.');
    } }, 'Discard')])) : null;
  return [
    h('div', { class: 'btns stack' }, h('button', { type: 'button', class: 'btn ghost wide', onclick: () => report(s) }, label)),
    unsent || (done ? h('p', { class: 'msg ok sent' }, done.repeat ? already(done) : done.emailed ? `Sent to the owner at ${clock(done.at)}.` : `Saved for the owner at ${clock(done.at)}. If it's urgent, call.`) : null),
  ];
}

function report(s) {
  const key = s?.id || '', c = house().contact || {}, tel = dial(c.phone), was = draftOf(key) || {};
  // the urgent line: 911 on the smoke and CO alarm page (and any emergency page under Safety), the house contact elsewhere
  const urgent = lifeSafety(s) ? { tel: '911', said: 'Call 911 now' } : tel ? { tel, said: `Call ${c.phone} now` } : null;
  const field = (name, label, input, hint) => h('label', { class: 'field', for: 'f-' + name }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
  const kind = h('select', { id: 'f-kind', name: 'kind' }, ['Problem', 'Service visit', 'Question'].map(o => h('option', { value: o, selected: o === was.kind }, o)));
  const text = h('textarea', { id: 'f-text', name: 'text', rows: 4, required: true, placeholder: s?.name ? `About the ${s.name.toLowerCase()}…` : '' });
  const name = h('input', { id: 'f-name', name: 'name', type: 'text', autocomplete: 'off' });
  const contact = h('input', { id: 'f-contact', name: 'contact', type: 'text', autocomplete: 'off' });
  // The field only robots fill in: off the screen, out of the tab order and never autofilled. The ledger drops any
  // report that has it.
  const trap = h('input', { id: 'f-website', name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off' });
  text.value = was.text || ''; name.value = was.name || ''; contact.value = was.contact || '';
  const values = () => ({ kind: kind.value, text: text.value.trim(), name: name.value.trim(), contact: contact.value.trim() });
  const msg = h('p', { class: 'msg', 'aria-live': 'polite' });
  const sms = h('a', { class: 'btn ghost wide sms', hidden: true }, 'Text it instead');
  // ?&body= so the text comes through on an iPhone (which reads &body=) and on Android (which reads the query)
  const smsHref = () => `sms:${tel}?&body=${encodeURIComponent([s?.name, values().text].filter(Boolean).join(': ') + (values().name ? ` (${values().name})` : ''))}`;
  const send = h('button', { type: 'submit', class: 'btn' }, 'Send');
  // as the kit's sheets: the title names the form, and on a touch screen takes the focus, so the keyboard waits for a tap
  const head = h('h2', { id: 'report-title' }, 'Tell the owner');
  const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': 'report-title' });
  const form = h('form', { method: 'dialog' },
    // the whole amber band is the link, a target a thumb can't miss
    urgent ? h('a', { class: 'notice warn call-now', href: 'tel:' + urgent.tel }, 'Urgent? ', h('b', {}, urgent.said), '.') : null,
    field('kind', 'This is', kind),
    field('text', 'What happened', text),
    field('name', 'Your name', name),
    field('contact', 'Phone or email', contact, 'So we can get back to you.'),
    h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', { for: 'f-website' }, 'Leave this empty'), trap),
    msg, sms,
    h('div', { class: 'sheet-bar' }, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), send));
  const say = (line, kind = '') => { msg.textContent = line; msg.className = 'msg ' + kind; };
  form.addEventListener('input', () => { keepDraft(key, values()); if (!sms.hidden) sms.href = smsHref(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = values();
    if (!v.text) { say('Write what happened first.', 'bad'); return; }
    keepDraft(key, v);
    send.disabled = true; send.textContent = 'Sending…'; say(''); sms.hidden = true;
    try {
      const done = await sendReport(s, v, trap.value);
      if (dlg.open) dlg.close();
      render();
      sentToast(done);
    } catch (err) {
      send.disabled = false; send.textContent = 'Send';
      const line = failLine(err);
      if (!dlg.open) { toast(line, 'bad'); render(); return; }
      say(line, 'bad');
      if (tel) { sms.href = smsHref(); sms.hidden = false; }
    }
  });
  // closed: the page behind says whether something typed there hasn't gone
  dlg.addEventListener('close', () => { setTimeout(() => dlg.remove(), 50); render(); });
  if (matchMedia('(pointer: coarse)').matches) { head.setAttribute('tabindex', '-1'); head.setAttribute('autofocus', ''); }
  else kind.setAttribute('autofocus', '');
  dlg.append(head, form);
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------------------------------------------------------- owner
// The name of the page another Placard sticker opens, for the sticker panel's lines ("This sticker opens Water heater,
// not Furnace"); another app's sticker the panel names itself.
const stickerName = t => t.letter !== 'h' ? null : FRONT.has(t.id) ? 'the front page' : sys(t.id)?.name || sentFrom(t.id)?.name || null;
// A locked page's sticker can't be rewritten, but deleting the page can send it to another one (deletePage).
const MOVE_PAGE = 'To send it to another page, delete this one (Edit this page, then Delete) and pick where its sticker goes.';
function ownerTools(s) {
  return h('section', { class: 'owner card' },
    h('h2', {}, 'Owner'),
    h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => editSystem(s) }, 'Edit this page')),
    // A new sticker written for a locked page is a replacement (the page is then written, not locked, until it's locked
    // too) or a spare to keep (the page stays locked; spare and spareLocked say when one was last written and locked).
    nfcPanel(tagUrl('h', s.id), { lock: true, label: 'Write sticker', sample: !!ledger.demo, tagged: s.tagged, locked: s.locked, name: s.name, nameOf: stickerName, move: MOVE_PAGE,
      spare: s.spare, spareLocked: s.spareLocked,
      onWritten: () => save({ ...(sys(s.id) || s), tagged: today(), locked: null }), onLocked: () => save({ ...(sys(s.id) || s), locked: today() }),
      onSpare: () => save({ ...(sys(s.id) || s), spare: today(), spareLocked: null }), onSpareLocked: () => save({ ...(sys(s.id) || s), spareLocked: today() }) }));
}

// Why the ledger can't take a page ('' when it can): over 45,000 characters, or an id it refuses. An edit sheet says it
// and stays open (its check); save() says it in a toast.
const refusedPage = doc => {
  const why = refusal(doc);
  return why === 'too big' ? 'Too long to save: over 45,000 characters. Shorten it, or link the manual instead.' : why ? `"${doc.id}" can't be a page's id: letters, digits and dashes only.` : '';
};
// Saves a page; says so and returns false if the ledger couldn't take it.
function save(doc) {
  try { ledger.put('site', doc); }
  catch (e) {
    if (!e.refused) throw e;
    toast(refusedPage(doc), 'bad');
    return false;
  }
  fromLedger(); render(); return true;
}
// After a save: tenants see it only once it has reached the sheet, so say which. (A send already on its way when the
// save was made can come back first; the save goes in the next one.)
async function saidSaved(id) {
  for (let i = 0; i < 3 && ledger.waiting('site').includes(id); i++) if (!(await ledger.flush())) break;
  if (ledger.waiting('site').includes(id)) { toast('Saved on this device. Tenants see it once it\'s sent.'); return; }
  if (demo) { toast('Saved. Tenants see it now.'); return; }
  if (!LEDGER_URL) { toast('Saved. Tenants see it once js/config.js has the ledger address.'); return; }
  const seen = await checkTenants();
  toast(seen === 'ok' ? 'Saved. Tenants see it now.' : seen === 'other' ? 'Saved. Tenants may not see it: js/config.js has another ledger address.'
    : seen === 'failed' ? 'Saved. Tenants can\'t open the manual: the address in js/config.js didn\'t answer.' : 'Saved.', seen === 'ok' || !seen ? '' : 'bad');
}

// What tenants get: the owner's phone reads LEDGER_URL as a tenant's would (no key), once each time the Edit screen
// opens and after a save. 'ok', 'other' (it answers, but isn't this phone's ledger address), 'failed' (it didn't
// answer: a mistyped address, or a deployment archived or not set to Anyone), or '' (couldn't tell: no signal here, or
// a read of this phone's own address that failed).
let tenants = '';
async function checkTenants() {
  if (demo || !LEDGER_URL) return '';
  try { await publicRead(LEDGER_URL, 'placard', 'site'); tenants = LEDGER_URL.trim() === ledger.cfg.url ? 'ok' : 'other'; }
  // config.js holding this phone's own address, which this phone's ledger answers on: tenants can reach it, so a read
  // that failed is this phone's line (one bar, a dropped connection), not the address
  catch (e) { tenants = LEDGER_URL.trim() === ledger.cfg.url || !navigator.onLine || e.kind === 'offline' || ledger.state === 'offline' ? '' : 'failed'; }
  if (route().view === 'owner') render();
  return tenants;
}
const tenantNotice = () => {
  const fix = 'Put this phone\'s address in it (Part 1 of the guide).';
  if (demo) return null;
  if (!LEDGER_URL) return h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'Tenants can\'t see this yet. '), 'Put the ledger address in js/config.js in the repo (Part 1 of the guide).'));
  if (tenants === 'failed') return h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'Tenants can\'t open the manual: '), 'the address in js/config.js didn\'t answer. ' + fix));
  if (tenants === 'other') return h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'Tenants may be reading another ledger: '), 'the address in js/config.js isn\'t this phone\'s ledger address. ' + fix));
  return null;
};

async function editSystem(s) {
  const exists = !!(s?._updated && sys(s.id));   // a sticker page's stub has no saved time: always a new page
  const made = v => ({ ...(s || {}), id: s?.id || uniqueId(v.name), name: v.name, where: v.where, kind: v.kind, emergency: v.emergency === 'yes', summary: v.summary,
    steps: v.steps, facts: parseFacts(v.facts), care: v.care, warn: v.warn, manual: v.manual, order: Number(v.order) || 99, photo: photoName(v.photo) || '',
    task: v.task, every: everyOf(v.every) || '', lastDone: isoDay(v.lastDone),
    ...(v.call != null ? { call: v.call } : {}) });
  // a Save that can't go keeps the sheet open with everything typed: too long, an id the ledger refuses, or the ledger
  // not heard from yet
  const check = v => {
    if (!exists && !ledger.synced('site')) return STILL_LOADING;
    if (s?.id && FRONT.has(s.id)) return `"${s.id}" is the front page's own address: pick another.`;
    if (photoName(v.photo) === null) return { line: 'A photo is the name of a file in the photos folder, like water-shutoff.jpg (a .jpg, .png or .webp).', field: 'photo' };
    if (v.every && !everyOf(v.every)) return { line: 'Every: a whole number of months, from 1 to 120.', field: 'every' };
    return refusedPage(made(v));
  };
  const v = await sheet({ title: exists ? 'Edit ' + s.name : 'New system', danger: exists ? 'Delete' : null, check, fields: [
    { name: 'name', label: 'Name', value: s?.name, required: true },
    { name: 'where', label: 'Where it is', value: s?.where, placeholder: 'Basement, left of the stairs' },
    { name: 'photo', label: 'Photo', value: s?.photo, placeholder: 'water-shutoff.jpg',
      hint: 'A file in the photos folder of the placard repo: about 1200 px wide, under 200 KB, and nothing showing the house number or street.' },
    { name: 'kind', label: 'Group', type: 'select', value: s?.kind || 'other',
      options: s?.kind && group(s) !== s.kind ? [...KINDS, [s.kind, `${s.kind} (shown under Everything else)`]] : KINDS },
    { name: 'emergency', label: 'Show under "In an emergency"', type: 'select', value: s?.emergency ? 'yes' : 'no', options: [['no', 'No'], ['yes', 'Yes']] },
    { name: 'summary', label: 'What it is', type: 'textarea', value: s?.summary },
    { name: 'steps', label: 'What to do (one step per line)', type: 'textarea', rows: 4, value: s?.steps },
    { name: 'facts', label: 'Details (one "Label: value" per line)', type: 'textarea', rows: 4, value: factsText(s?.facts), placeholder: 'Model: XE50T10\nFilter: 16 × 25 × 1' },
    { name: 'care', label: 'Looking after it', type: 'textarea', value: s?.care },
    { name: 'task', label: 'A regular job', value: s?.task, placeholder: 'Filter change',
      hint: 'Tenants read "Last filter change: Nov 3, 2026. Every 3 months." Your Edit list says due once it\'s past.' },
    // step any: a half or a 0 reaches the sheet's check, which says what it takes, instead of the browser's own bubble
    { name: 'every', label: 'Every (months)', type: 'number', value: everyOf(s?.every) || '', inputmode: 'numeric', step: 'any' },
    { name: 'lastDone', label: 'Last done', type: 'date', value: isoDay(s?.lastDone) },
    { name: 'warn', label: 'Warning (shown in amber)', type: 'textarea', rows: 2, value: s?.warn },
    { name: 'manual', label: 'Link to the manual', type: 'url', value: s?.manual },
    { name: 'order', label: 'Order on the page', type: 'number', value: s?.order ?? systems().length + 1, inputmode: 'numeric' },
    // once the house has other numbers: which one this page's card shows (a number since deleted reads as the first)
    numbers().length ? { name: 'call', label: 'Number on its card', type: 'select', value: numberOf(s)?.id || '',
      options: [['', `Who to call${house().contact?.name ? ` (${house().contact.name})` : ''}`], ...numbers().map(n => [n.id, n.name])] } : null,
  ].filter(Boolean) });
  if (!v) return;
  if (v.__danger) { await deletePage(s); return; }
  const doc = made(v), id = doc.id;
  // the page came in from the ledger while the sheet was open (made on another device): it isn't saved over
  if (!exists && sys(id)) { toast('That page is in the manual now. Open it to edit it.', 'bad'); fromLedger(); go('#' + id); render(); return; }
  if (!save(doc)) return;
  saidSaved(id);
  if (!exists) go('#' + id);
}
// Delete a page. One whose sticker is written or locked, or that stickers of pages deleted before were sent to, asks
// where they should go instead (the front page unless picked): its own record is left in its place to send its sticker
// there, and those sent here go there too. Nowhere: as a page with no sticker, its address says it isn't in the manual.
async function deletePage(s) {
  const own = !!(s.tagged || s.locked), here = sentOn().filter(f => f.to === s.id);
  if (!own && !here.length) {
    if (await confirmSheet('Delete ' + s.name + '?', 'Its page goes. A sticker written for it will open a page saying it isn\'t in the manual yet, with Who to call and the whole manual.', 'Delete', { danger: true })) {
      ledger.del('site', s.id); fromLedger(); go('#/owner');
    }
    return;
  }
  const from = andList(here.map(f => f.name)), many = (own ? 1 : 0) + here.length > 1;
  const whose = own && here.length ? `Its sticker (${s.locked ? 'locked' : 'written'}), and the one${here.length > 1 ? 's' : ''} sent here from ${from}, will`
    : own ? `Its sticker (${s.locked ? 'locked' : 'written'}) will` : `The sticker${here.length > 1 ? 's' : ''} sent here from ${from} will`;
  const pick = h('select', { id: 'f-to', name: 'to' },
    [['house', 'The front page'], ...systems().filter(x => x.id !== s.id).map(x => [x.id, x.name]), ['', 'Nowhere: a page saying it isn\'t in the manual']]
      .map(([v, l]) => h('option', { value: v, selected: v === 'house' }, l)));
  const v = await sheet({ title: 'Delete ' + s.name + '?', ok: 'Delete', okDanger: true, body: h('div', {},
    h('p', {}, `Its page goes. ${whose} keep opening this page's address. Send ${many ? 'them' : 'it'} to another page instead?`),
    h('label', { class: 'field', for: 'f-to' }, h('span', {}, many ? 'Send them to' : 'Send it to'), pick)) });
  if (!v) return;
  const to = pick.value;
  if (to && own) ledger.put('site', { id: s.id, to, name: s.name, tagged: s.tagged || null, locked: s.locked || null });
  else ledger.del('site', s.id);
  if (to) for (const f of here) ledger.put('site', { ...(ledger.doc('site', f.id) || f), to });
  fromLedger(); go('#/owner');
  const opensNow = own && !here.length ? 'Its sticker opens' : !own && here.length === 1 ? `${here[0].name}'s sticker opens` : 'The stickers open';
  toast(to ? `Deleted. ${opensNow} ${pageName(to)}.` : 'Deleted.');
}
// "Boiler", "Boiler and Old fridge", "Boiler, Well and Old fridge"
const andList = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

// One of the house's other numbers, added or changed from the Edit screen, saved on the house doc; Delete asks first and
// says which pages' cards go back to the house contact.
async function editNumber(n) {
  const v = await sheet({ title: n ? n.name : 'Another number', danger: n ? 'Delete' : null,
    check: v => !site.some(d => d.id === 'house') && !ledger.synced('site') ? STILL_LOADING : !dial(v.phone) ? { line: 'Put in a phone number to call.', field: 'phone' } : '',
    fields: [
      { name: 'name', label: 'Who', value: n?.name, required: true, placeholder: 'Septic company' },
      { name: 'phone', label: 'Phone', type: 'tel', value: n?.phone },
      { name: 'note', label: 'When to call', type: 'textarea', rows: 2, value: n?.note, placeholder: 'The septic alarm sounds, or a drain backs up' }] });
  if (!v) return;
  const list = numbers();
  if (v.__danger) {
    const used = systems().filter(s => s.call === n.id), c = house().contact || {};
    if (!await confirmSheet(`Delete ${n.name}?`, used.length ? `${andList(used.map(s => s.name))} will show ${c.name || 'the house contact'} on ${used.length > 1 ? 'their cards' : 'its card'} instead.`
      : 'It goes from the front page\'s Who to call.', 'Delete', { danger: true })) return;
    if (save({ ...house(), id: 'house', numbers: list.filter(x => x.id !== n.id) })) saidSaved('house');
    return;
  }
  let id = n?.id;
  if (!id) { const base = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'number'; id = base; for (let i = 2; list.some(x => x.id === id); i++) id = `${base}-${i}`; }
  const doc = { id, name: v.name, phone: v.phone, note: v.note };
  if (save({ ...house(), id: 'house', numbers: n ? list.map(x => x.id === n.id ? doc : x) : [...list, doc] })) saidSaved('house');
}

// A sticker sent elsewhere, from the Edit list: where it goes, changed, or not sent anywhere any more (its address then
// says the page isn't in the manual, with Make this page for the owner).
async function editSent(f) {
  const v = await sheet({ title: `${f.name}'s sticker`, danger: 'Stop sending it', fields: [
    { name: 'to', label: 'Opens', type: 'select', value: f.to, hint: 'Its page was deleted, so its sticker opens this page instead.',
      options: [['house', 'The front page'], ...systems().map(x => [x.id, x.name]), ...(f.to === 'house' || sys(f.to) ? [] : [[f.to, pageName(f.to)]])] }] });
  if (!v) return;
  if (v.__danger) {
    if (!await confirmSheet(`Stop sending ${f.name}'s sticker?`, 'It will open a page saying it isn\'t in the manual, with Who to call and the whole manual.', 'Stop sending it', { danger: true })) return;
    ledger.del('site', f.id); fromLedger(); render(); return;
  }
  if (v.to && v.to !== f.to) { ledger.put('site', { ...(ledger.doc('site', f.id) || f), to: v.to }); fromLedger(); render(); }
}

function uniqueId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'system';
  let id = base, n = 2;
  while (FRONT.has(id) || site.some(d => d.id === id)) id = `${base}-${n++}`;
  return id;
}

async function editHouse() {
  const hs = house(), c = hs.contact || {};
  const made = v => ({ ...hs, id: 'house', title: v.title, intro: v.intro, notes: v.notes, contact: { name: v.cname, phone: v.phone, email: v.email, note: v.cnote } });
  const check = v => !site.some(d => d.id === 'house') && !ledger.synced('site') ? STILL_LOADING : refusedPage(made(v));
  const v = await sheet({ title: 'The house', check, fields: [
    { name: 'title', label: 'Title', value: hs.title || 'House manual' },
    { name: 'intro', label: 'Welcome line', type: 'textarea', value: hs.intro },
    { name: 'cname', label: 'Who to call', value: c.name, placeholder: 'The property manager' },
    { name: 'phone', label: 'Phone', type: 'tel', value: c.phone },
    { name: 'email', label: 'Email', type: 'email', value: c.email },
    { name: 'cnote', label: 'When to call', type: 'textarea', rows: 2, value: c.note },
    { name: 'notes', label: 'Good to know (one per line)', type: 'textarea', value: hs.notes },
  ] });
  if (!v || v.__danger) return;
  // there was no house page when the sheet opened, and one came in from the ledger since: it isn't saved over
  if (!hs._updated && house()._updated) { toast('The house page came in from the ledger. Open House and contact again.', 'bad'); render(); return; }
  if (save(made(v))) saidSaved('house');
}

async function addFromStarter() {
  const have = new Set(site.map(d => d.id));
  const left = STARTER.filter(s => !have.has(s.id));
  const v = await sheet({ title: 'Add a system', ok: 'Add', check: v => v.pick && v.pick !== '__new' && !ledger.synced('site') ? STILL_LOADING : '', fields: [
    { name: 'pick', label: 'From the usual list', type: 'select', options: [['', 'Pick one…'], ...left.map(s => [s.id, s.name]), ['__new', 'Something else…']] },
  ] });
  if (!v || !v.pick) return;
  if (v.pick === '__new') return editSystem(null);
  // another device added it while the list was open: its page stays as it is
  if (sys(v.pick)) { toast('That page is in the manual now.', 'bad'); fromLedger(); go('#' + v.pick); return; }
  save({ ...STARTER.find(s => s.id === v.pick) });
  go('#' + v.pick);
}

// An import file ({ docs: [...] }, or a list of pages) only fills in (mergeImport): a new page is added, one here gets
// what's blank in it and details it doesn't have, and a Where line, contact or detail typed here is never blanked or
// replaced. A page deleted here stays deleted; one in the wrong shape is skipped and named.
function importFacts() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    if (!ledger.synced('site')) { toast(STILL_LOADING, 'bad'); return; }
    await ledger.catchUp(['site']);
    let merged;
    try {
      const data = JSON.parse(await input.files[0].text());
      const docs = Array.isArray(data) ? data : data?.docs;
      if (!Array.isArray(docs)) throw new Error('no pages');
      merged = mergeImport(docs, id => ledger.doc('site', id), id => ledger.gone('site', id) || sendsOn(ledger.doc('site', id)));
    } catch { toast('That file isn\'t a Placard import.', 'bad'); return; }
    for (const doc of merged.puts) ledger.put('site', doc);
    fromLedger(); render();
    toast(importSummary(merged.res, ['page', 'pages']), merged.res.skipped.length ? 'bad' : '');
  });
  input.click();
}

function renderOwner() {
  const list = systems();
  const reports = groupReports(ledger.docs('reports')).filter(c => !c.handled), wait = ledger.notReady('site');
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ Front page')),
    h('h2', {}, 'Edit the manual'),
    tenantNotice(),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'btn', disabled: !!wait, onclick: fresh(editHouse) }, 'House and contact'),
      h('button', { type: 'button', class: 'btn ghost', disabled: !!wait, onclick: fresh(addFromStarter) }, 'Add a system'),
      h('a', { class: 'btn ghost', href: '#/print' }, 'QR stickers'),
      h('a', { class: 'btn ghost', href: '#/manual' }, 'Print the manual'),
      h('a', { class: 'btn ghost', href: '#/reports' }, `Reports${reports.length ? ' (' + reports.length + ')' : ''}`),
      h('button', { type: 'button', class: 'btn ghost', disabled: !!wait, onclick: importFacts }, 'Import')),
    wait ? h('p', { class: 'empty' }, wait) : null,
    h('ul', { class: 'list' }, list.map(s => h('li', {}, h('a', { class: 'row', href: '#' + s.id },
      h('span', { class: 'main' }, h('span', { class: 't' }, s.name), h('span', { class: 's' }, s.where || 'No location yet')),
      h('span', { class: 'chips' }, s.facts.some(([, v]) => !v.trim()) ? h('span', { class: 'chip warn' }, 'blank details') : null,
        isDue(s, today()) ? h('span', { class: 'chip warn due' }, 'due') : null,
        h('span', { class: 'chip ' + (s.locked ? 'ok' : s.tagged ? 'warn' : '') }, s.locked ? 'locked' : s.tagged ? 'written' : 'no tag')))))),
    wait ? null : h('section', { class: 'numbers' }, h('h3', {}, 'Other numbers'),
      numbers().length ? h('ul', { class: 'list' }, numbers().map(n => h('li', {}, h('button', { type: 'button', class: 'row', onclick: fresh(() => editNumber(n)) },
        h('span', { class: 'main' }, h('span', { class: 't' }, n.name), h('span', { class: 's' }, [n.phone, usedOn(n)].filter(Boolean).join(' · ')))))))
        : h('p', { class: 'muted' }, 'The septic company, the power company\'s outage line, a backup if the manager doesn\'t answer: shown under Who to call, and a page can show one on its card instead.'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn ghost', onclick: fresh(() => editNumber(null)) }, 'Add a number'))),
    !wait && sentOn().length ? h('section', {}, h('h3', {}, 'Stickers sent to another page'),
      h('ul', { class: 'list sent-on' }, sentOn().map(f => h('li', {}, h('button', { type: 'button', class: 'row', onclick: () => editSent(f) },
        h('span', { class: 'main' }, h('span', { class: 't' }, f.name), h('span', { class: 's' }, `sticker → ${pageName(landing(f.id))}`)),
        h('span', { class: 'chips' }, h('span', { class: 'chip ' + (f.locked ? 'ok' : 'warn') }, f.locked ? 'locked' : 'written'))))))) : null,
    wait ? null : frontTag(),
  ];
}

// "on Septic system's card", "on 2 pages' cards"
const usedOn = n => { const on = systems().filter(s => s.call === n.id); return !on.length ? '' : on.length === 1 ? `on ${on[0].name}'s card` : `on ${on.length} pages' cards`; };

// The front page's own sticker (h/house): the whole manual, for inside the front door. Written and locked like a
// system's, and saved on the house doc.
function frontTag() {
  const hs = house(), mark = v => save({ ...house(), id: 'house', ...v });
  return h('section', { class: 'owner card front-tag' },
    h('h2', {}, 'Front-door sticker'),
    h('p', { class: 'muted' }, 'Opens the whole manual. Put it inside the front door; its QR card is the first on the sheet.'),
    nfcPanel(tagUrl('h', 'house'), { lock: true, label: 'Write sticker', sample: !!ledger.demo, tagged: hs.tagged, locked: hs.locked, name: 'the front page', nameOf: stickerName,
      spare: hs.spare, spareLocked: hs.spareLocked,
      onWritten: () => mark({ tagged: today(), locked: null }), onLocked: () => mark({ locked: today() }),
      onSpare: () => mark({ spare: today(), spareLocked: null }), onSpareLocked: () => mark({ spareLocked: today() }) }));
}

// The QR library comes the first time the QR sheet opens (a tenant's tap never waits for it): until then a line says so,
// and the sheet is drawn again when it has come.
let qrAsked = false, qrFailed = false;
function renderPrint() {
  const title = house().title || 'House manual';
  if (!window.qrcode) {
    if (!qrAsked) { qrAsked = true; loadQr().then(render, () => { qrFailed = true; render(); }); }
    return [h('div', { class: 'no-print' }, h('p', { class: 'crumb' }, h('a', { href: '#/owner' }, '‹ Edit')), h('h2', {}, 'QR stickers'),
      h('p', { class: 'empty', role: 'status' }, qrFailed ? 'The QR codes didn\'t load. Reload the page to try again.' : 'Making the QR codes…'))];
  }
  const qrCard = (id, name, line, small, s = null) => h('div', { class: 'qr-card' + (s?.emergency ? ' sos' : '') },
    h('div', { class: 'qr', 'data-url': tagUrl('h', id), html: qrSvg(tagUrl('h', id), { size: 110 }) }),
    h('div', {}, h('b', {}, name), h('span', {}, line), small ? h('small', {}, small) : null),
    s?.emergency ? firstSteps(s) : null);
  return [
    h('div', { class: 'no-print' }, h('p', { class: 'crumb' }, h('a', { href: '#/owner' }, '‹ Edit')), h('h2', {}, 'QR stickers'),
      h('p', { class: 'muted' }, 'A backup beside each NFC sticker, for phones with NFC off. Print on label paper or plain paper, cut, and tape over with clear packing tape.'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => print() }, 'Print'))),
    h('div', { class: 'qr-sheet' },
      qrCard('house', 'House manual', 'Tap or scan for the whole manual.', title === 'House manual' ? '' : title),
      systems().map(s => qrCard(s.id, s.name, 'Tap a phone on the sticker, or scan, for what to do.', title, s))),
  ];
}
// An emergency page's card carries its first steps under the code, for a tenant in a basement with no signal whose
// phone has never opened the manual: the 911 line first on a Safety page, then up to four steps, a line saying there's
// more on the page, and the number its page's card shows ("Call the number below" is then true on paper too). The card
// is twice the height of the others in print (two rows of the sheet).
const CARD_STEPS = 4;
function firstSteps(s) {
  const steps = lines(s.steps), shown = steps.slice(0, CARD_STEPS), who = numberOf(s) || house().contact || {};
  if (!shown.length && !lifeSafety(s)) return null;
  return h('div', { class: 'qr-steps' + (shown.join('').length > 420 ? ' tight' : '') },
    lifeSafety(s) ? h('p', { class: 'qr-fire' }, FIRE) : null,
    shown.length ? h('ol', {}, shown.map(l => h('li', {}, l))) : null,
    steps.length > CARD_STEPS ? h('p', { class: 'qr-more' }, `${steps.length - CARD_STEPS} more on the page: tap or scan.`) : null,
    who.phone ? h('p', { class: 'qr-call' }, `Call ${who.name ? who.name + ', ' : ''}${who.phone}`) : null);
}

// The whole manual on paper, for a drawer or the lease packet: it works in a power cut with a flat phone, and for a
// manager who keeps paper. The cover has the welcome, the 911 line, who to call (every number written out), Good to know,
// the front door's code and the day it was printed; then the emergency pages in full, then every page by group (an
// emergency page there points to the front), a new sheet for each group. Each page has its small QR code, so the paper
// leads back to the live page. It waits for the QR library, as the QR sheet does.
const qrBox = (id, size) => h('div', { class: 'qr', 'data-url': tagUrl('h', id), html: qrSvg(tagUrl('h', id), { size }) });
const paperPerson = c => h('p', { class: 'pm-person' }, h('b', {}, c.name || 'Who to call'), c.phone ? ` ${c.phone}` : '', c.email ? ` · ${c.email}` : '', c.note ? h('span', {}, c.note) : null);
function renderManual() {
  const hs = house(), list = systems(), urgent = list.filter(s => s.emergency), c = hs.contact || {};
  const top = h('div', { class: 'no-print' }, h('p', { class: 'crumb' }, h('a', { href: '#/owner' }, '‹ Edit')), h('h2', {}, 'Print the manual'),
    h('p', { class: 'muted' }, 'The whole manual on paper, for a drawer or the lease packet: the emergency pages first, then every page by group, each with its QR code. Print on plain paper.'),
    window.qrcode ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => print() }, 'Print')) : null);
  if (!window.qrcode) {
    if (!qrAsked) { qrAsked = true; loadQr().then(render, () => { qrFailed = true; render(); }); }
    return [top, h('p', { class: 'empty', role: 'status' }, qrFailed ? 'The QR codes didn\'t load. Reload the page to try again.' : 'Making the QR codes…')];
  }
  return [top, h('article', { class: 'manual' },
    h('section', { class: 'pm-cover' },
      h('p', { class: 'tape-cap' }, 'House manual'), h('h2', { class: 'pm-title' }, hs.title || 'House manual'),
      hs.intro ? h('p', { class: 'lead' }, hs.intro) : null,
      h('p', { class: 'pm-fire' }, FIRE),
      reachable(c) || numbers().length ? h('section', { class: 'pm-call' }, h('h3', {}, 'Who to call'), reachable(c) ? paperPerson(c) : null, numbers().map(paperPerson)) : null,
      hs.notes ? h('section', {}, h('h3', {}, 'Good to know'), lines(hs.notes).map(l => h('p', {}, l))) : null,
      h('div', { class: 'pm-live' }, qrBox('house', 96), h('p', {}, 'Tap the sticker inside the front door, or scan this, for the live manual.')),
      h('p', { class: 'pm-printed' }, `Printed ${dayText(today())}. The live manual may be newer.`)),
    urgent.length ? h('section', { class: 'pm-group' }, h('h2', {}, 'In an emergency'), urgent.map(paperPage)) : null,
    KINDS.map(([k, label]) => {
      const in_ = list.filter(s => group(s) === k);
      return in_.length ? h('section', { class: 'pm-group' }, h('h2', {}, label),
        in_.map(s => s.emergency ? h('p', { class: 'pm-see' }, `${s.name}: with the emergency pages at the front.`) : paperPage(s))) : null;
    }))];
}
// One page as a tenant reads it (no blank details), with its links written out for paper and, at its foot, the number
// its card shows ("Call the number below" holds on paper too).
function paperPage(s) {
  const steps = lines(s.steps), facts = s.facts.filter(([, v]) => v.trim()), n = photoName(s.photo), c = house().contact || {};
  const who = numberOf(s) || (c.phone ? c : null);
  const img = n ? h('img', { class: 'pm-photo', src: 'photos/' + n, alt: `${s.name}${s.where ? ': ' + s.where : ''}` }) : null;
  img?.addEventListener('error', () => img.remove());
  return h('section', { class: 'pm-page' },
    h('div', { class: 'pm-head' }, h('div', {}, h('h3', {}, s.name), s.where ? h('p', { class: 'where' }, h('b', {}, 'Where: '), s.where) : null), qrBox(s.id, 72)),
    lifeSafety(s) ? h('p', { class: 'pm-fire' }, FIRE) : null,
    img,
    s.summary ? h('p', {}, s.summary) : null,
    s.warn ? h('p', { class: 'pm-warn' }, s.warn) : null,
    steps.length ? h('ol', { class: 'steps' }, steps.map(l => h('li', {}, l))) : null,
    facts.length ? h('dl', { class: 'facts' }, facts.map(([k, v]) => !k ? h('dd', { class: 'whole' }, v) : [h('dt', {}, k), h('dd', {}, v)])) : null,
    lines(s.care).map(l => h('p', {}, l)),
    doneText(s) ? h('p', { class: 'done' }, doneText(s)) : null,
    s.manual ? h('p', { class: 'pm-link' }, 'The manual: ', s.manual) : null,
    who?.phone ? h('p', { class: 'pm-person' }, h('b', {}, 'Who to call: '), `${who.name ? who.name + ', ' : ''}${who.phone}`) : null);
}

// One card for the same words from the same page on one day (groupReports): sent again, or kept by the ledger as a
// repeat, it says how many times and when, and one Mark handled does them all. A phone number left in a report gets
// Call and Text, an email address Email, each with the person's name when the card holds more than one person's.
function renderReports() {
  const cards = groupReports(ledger.docs('reports'));
  // A service visit marked handled offers to set its page's Last done to the visit's day (unless that's no later than it).
  const handle = async c => {
    const at = Date.now();
    for (const r of c.reports) if (r.status !== 'handled') ledger.put('reports', { ...r, status: 'handled', handled: today(), handledAt: at });
    render();
    const s = sys(c.first.system), t = Date.parse(c.last.at), day = today(Number.isFinite(t) ? new Date(t) : new Date());
    if (s && c.reports.some(r => r.kind === 'Service visit') && !(isoDay(s.lastDone) >= day)) await offerLastDone(s, day);
  };
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#/owner' }, '‹ Edit')), h('h2', {}, 'Reports'),
    cards.length ? h('ul', { class: 'list' }, cards.map(c => {
      const r = c.first, n = c.reports.length, at = Date.parse(r.at);
      const who = [...new Set(c.reports.map(x => [x.name, x.contact].filter(Boolean).join(' · ')).filter(Boolean))];
      // more than one person's number or address on a card (two roommates, the same words): each button names whose
      const reach = [...new Map(c.reports.map(x => ({ ...reachBy(x.contact), who: String(x.name || '').trim() })).filter(x => x.tel || x.email).map(x => [x.tel + ' ' + x.email, x])).values()];
      const named = (verb, x, fallback) => reach.length > 1 ? `${verb} ${x.who || fallback}` : verb;
      return h('li', { class: 'card report' + (c.handled ? ' dim' : '') },
        h('p', {}, h('span', { class: 'chip ' + (c.handled ? '' : 'warn') }, r.kind || 'Note'), ' ', h('b', {}, r.systemName || 'General'), ' ',
          h('small', {}, !Number.isFinite(at) ? '' : n > 1 ? dayShort(at) : stampText(at))),
        h('p', {}, r.text),
        n > 1 ? h('p', { class: 'muted times' }, `Sent ${n} times, ${timeSpan(at, Date.parse(c.last.at))}`) : null,
        h('p', { class: 'muted' }, who.join('; ') || 'No name left'),
        reach.length || !c.handled ? h('div', { class: 'btns' },
          reach.map(x => [x.tel ? h('a', { class: 'btn ghost', href: 'tel:' + x.tel }, named('Call', x, x.tel)) : null, x.tel ? h('a', { class: 'btn ghost', href: 'sms:' + x.tel }, named('Text', x, x.tel)) : null,
            x.email ? h('a', { class: 'btn ghost', href: 'mailto:' + x.email }, named('Email', x, x.email)) : null]),
          !c.handled ? h('button', { type: 'button', class: 'btn ghost', onclick: () => handle(c) }, 'Mark handled') : null) : null);
    })) : h('p', { class: 'empty' }, 'No reports yet.'),
  ];
}

// After a service visit is handled: its page's Last done, the visit's day unless changed. Not now leaves the page as it is.
async function offerLastDone(s, day) {
  const v = await sheet({ title: `${s.name}: set Last done?`, ok: 'Set it', cancel: 'Not now', fields: [
    { name: 'day', label: s.task ? `Last ${job(s.task)}` : 'Last done', type: 'date', value: day,
      hint: isoDay(s.lastDone) ? `The page says ${dayText(s.lastDone)} now.` : 'The page has no Last done date yet.' }] });
  if (!v || !isoDay(v.day)) return;
  if (save({ ...(sys(s.id) || s), lastDone: v.day })) { toast(`${s.name}: last done ${dayText(v.day)}.`); saidSaved(s.id); }
}

// A sticker whose page isn't in the manual (deleted, or never made): who to call, the report form and the front page
// still help a tenant. The owner can make the page.
function renderNotFound(id, badId) {
  const hs = house();
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ ' + (hs.title || 'House manual'))),
    h('p', { class: 'empty' }, badId ? `"${id}" can't be a page's id: letters, digits and dashes only.` : 'This sticker\'s page isn\'t in the manual yet.'),
    owner() && !badId && !FRONT.has(id) ? h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: fresh(() => sys(id) ? render() : editSystem({ id, name: '' })) }, 'Make this page')) : null,
    contactCard(hs.contact),
    reportButton({ id, name: '' }, 'Report a problem'),   // the report names the sticker, so the owner knows which
    h('div', { class: 'btns stack' }, h('a', { class: 'btn ghost wide', href: '#' }, 'The whole house manual')),
  ];
}

// ---------------------------------------------------------------- frame
let lastView = '';
function render() {
  const r = route();
  if (r.view === 'owner' && lastView !== 'owner' && owner()) checkTenants();
  lastView = r.view;
  document.body.classList.toggle('is-owner', owner());
  let body;
  if (!owner() && !site.length && loading) body = [h('div', { class: 'notice' }, h('p', {}, h('b', {}, 'Loading the house manual… '), 'The first time takes a few seconds.', slow ? ' Taking longer than usual.' : ''))];
  else if (!owner() && !site.length && siteError === 'unset') body = [h('div', { class: 'notice' }, h('p', {}, h('b', {}, 'Not published yet. '), 'This house manual hasn\'t been put online. If you tapped a sticker, please call the number you were given.'))];
  else if (!owner() && !site.length && siteError === 'offline') body = [h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'No connection. '), 'The house manual needs a signal the first time. Try again near a window, or call the number you were given.'), tryAgain())];
  else if (!owner() && !site.length && siteError === 'noload') body = [h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'The house manual didn\'t load. '), 'Try again in a minute, or call the number you were given.'), tryAgain())];
  else if (r.view === 'owner' && owner()) body = renderOwner();
  else if (r.view === 'print' && owner()) body = renderPrint();
  else if (r.view === 'manual' && owner()) body = renderManual();
  else if (r.view === 'reports' && owner()) body = renderReports();
  else if (r.view === 'item' && FRONT.has(r.id)) body = renderHome();
  // a deleted page's sticker sent to another page: that page, at its own address
  else if (r.view === 'item' && sentFrom(r.id) && landing(r.id) !== r.id) { history.replaceState(null, '', '#' + landing(r.id)); render(); return; }
  else if (r.view === 'item') {
    const s = sys(r.id), wait = owner() ? ledger.notReady('site') : site.length ? '' : 'Loading…', badId = owner() && refusal({ id: r.id });
    body = s ? renderSystem(s) : wait ? [h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ House manual')), h('p', { class: 'empty' }, wait)] : renderNotFound(r.id, badId); }
  else body = renderHome();
  // The owner sees the ledger's status line on every page, as in the other tag apps (tenants never do).
  mount(app, owner() ? h('p', { class: 'sync ' + ledger.state }, ledger.statusText()) : staleNotice(), body);
  $('#edit-link').hidden = !owner();
  document.title = r.view === 'item' && sys(r.id) ? `${sys(r.id).name} · Placard` : 'Placard';
  if (demo) { $('#demo-note').hidden = false; if (!$('#demo-note .sample-out')) $('#demo-note p').append(' ', sampleLink()); }
}

onRoute(render);
ledger.on(() => { const st = $('.sync'); if (st) { st.className = 'sync ' + ledger.state; st.textContent = ledger.statusText(); } });
load();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
// the tests' handle: render() redraws from the ledger's copy, as a sync does
window.__placard = { ledger, render: () => { fromLedger(); render(); }, get site() { return site; } };
