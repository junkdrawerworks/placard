// Placard: a house manual on stickers. Tenants tap a sticker and get that system's page with no app and no sign-in;
// the owner, connected to the ledger, edits the pages, writes and locks the stickers and reads the reports.
import { $, h, mount, toast, sheet, confirmSheet, route, go, dayText, stampText, qrSvg, today } from './kit/ui.js';
import { Ledger, takeConnectLink, publicRead, publicReport, refusal, importText } from './kit/ledger.js';
import { tagUrl } from './kit/tags.js';
import { nfcPanel } from './kit/panel.js';
import { LEDGER_URL } from './config.js';
import { KINDS, STARTER, SAMPLE, parseFacts, factsText, lines } from './starter.js';

const params = new URLSearchParams(location.search);
const demo = params.has('demo');
takeConnectLink('placard');
const ledger = new Ledger('placard', { demo: demo ? SAMPLE : null });
const owner = () => ledger.connected;
const app = $('#app');
let site = [];          // the docs everyone sees
let siteError = '';

const jget = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const house = () => site.find(d => d.id === 'house') || { title: 'House manual' };
const systems = () => site.filter(d => d.id !== 'house').sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
const sys = id => site.find(d => d.id === id && d.id !== 'house');

async function load() {
  if (owner()) {
    site = ledger.docs('site');
    render();
    ledger.keepUp(['site', 'reports'], () => { site = ledger.docs('site'); render(); });
    return;
  } else {
    site = jget('placard.public') || [];
    if (site.length) render();
    if (!LEDGER_URL) { siteError = 'unset'; }
    else {
      try { site = await publicRead(LEDGER_URL, 'placard', 'site'); jset('placard.public', site); siteError = ''; }
      catch (e) { siteError = site.length ? '' : 'offline'; }
    }
  }
  render();
}

// ---------------------------------------------------------------- tenant pages
function contactCard(c) {
  if (!c || !(c.phone || c.email)) return null;
  return h('section', { class: 'card contact' },
    h('h2', {}, 'Who to call'),
    h('p', { class: 'who' }, c.name || ''),
    c.note ? h('p', { class: 'muted' }, c.note) : null,
    h('div', { class: 'btns' },
      c.phone ? h('a', { class: 'btn', href: 'tel:' + c.phone.replace(/[^\d+]/g, '') }, 'Call ' + c.phone) : null,
      c.phone ? h('a', { class: 'btn ghost', href: 'sms:' + c.phone.replace(/[^\d+]/g, '') }, 'Text') : null,
      c.email ? h('a', { class: 'btn ghost', href: 'mailto:' + c.email }, 'Email') : null));
}

function renderHome() {
  const hs = house();
  const list = systems();
  const urgent = list.filter(s => s.emergency);
  return [
    h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, 'Welcome'), h('div', { class: 'tape' }, hs.title || 'House manual')),
    hs.intro ? h('p', { class: 'lead' }, hs.intro) : null,
    urgent.length ? h('section', {}, h('h2', {}, 'In an emergency'),
      h('div', { class: 'urgent' }, urgent.map(s => h('a', { class: 'urgent-tile', href: '#' + s.id }, h('b', {}, s.name), h('span', {}, s.where || ''))))) : null,
    contactCard(hs.contact),
    KINDS.map(([k, label]) => {
      const in_ = list.filter(s => (s.kind || 'other') === k);
      return in_.length ? h('section', {}, h('h2', {}, label), h('ul', { class: 'list' }, in_.map(s =>
        h('li', {}, h('a', { class: 'row', href: '#' + s.id }, h('span', { class: 'main' }, h('span', { class: 't' }, s.name), s.where ? h('span', { class: 's' }, s.where) : null), h('span', { class: 'meta' }, '›')))))) : null;
    }),
    hs.notes ? h('section', { class: 'card' }, h('h2', {}, 'Good to know'), lines(hs.notes).map(l => h('p', {}, l))) : null,
    !list.length ? h('p', { class: 'empty' }, owner() ? ledger.notReady('site') || 'No systems yet. Add them under Edit.' : 'This house manual is empty for now.') : null,
  ];
}

function renderSystem(s) {
  const hs = house();
  const steps = lines(s.steps);
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ ' + (hs.title || 'House manual'))),
    h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, (KINDS.find(k => k[0] === s.kind) || KINDS[5])[1]), h('div', { class: 'tape' }, s.name)),
    s.where ? h('p', { class: 'where' }, h('b', {}, 'Where: '), s.where) : null,
    s.summary ? h('p', { class: 'lead' }, s.summary) : null,
    s.warn ? h('div', { class: 'notice warn' }, h('p', {}, s.warn)) : null,
    steps.length ? h('section', {}, h('h2', {}, 'What to do'), h('ol', { class: 'steps' }, steps.map(l => h('li', {}, l)))) : null,
    s.facts?.length ? h('section', { class: 'card' }, h('h2', {}, 'Details'), h('dl', { class: 'facts' }, s.facts.map(([k, v]) => [h('dt', {}, k || '·'), h('dd', {}, v)]))) : null,
    s.care ? h('section', {}, h('h2', {}, 'Looking after it'), lines(s.care).map(l => h('p', {}, l))) : null,
    s.manual ? h('p', {}, h('a', { class: 'btn ghost', href: s.manual, target: '_blank', rel: 'noopener' }, 'The manual')) : null,
    contactCard(hs.contact),
    h('div', { class: 'btns stack' }, h('button', { type: 'button', class: 'btn ghost wide', onclick: () => report(s) }, 'Report a problem or log a visit')),
    owner() ? ownerTools(s) : null,
  ];
}

async function report(s) {
  const v = await sheet({ title: 'Tell the owner', ok: 'Send', fields: [
    { name: 'kind', label: 'This is', type: 'select', options: ['Problem', 'Service visit', 'Question'] },
    { name: 'text', label: 'What happened', type: 'textarea', rows: 4, required: true, placeholder: s ? `About the ${s.name.toLowerCase()}…` : '' },
    { name: 'name', label: 'Your name' },
    { name: 'contact', label: 'Phone or email', hint: 'So we can get back to you.' },
  ] });
  if (!v || v.__danger) return;
  if (!v.text) { toast('Write what happened first.', 'bad'); return; }
  const doc = { ...v, system: s?.id || '', systemName: s?.name || '' };
  try {
    if (demo) ledger.demo.handle({ op: 'report', app: 'placard', coll: 'reports', doc });
    else await publicReport(owner() ? ledger.cfg.url : LEDGER_URL, 'placard', 'reports', doc);
    toast('Sent. The owner gets it by email.');
  } catch (e) { toast(/too many/.test(e.message) ? 'Too many reports this hour. Please call instead.' : 'Couldn\'t send it. Check the signal, or call.', 'bad'); }
}

// ---------------------------------------------------------------- owner
function ownerTools(s) {
  return h('section', { class: 'owner card' },
    h('h2', {}, 'Owner'),
    h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => editSystem(s) }, 'Edit this page')),
    nfcPanel(tagUrl('h', s.id), { lock: true, label: 'Write sticker',
      note: s.locked ? `Locked ${dayText(s.locked)}.` : s.tagged ? `Written ${dayText(s.tagged)}, not locked yet.` : 'Not written yet.',
      onWritten: () => save({ ...s, tagged: today() }), onLocked: () => save({ ...s, locked: today() }) }));
}

// Saves a page; says so and returns false if the ledger couldn't take it (a page over 45,000 characters).
function save(doc) {
  try { ledger.put('site', doc); }
  catch (e) {
    if (!e.refused) throw e;
    toast(e.refused === 'too big' ? 'Too long to save: over 45,000 characters. Shorten it, or link the manual instead.' : `"${doc.id}" can't be a page's id: letters, digits and dashes only.`, 'bad');
    return false;
  }
  site = ledger.docs('site'); render(); return true;
}

async function editSystem(s) {
  const exists = !!(s && sys(s.id));
  const v = await sheet({ title: exists ? 'Edit ' + s.name : 'New system', danger: exists ? 'Delete' : null, fields: [
    { name: 'name', label: 'Name', value: s?.name, required: true },
    { name: 'where', label: 'Where it is', value: s?.where, placeholder: 'Basement, left of the stairs' },
    { name: 'kind', label: 'Group', type: 'select', value: s?.kind || 'other', options: KINDS },
    { name: 'emergency', label: 'Show under "In an emergency"', type: 'select', value: s?.emergency ? 'yes' : 'no', options: [['no', 'No'], ['yes', 'Yes']] },
    { name: 'summary', label: 'What it is', type: 'textarea', value: s?.summary },
    { name: 'steps', label: 'What to do (one step per line)', type: 'textarea', rows: 4, value: s?.steps },
    { name: 'facts', label: 'Details (one "Label: value" per line)', type: 'textarea', rows: 4, value: factsText(s?.facts), placeholder: 'Model: XE50T10\nFilter: 16 × 25 × 1' },
    { name: 'care', label: 'Looking after it', type: 'textarea', value: s?.care },
    { name: 'warn', label: 'Warning (shown in amber)', type: 'textarea', rows: 2, value: s?.warn },
    { name: 'manual', label: 'Link to the manual', type: 'url', value: s?.manual },
    { name: 'order', label: 'Order on the page', type: 'number', value: s?.order ?? systems().length + 1, inputmode: 'numeric' },
  ] });
  if (!v) return;
  if (v.__danger) {
    if (await confirmSheet('Delete ' + s.name + '?', 'Its page goes. A sticker already written for it will open "not found" until you add a system with the same id.', 'Delete')) {
      ledger.del('site', s.id); site = ledger.docs('site'); go('#/owner');
    }
    return;
  }
  const id = s?.id || uniqueId(v.name);
  if (!save({ ...(s || {}), id, name: v.name, where: v.where, kind: v.kind, emergency: v.emergency === 'yes', summary: v.summary, steps: v.steps,
    facts: parseFacts(v.facts), care: v.care, warn: v.warn, manual: v.manual, order: Number(v.order) || 99 })) return;
  toast('Saved. Tenants see it now.');
  if (!exists) go('#' + id);
}
function uniqueId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'system';
  let id = base, n = 2;
  while (site.some(d => d.id === id)) id = `${base}-${n++}`;
  return id;
}

async function editHouse() {
  const hs = house(), c = hs.contact || {};
  const v = await sheet({ title: 'The house', fields: [
    { name: 'title', label: 'Title', value: hs.title || 'House manual' },
    { name: 'intro', label: 'Welcome line', type: 'textarea', value: hs.intro },
    { name: 'cname', label: 'Who to call', value: c.name, placeholder: 'The property manager' },
    { name: 'phone', label: 'Phone', type: 'tel', value: c.phone },
    { name: 'email', label: 'Email', type: 'email', value: c.email },
    { name: 'cnote', label: 'When to call', type: 'textarea', rows: 2, value: c.note },
    { name: 'notes', label: 'Good to know (one per line)', type: 'textarea', value: hs.notes },
  ] });
  if (!v || v.__danger) return;
  save({ ...hs, id: 'house', title: v.title, intro: v.intro, notes: v.notes, contact: { name: v.cname, phone: v.phone, email: v.email, note: v.cnote } });
}

async function addFromStarter() {
  const have = new Set(site.map(d => d.id));
  const left = STARTER.filter(s => !have.has(s.id));
  const v = await sheet({ title: 'Add a system', ok: 'Add', fields: [
    { name: 'pick', label: 'From the usual list', type: 'select', options: [['', 'Pick one…'], ...left.map(s => [s.id, s.name]), ['__new', 'Something else…']] },
  ] });
  if (!v || !v.pick) return;
  if (v.pick === '__new') return editSystem(null);
  save({ ...STARTER.find(s => s.id === v.pick) });
  go('#' + v.pick);
}

function importFacts() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    try {
      const data = JSON.parse(await input.files[0].text());
      const docs = Array.isArray(data) ? data : data.docs || [];
      let n = 0;
      const skipped = {};
      for (const d of docs) {
        if (!d) continue;
        const rec = { ...(site.find(x => x.id === d.id) || {}), ...d }, why = refusal(rec);
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        ledger.put('site', rec); n++;
      }
      site = ledger.docs('site'); render(); toast(importText(n, skipped, 'pages'), Object.keys(skipped).length ? 'bad' : '');
    } catch (e) { toast('That file isn\'t a Placard import.', 'bad'); }
  });
  input.click();
}

function renderOwner() {
  const list = systems();
  const reports = ledger.docs('reports').filter(r => r.status !== 'handled');
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ Tenant view')),
    h('h2', {}, 'Edit the manual'),
    h('p', { class: 'sync ' + ledger.state }, ledger.statusText()),
    !LEDGER_URL && !demo ? h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'Tenants can\'t see this yet. '), 'Put the ledger address in js/config.js in the repo (Part 4 of the guide).')) : null,
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'btn', onclick: editHouse }, 'House and contact'),
      h('button', { type: 'button', class: 'btn ghost', onclick: addFromStarter }, 'Add a system'),
      h('a', { class: 'btn ghost', href: '#/print' }, 'QR stickers'),
      h('a', { class: 'btn ghost', href: '#/reports' }, `Reports${reports.length ? ' (' + reports.length + ')' : ''}`),
      h('button', { type: 'button', class: 'btn ghost', onclick: importFacts }, 'Import')),
    h('ul', { class: 'list' }, list.map(s => h('li', {}, h('a', { class: 'row', href: '#' + s.id },
      h('span', { class: 'main' }, h('span', { class: 't' }, s.name), h('span', { class: 's' }, s.where || 'No location yet')),
      h('span', { class: 'chip ' + (s.locked ? 'ok' : s.tagged ? 'warn' : '') }, s.locked ? 'locked' : s.tagged ? 'written' : 'no tag'))))),
  ];
}

function renderPrint() {
  return [
    h('div', { class: 'no-print' }, h('p', { class: 'crumb' }, h('a', { href: '#/owner' }, '‹ Edit')), h('h2', {}, 'QR stickers'),
      h('p', { class: 'muted' }, 'A backup beside each NFC sticker, for phones with NFC off. Print on label paper or plain paper, cut, and tape over with clear packing tape.'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => print() }, 'Print'))),
    h('div', { class: 'qr-sheet' }, systems().map(s => h('div', { class: 'qr-card' },
      h('div', { class: 'qr', html: qrSvg(tagUrl('h', s.id), { size: 110 }) }),
      h('div', {}, h('b', {}, s.name), h('span', {}, 'Tap a phone on the sticker, or scan, for what to do.'), h('small', {}, (house().title || 'House manual')))))),
  ];
}

function renderReports() {
  const reps = ledger.docs('reports').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return [
    h('p', { class: 'crumb' }, h('a', { href: '#/owner' }, '‹ Edit')), h('h2', {}, 'Reports'),
    reps.length ? h('ul', { class: 'list' }, reps.map(r => h('li', { class: 'card report' + (r.status === 'handled' ? ' dim' : '') },
      h('p', {}, h('span', { class: 'chip ' + (r.status === 'handled' ? '' : 'warn') }, r.kind || 'Note'), ' ', h('b', {}, r.systemName || 'General'), ' ', h('small', {}, r.at ? stampText(Date.parse(r.at)) : '')),
      h('p', {}, r.text),
      h('p', { class: 'muted' }, [r.name, r.contact].filter(Boolean).join(' · ') || 'No name left'),
      r.status !== 'handled' ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { ledger.put('reports', { ...r, status: 'handled', handled: today() }); render(); } }, 'Mark handled') : null)))
      : h('p', { class: 'empty' }, 'No reports yet.'),
  ];
}

// ---------------------------------------------------------------- frame
function render() {
  const r = route();
  document.body.classList.toggle('is-owner', owner());
  let body;
  if (!owner() && !site.length && siteError === 'unset') body = [h('div', { class: 'notice' }, h('p', {}, h('b', {}, 'Not published yet. '), 'This house manual hasn\'t been put online. If you tapped a sticker, please call the number you were given.'))];
  else if (!owner() && !site.length && siteError === 'offline') body = [h('div', { class: 'notice warn' }, h('p', {}, h('b', {}, 'No connection. '), 'The house manual needs a signal the first time. Try again near a window, or call the number you were given.'))];
  else if (r.view === 'owner' && owner()) body = renderOwner();
  else if (r.view === 'print' && owner()) body = renderPrint();
  else if (r.view === 'reports' && owner()) body = renderReports();
  else if (r.view === 'item') {
    const s = sys(r.id), wait = owner() ? ledger.notReady('site') : site.length ? '' : 'Loading…', badId = owner() && refusal({ id: r.id });
    body = s ? renderSystem(s) : [h('p', { class: 'crumb' }, h('a', { href: '#' }, '‹ House manual')), h('p', { class: 'empty' }, wait || (badId ? `"${r.id}" can't be a page's id: letters, digits and dashes only.` : 'This sticker\'s page isn\'t in the manual yet.')), owner() && !wait && !badId ? h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: () => editSystem({ id: r.id, name: '' }) }, 'Make this page')) : null]; }
  else body = renderHome();
  mount(app, body);
  $('#edit-link').hidden = !owner();
  document.title = r.view === 'item' && sys(r.id) ? `${sys(r.id).name} · Placard` : 'Placard';
  if (demo) $('#demo-note').hidden = false;
}

window.addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
ledger.on(() => { const st = $('.sync'); if (st) { st.className = 'sync ' + ledger.state; st.textContent = ledger.statusText(); } });
load();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__placard = { ledger, render, get site() { return site; } };
