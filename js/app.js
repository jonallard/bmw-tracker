import { ITEMS, ORDER, CAR, START_MILES, FACTORY, DIY, WATCH } from './items.js';
import * as R from './recalls.js';
import * as DB from './db.js';
import * as C from './calc.js';

const APP_ID = 'bmw-care';
const APP_VERSION = '1.0';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const money = (n) =>
  n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const fmtDate = (s) =>
  s ? C.parse(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[, $]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const browserOk = () => { try { return sessionStorage.getItem('browserOk') === '1'; } catch { return false; } };
const needsInstall = () => isIOS() && !isStandalone() && !S.settings.setupDone && !browserOk();
const isStandalone = () =>
  (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

// ---------------------------------------------------------------- state
const S = { settings: {}, bmw: {}, recalls: {}, over: {}, history: [], mileage: [], persisted: null, ready: false };
let draft = null; // setup wizard answers
let installDismissed = false;

async function load() {
  const [meta, items, history, mileage] = await Promise.all(DB.STORES.map(DB.getAll));
  const m = (k) => (meta.find((r) => r.key === k) || {}).value || {};
  S.settings = m('settings');
  S.bmw = m('bmw');
  S.recalls = m('recalls');
  S.over = Object.fromEntries(items.map((i) => [i.id, i]));
  S.history = history;
  S.mileage = mileage;
}
const saveSettings = () => DB.put('meta', { key: 'settings', value: S.settings });
const saveBmw = () => DB.put('meta', { key: 'bmw', value: S.bmw });
const saveRecalls = () => DB.put('meta', { key: 'recalls', value: S.recalls });
const openRecalls = () => (S.recalls.items || []).filter((r) => !(S.recalls.handled || []).includes(r.id));
async function saveOver(id, patch) {
  const rec = { ...(S.over[id] || { id }), ...patch, id };
  S.over[id] = rec;
  await DB.put('items', rec);
}

async function addHistory(rec) {
  rec.id = await DB.put('history', rec);
  S.history.push(rec);
}

const ctx = () => {
  const m = C.mileageModel(S.mileage);
  return { cur: m.cur, rate: m.rate, now: C.today(), m };
};
function evalItem(id, cx) {
  const it = C.effectiveItem(ITEMS[id], S.over[id], S.settings);
  const entries = S.history.filter((h) => h.itemId === id);
  return { ...C.evaluate(it, entries, cx, S.settings, S.bmw), entries };
}
const allEvals = (cx) => ORDER.map((id) => evalItem(id, cx));

// ---------------------------------------------------------------- text helpers
function whenText(ev, m) {
  const it = ev.item;
  const est = m.isEst ? ' <span class="est">est.</span>' : '';
  if (ev.status === 'check') return 'Check it';
  if (ev.quietNone) return 'Not started';
  if (it.kind === 'record') return ev.last ? `Replaced ${fmtDate(ev.last.date) || 'earlier'}` : 'Dash warns you';
  if (it.kind === 'tires') {
    const bits = [];
    if (ev.tread != null) bits.push(`${ev.tread}/32 in`);
    if (ev.age != null) bits.push(`${ev.age.toFixed(1)} yrs old`);
    return bits.join(', ');
  }
  if (ev.noSchedule) return 'Copy from My BMW';
  if (ev.primary === 'miles') {
    const l = ev.milesLeft;
    return l < 0 ? `Overdue by ${fmtN(-l)} mi${est}` : `${fmtN(l)} mi left${est}`;
  }
  const d = ev.daysLeft;
  if (d < 0) return `Overdue by ${plural(-d, 'day')}`;
  if (d === 0) return 'Due today';
  return `${plural(d, 'day')} left`;
}
const intervalText = (it) => {
  const bits = [];
  if (it.miles) bits.push(`${fmtN(it.miles)} miles`);
  if (it.months) bits.push(it.months % 12 === 0 ? plural(it.months / 12, 'year') : plural(it.months, 'month'));
  if (!bits.length) return it.kind === 'tires' ? 'By condition' : it.kind === 'record' ? 'No fixed interval' : 'Set by the car';
  return bits.length === 2 ? `Every ${bits[0]} or ${bits[1]}, whichever comes first` : `Every ${bits[0]}`;
};
const STATUS_LABEL = { overdue: 'Overdue', soon: 'Due soon', ok: 'OK', check: 'Check it' };

function costLine(ev) {
  const c = ev.costDollars;
  return c ? money(c.amount) : '';
}
function ago(dateStr) {
  const n = C.diffDays(dateStr, C.today());
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

// ---------------------------------------------------------------- shell
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function openSheet(html) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  root.classList.add('open');
  document.body.classList.add('noscroll');
  const f = root.querySelector('[data-focus]');
  if (f) f.focus();
}
function closeSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('noscroll');
}
function confirmSheet({ title, body, yes, danger, act, data = '' }) {
  openSheet(`<h2>${esc(title)}</h2><p class="muted">${body}</p>
    <div class="btns"><button class="btn ${danger ? 'danger' : 'primary'}" data-act="${act}" ${data}>${esc(yes)}</button>
    <button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
}

if (window.visualViewport) {
  const upd = () => {
    const vv = window.visualViewport;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
  };
  visualViewport.addEventListener('resize', upd);
  visualViewport.addEventListener('scroll', upd);
}

// ---------------------------------------------------------------- HOME
function homeView() {
  const cx = ctx();
  const m = cx.m;
  const evals = allEvals(cx);
  const by = { overdue: [], soon: [], ok: [], check: [] };
  evals.forEach((e) => by[e.status].push(e));
  Object.keys(by).forEach((k) => (by[k] = C.sortEvals(by[k])));

  const dueNow = [...by.overdue, ...by.soon];
  const known = dueNow.filter((e) => e.costDollars).reduce((a, e) => a + e.costDollars.amount, 0);
  const summary = dueNow.length
    ? `${by.overdue.length ? plural(by.overdue.length, 'item') + ' overdue' : ''}${by.overdue.length && by.soon.length ? ', ' : ''}${by.soon.length ? plural(by.soon.length, 'item') + ' due soon' : ''}${known ? `. About ${money(known)} in known prices.` : '.'}`
    : by.check.length
      ? `Nothing due. ${plural(by.check.length, 'item')} to check.`
      : 'Nothing due. You are caught up.';

  const updated = m.latest
    ? `Last entered ${ago(m.latest.date)}${m.rate ? `, about ${fmtN(m.rate)} mi/day <span class="est">est.</span>` : '. Update again in a week or more and I will start estimating.'}`
    : '';

  let banners = '';
  if (isIOS() && !isStandalone() && !installDismissed)
    banners += `<div class="banner warn"><b>Open this from your Home Screen icon.</b> Safari and the Home Screen app keep separate data. Steps are under More.
      <button class="link" data-act="dismiss-install">Dismiss</button></div>`;
  const nRec = openRecalls().length;
  if (nRec)
    banners += `<div class="banner warn"><b>${plural(nRec, 'open recall')} for your model year.</b> <a href="#/recalls">See details</a></div>`;
  const base = S.settings.lastBackup || S.settings.setupAt;
  if (base && C.diffDays(base.slice(0, 10), C.today()) >= 30)
    banners += `<div class="banner"><b>${S.settings.lastBackup ? 'Last backup was ' + C.diffDays(S.settings.lastBackup.slice(0, 10), C.today()) + ' days ago.' : 'No backup yet.'}</b>
      Your data lives only on this phone. <a href="#/more">Back up now</a></div>`;

  const row = (e) => {
    const it = e.item;
    const sub = e.status === 'check' ? (it.kind === 'tires' ? 'Add tread and DOT code, 30 seconds' : 'Tap to say when it was last done') : e.quietNone ? it.tag || '' : it.tag || '';
    const inner = `<span class="bar"></span>
      <span class="main"><span class="name">${esc(it.name)}</span><span class="sub">${esc(sub)}</span></span>
      <span class="side"><span class="when">${whenText(e, m)}</span><span class="cost">${costLine(e) || '<i>No price yet</i>'}</span></span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
    return e.status === 'check'
      ? `<button class="row s-check" data-act="resolve" data-id="${it.id}">${inner}</button>`
      : `<a class="row s-${e.status}" href="#/item/${it.id}">${inner}</a>`;
  };
  const groups = C.GROUPS.map(([k, label]) =>
    by[k].length
      ? `<section><h2 class="grp g-${k}">${label} <span class="count">${by[k].length}</span></h2><div class="list">${by[k].map(row).join('')}</div></section>`
      : ''
  ).join('');

  return `<header class="hero">
      <div class="lbl">Mileage</div>
      <div class="odo">${fmtN(m.cur)} <small>mi</small>${m.isEst ? ' <span class="est big">est.</span>' : ''}</div>
      <div class="muted small">${updated}</div>
      <button class="btn primary block" data-act="update-miles">Update mileage</button>
    </header>
    ${banners}
    <p class="summary">${summary}</p>
    ${groups}`;
}

// ---------------------------------------------------------------- ITEM
function itemView(id) {
  if (!ITEMS[id]) return `<p>Not found.</p>`;
  const cx = ctx();
  const m = cx.m;
  const ev = evalItem(id, cx);
  const it = ev.item;
  const hist = ev.entries.slice().sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1 : b.id - a.id));
  const last = ev.last;

  const dueLine =
    ev.estDue && ev.status !== 'check'
      ? `<div class="muted">${ev.status === 'overdue' ? 'Was due about' : 'Due around'} ${fmtDate(ev.estDue)}${ev.dueDate ? '' : ' <span class="est">est.</span>'}</div>`
      : '';

  const lastDone = last
    ? `<dl class="kv">
        <dt>Date</dt><dd>${fmtDate(last.date) || 'Not known'}</dd>
        <dt>Mileage</dt><dd>${last.miles != null ? fmtN(last.miles) + ' mi' : 'Not known'}</dd>
        <dt>Cost</dt><dd>${last.cost != null ? money(last.cost) : 'Not entered'}</dd>
        <dt>Where</dt><dd>${esc(last.shop) || 'Not entered'}</dd></dl>`
    : `<p class="muted">${it.optional ? 'Never recorded. That is fine for an optional item.' : 'Not known yet. Tap Mark done if you just did it, or set the date it was last done.'}</p>`;

  const cost = ev.costDollars;
  const paid = ev.entries.filter((e) => e.cost != null).sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
  const costCard = `
    ${paid.length ? `<div class="line"><span>You paid</span><b>${paid.map((p) => money(p.cost)).slice(0, 3).join(', ')}</b></div>` : ''}
    ${it.quote ? `<div class="line"><span>${esc(it.quote.label || 'My quote')}</span><b>${money(it.quote.amount)}</b></div>` : ''}
    ${!paid.length && !it.quote ? `<p class="muted">No price yet. Add a quote when you get one.</p>` : ''}
    <button class="btn ghost" data-act="quote" data-id="${id}">${it.quote ? 'Change quote' : 'Add a quote'}</button>`;

  let special = '';
  if (id === 'airfilter') {
    const t = S.settings.airFilterType || 'unknown';
    special = `<section class="card"><h2>Which Dinan filter do you have?</h2>
      <p class="muted small">A washable (reusable) filter gets cleaned. A paper type gets replaced.</p>
      <div class="seg">${airSeg(t)}</div></section>`;
  }
  if (id === 'coils') {
    const pl = S.history.filter((h) => h.itemId === 'plugs');
    const lp = C.latestEntry(pl);
    special = `<section class="card"><h2>Tied to spark plugs</h2>
      <p>Replace the coils with every second plug change. ${lp && lp.miles != null ? `Plugs were last changed at ${fmtN(lp.miles)} mi.` : 'No plug change recorded yet.'}</p>
      <a class="btn ghost" href="#/item/plugs">Open spark plugs</a></section>`;
  }
  if (it.kind === 'tires') {
    special = `<section class="card"><h2>Condition</h2>
      <dl class="kv"><dt>Tread</dt><dd>${ev.tread != null ? ev.tread + '/32 inch' : 'Not entered'}</dd>
      <dt>Age</dt><dd>${ev.age != null ? ev.age.toFixed(1) + ' years (DOT ' + esc(it.extra.dot.code) + ')' : 'Not entered'}</dd></dl>
      <button class="btn ghost" data-act="tires">Update tread + DOT code</button></section>`;
  }
  if (id === 'brakes') {
    const b = S.bmw.brakePads;
    special = `<section class="card"><h2>What the car says</h2>
      <p>${b ? `My BMW app showed about ${fmtN(b.milesLeft)} miles of pad life left on ${fmtDate(b.enteredOn)}.` : 'Copy the brake pad miles from the My BMW app if you like. Optional.'}</p>
      <button class="btn ghost" data-act="bmwdue" data-id="brakes">${b ? 'Update' : 'Add'} from My BMW app</button></section>`;
  }
  if (it.kind === 'cardue') {
    const b = S.bmw.vehicleCheck;
    special = `<section class="card"><h2>What the car says</h2>
      <p>${b ? `Entered ${fmtDate(b.enteredOn)}: ${b.milesLeft != null ? 'due in ' + fmtN(b.milesLeft) + ' miles' : ''}${b.milesLeft != null && b.dueDate ? ', ' : ''}${b.dueDate ? 'by ' + fmtDate(b.dueDate) : ''}.` : 'Nothing entered yet.'}</p>
      <button class="btn ghost" data-act="bmwdue" data-id="vehiclecheck">${b ? 'Update' : 'Add'} from My BMW app</button></section>`;
  }
  if (it.extraNote) special += `<section class="card note"><h2>Good to know</h2><p>${esc(it.extraNote)}</p></section>`;

  const calOk = !!ev.estDue && ev.status !== 'check';
  const calBlock = `<section class="card"><h2>Reminder</h2>
    ${calOk ? `<p class="muted small">Adds an all-day event on ${fmtDate(ev.estDue)}, with alerts a week before and that morning.</p>` : `<p class="muted small">${ev.status === 'check' ? 'Set when this was last done first.' : 'I need two mileage updates a week or more apart to estimate a date.'}</p>`}
    <button class="btn ghost" data-act="cal" data-id="${id}" ${calOk ? '' : 'disabled'}>Add to Calendar</button></section>`;

  const histHtml = hist.length
    ? `<div class="list">${hist.map((h) => entryRow(h, false)).join('')}</div>`
    : `<p class="muted">No history yet.</p>`;

  return `<div class="topbar"><a class="back" href="#/">‹ What's due</a></div>
    <header class="ihead s-${ev.status}">
      <span class="chip s-${ev.status}">${STATUS_LABEL[ev.status]}</span>
      <h1>${esc(it.name)}</h1>
      <div class="when big">${whenText(ev, m)}</div>${dueLine}
    </header>
    <section class="card"><h2>What it is</h2><p>${esc(it.short)}</p></section>
    <section class="card"><h2>How often</h2>
      <p class="strong">${intervalText(it)}</p>
      ${it.customInterval ? `<p class="muted small">You changed this. Starting value was ${esc(intervalText({ ...it, miles: it.defaultMiles, months: it.defaultMonths }))}.</p>` : ''}
      <p><span class="tag">${esc(it.tag || '')}</span></p>
      <p>${esc(it.why)}</p>
      ${it.disagreement ? `<p class="callout">${esc(it.disagreement)}</p>` : ''}
      <p class="muted small">Source: ${esc(it.source)}</p>
      ${it.kind === 'tires' || it.kind === 'record' || it.kind === 'cardue' ? '' : `<button class="btn ghost" data-act="interval" data-id="${id}">Edit interval</button>`}
    </section>
    <section class="card"><h2>Last done</h2>${lastDone}</section>
    <section class="card"><h2>Cost guide</h2>${costCard}</section>
    <section class="card"><h2>Can you do it yourself?</h2>
      <p><span class="diy d-${it.diy}">${DIY[it.diy]}</span></p><p>${esc(it.diyNote)}</p></section>
    ${special}
    ${calBlock}
    <section><h2 class="grp">History</h2>${histHtml}</section>
    <div class="actionbar"><button class="btn primary block" data-act="done" data-id="${id}">Mark done</button></div>`;
}

function airSeg(t) {
  const o = [['washable', 'Washable'], ['replace', 'Paper (replace)'], ['unknown', 'Not sure']];
  return o.map(([v, l]) => `<button class="${t === v ? 'on' : ''}" data-act="air" data-v="${v}">${l}</button>`).join('');
}

function entryRow(h, showItem) {
  const name = showItem ? esc((ITEMS[h.itemId] || {}).name || h.itemId) : '';
  const tagText = h.source === 'bmw' ? 'From My BMW app (estimated)' : h.source === 'original' ? 'Original, never replaced' : h.source === 'setup' ? 'From setup' : '';
  return `<button class="row plain" data-act="entry" data-id="${h.id}">
    <span class="main"><span class="name">${showItem ? name : fmtDate(h.date) || 'Date not known'}</span>
    <span class="sub">${showItem ? (fmtDate(h.date) || 'Date not known') : ''}${h.miles != null ? (showItem ? ' · ' : '') + fmtN(h.miles) + ' mi' : ''}${h.shop ? ' · ' + esc(h.shop) : ''}${tagText ? '<br>' + tagText : ''}</span></span>
    <span class="side"><span class="cost">${h.cost != null ? money(h.cost) : ''}</span>${h.photo ? '<span class="sub">Receipt</span>' : ''}</span></button>`;
}

// ---------------------------------------------------------------- HISTORY
function historyView() {
  const hist = S.history.slice().sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1 : b.id - a.id));
  const yr = String(new Date().getFullYear());
  const total = hist.reduce((a, h) => a + (h.cost || 0), 0);
  const thisYear = hist.filter((h) => h.date && h.date.startsWith(yr)).reduce((a, h) => a + (h.cost || 0), 0);
  return `<h1 class="title">History</h1>
    <div class="totals"><div><div class="lbl">Spent in ${yr}</div><div class="big">${money(thisYear)}</div></div>
    <div><div class="lbl">All time</div><div class="big">${money(total)}</div></div></div>
    ${hist.length ? `<div class="list">${hist.map((h) => entryRow(h, true)).join('')}</div>` : '<p class="muted">Nothing here yet. Mark an item done and it shows up here.</p>'}`;
}

// ---------------------------------------------------------------- MORE
function moreView() {
  const lb = S.settings.lastBackup;
  const days = lb ? C.diffDays(lb.slice(0, 10), C.today()) : null;
  const stale = lb ? days >= 30 : true;
  const counts = `${plural(S.history.length, 'service entry').replace('entrys', 'entries')}, ${plural(S.mileage.length, 'mileage entry').replace('entrys', 'entries')}`;
  const persist =
    S.persisted === true ? 'On. iPhone is less likely to clear your data.' : S.persisted === false ? 'Not granted. Back up regularly.' : 'Not supported here. Back up regularly.';
  return `<h1 class="title">More</h1>
    <section class="card"><h2>Backup</h2>
      <p class="${stale ? 'warnt' : ''}"><b>Last backup: ${lb ? (days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago') : 'never'}</b></p>
      <p class="muted small">All data lives only on this phone. Save a backup file to iCloud Drive or Files now and then. ${counts}.</p>
      <div class="btns"><button class="btn primary" data-act="export">Back up now</button>
      <button class="btn ghost" data-act="restore">Restore from file</button></div>
    </section>
    <section class="card"><h2>Recalls</h2>
      <p>${S.recalls.checkedAt ? (openRecalls().length ? `<b>${plural(openRecalls().length, 'open recall')}</b> for your model year.` : 'No open recalls found for your model year.') : 'Not checked yet.'}</p>
      <a class="btn ghost" href="#/recalls">Open recalls</a></section>
    <section class="card"><h2>B48 watch list</h2>
      <p class="muted small">Problem areas owners report for your engine, with how much to trust each one.</p>
      <a class="btn ghost" href="#/watch">Open watch list</a></section>
    <section class="card"><h2>Reminders</h2>
      <p class="muted small">Real push alerts need a server, so this app does not send them. Your iPhone Calendar does the alerting instead:</p>
      <ol class="steps"><li>Tap <b>Add all due dates to Calendar</b>. One file adds every due date, each with an alert a week before and that morning, plus a monthly "update mileage" event on the 1st.</li><li>Run it again after you update mileage or mark things done. It updates the same events instead of adding copies.</li></ol>
      <button class="btn primary" data-act="cal-all">Add all due dates to Calendar</button>
      <details><summary>Monthly "update mileage" with Shortcuts</summary>
        <ol class="steps">
          <li>Open the <b>Shortcuts</b> app. Tap <b>Automation</b> at the bottom, then <b>+</b>.</li>
          <li>Choose <b>Time of Day</b>. Set <b>9:00 AM</b>, repeat <b>Monthly</b>, on day <b>1</b>. Tap <b>Next</b>.</li>
          <li>Tap <b>Add Action</b>, search <b>Open App</b>, tap it, then tap <b>App</b> and pick <b>330i Care</b>. Tap <b>Next</b>.</li>
          <li>Select <b>Run Immediately</b> and turn off Notify When Run if you like. Tap <b>Done</b>.</li>
        </ol>
        <p class="muted small">If 330i Care is not in the app list, swap step 3 for a <b>Show Notification</b> action that says "Update BMW miles", then tap the Home Screen icon when it appears.</p>
      </details>
    </section>
    <section class="card"><h2>Air filter type</h2>
      <p class="muted small">Is your Dinan filter washable (reusable) or paper?</p>
      <div class="seg">${airSeg(S.settings.airFilterType || 'unknown')}</div></section>
    ${isStandalone() || !isIOS() ? '' : `<section class="card warn"><h2>Add to Home Screen</h2>
      <ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li><li>Scroll down, tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. Open the new icon from now on.</li></ol>
      <p class="muted small">Safari and the Home Screen app keep separate data, so do setup from the icon.</p></section>`}
    <section class="card"><h2>Your car</h2><dl class="kv">${CAR.details.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>
    <section class="card"><h2>About</h2>
      <p class="muted small">Storage protection: ${persist}</p>
      <p class="muted small">No account, no server. Everything stays on this phone. Version ${APP_VERSION}.</p></section>
    <section class="card"><h2>Danger zone</h2>
      <button class="btn danger-ghost" data-act="wipe">Delete all data</button></section>`;
}

// ---------------------------------------------------------------- RECALLS + WATCH
function recallsView() {
  const rc = S.recalls;
  const handled = rc.handled || [];
  const open = (rc.items || []).filter((r) => !handled.includes(r.id));
  const done = (rc.items || []).filter((r) => handled.includes(r.id));
  const veh = rc.vehicle ? `${rc.vehicle.year} ${rc.vehicle.make} ${rc.vehicle.model}` : '2022 BMW 330i';
  const card = (r, isOpen) => `<section class="card"><h2>${esc(r.id)}${r.component ? ' · ' + esc(r.component) : ''}</h2>
    <p>${esc(r.summary)}</p>
    ${r.consequence ? `<p><b>Risk:</b> ${esc(r.consequence)}</p>` : ''}
    ${r.remedy ? `<p><b>Fix:</b> ${esc(r.remedy)}</p>` : ''}
    <button class="btn ghost" data-act="recall-handled" data-n="${esc(r.id)}">${isOpen ? 'Mark handled' : 'Move back to open'}</button></section>`;
  return `<div class="topbar"><a class="back" href="#/more">‹ More</a></div>
    <h1 class="title">Recalls</h1>
    <section class="card"><h2>Your VIN (optional)</h2>
      <p class="muted small">With a VIN I look up your exact model year. Without one I use ${esc(veh)}. The VIN stays on this phone, and is sent to the US government's NHTSA lookup only when you check.</p>
      <label class="field">VIN, 17 characters<input id="vin" type="text" maxlength="17" autocapitalize="characters" autocomplete="off" value="${esc(S.settings.vin || '')}"></label>
      <p class="err" id="f-err"></p>
      <button class="btn primary" data-act="recalls-check">Check for recalls</button></section>
    <p class="summary">${rc.checkedAt ? `Checked ${ago(rc.checkedAt.slice(0, 10))} for a ${esc(veh)}${rc.decoded ? ' (from your VIN)' : ''}.` : 'Not checked yet.'}</p>
    ${rc.error ? `<div class="banner warn">${esc(rc.error)}</div>` : ''}
    ${rc.checkedAt && !open.length ? `<section class="card"><p><b>No open recalls found.</b> This lookup is by model year, not by your exact car, so run NHTSA's own VIN check too.</p></section>` : ''}
    ${open.length ? `<section><h2 class="grp g-overdue">Open <span class="count">${open.length}</span></h2></section>` : ''}
    ${open.map((r) => card(r, true)).join('')}
    ${done.length ? `<section><h2 class="grp">Handled</h2></section>${done.map((r) => card(r, false)).join('')}` : ''}
    <section class="card"><h2>The official check</h2>
      <p class="muted small">Whether a recall applies to your exact car depends on your VIN. NHTSA's own page checks that.</p>
      <a class="btn ghost" href="${R.NHTSA_VIN_URL}" target="_blank" rel="noopener">Open NHTSA recall check</a></section>`;
}

function watchView() {
  return `<div class="topbar"><a class="back" href="#/more">‹ More</a></div>
    <h1 class="title">B48 watch list</h1>
    <p class="muted">Problem areas owners report for the B48. The sources are owner and parts-shop sites, not BMW, and none were specific to 2022 cars. Treat this as a reason to look, not a diagnosis.</p>
    ${WATCH.map((w) => `<section class="card"><h2>${esc(w.title)}</h2>
      <p><span class="tag">${esc(w.confidence)}</span></p>
      <p>${esc(w.body)}</p><p><b>What to do:</b> ${esc(w.action)}</p>
      ${w.item ? `<a class="btn ghost" href="#/item/${w.item}">Open the ${esc(ITEMS[w.item].name.toLowerCase())} reminder</a>` : ''}</section>`).join('')}
    <section class="card note"><h2>Before you spend money</h2>
      <p>Cross-check a suspected problem with a BMW specialist or a model-specific owner forum. Your JB4 tune may change what a shop says is covered.</p></section>`;
}

// ---------------------------------------------------------------- INSTALL + SETUP
function installView() {
  return `<div class="install">
    <h1 class="title">Add 330i Care to your Home Screen first</h1>
    <p>Do this before anything else. Safari and the Home Screen app keep separate data, so anything you enter in Safari will not carry over.</p>
    <ol class="big-steps">
      <li><span class="n">1</span><span>Tap the <b>Share</b> button <svg class="share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg> in Safari's toolbar.</span></li>
      <li><span class="n">2</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
      <li><span class="n">3</span><span>Tap <b>Add</b>, then open the new <b>330i Care</b> icon.</span></li>
    </ol>
    <p class="muted small">On iPhone with Chrome or another browser, open this page in Safari first.</p>
    <button class="link" data-act="browser-ok">Use it in this browser anyway</button>
    <p class="muted small">If you do, your data stays in this browser only.</p></div>`;
}

function newDraft() {
  return { step: 1, miles: String(START_MILES), air: 'unknown', origs: 'unknown', oilDate: '', oilMiles: '' };
}
const setPath = (o, path, v) => {
  const k = path.split('.');
  while (k.length > 1) o = o[k.shift()];
  o[k[0]] = v;
};
const seg3 = (act, cur, opts) =>
  `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;

function setupView() {
  if (!draft) draft = newDraft();
  const d = draft;
  if (d.step === 1)
    return `<div class="steps-bar">Step 1 of 2</div><h1 class="title">Welcome</h1>
      <p>Set up takes about a minute. Everything after the odometer is optional.</p>
      <label class="field">What does the odometer say right now?
        <input type="text" inputmode="numeric" pattern="[0-9]*" data-draft="miles" value="${esc(d.miles)}" data-focus></label>
      <div class="btns"><button class="btn primary block" data-act="s-next">Next</button>
      <button class="btn ghost block" data-act="restore">I already have a backup file. Restore it.</button></div>`;
  return `<div class="steps-bar">Step 2 of 2</div><h1 class="title">Three quick questions</h1>
    <p class="muted">Skip any you don't know. Anything left blank shows up on your list as "Check it" so you can answer it later.</p>
    <section class="card"><h2>Your Dinan air filter</h2>
      <p class="muted small">Is it washable (reusable) or paper?</p>${seg3('s-air', d.air, [['washable', 'Washable'], ['replace', 'Paper'], ['unknown', 'Not sure']])}</section>
    <section class="card"><h2>Original parts</h2>
      <p class="muted small">Have the spark plugs, ignition coils, or the transmission, transfer case or differential fluid ever been replaced?</p>
      ${seg3('s-origs', d.origs, [['yes', 'No, all original'], ['some', 'Some were'], ['unknown', 'Not sure']])}
      ${d.origs === 'some' ? '<p class="muted small">Okay. Those stay on your list as "Check it" and you can answer each one.</p>' : ''}</section>
    <section class="card"><h2>Last oil change</h2>
      <div class="grid2"><label class="field">Date<input type="date" max="${C.today()}" data-draft="oilDate" value="${esc(d.oilDate)}"></label>
      <label class="field">Mileage<input type="text" inputmode="numeric" data-draft="oilMiles" value="${esc(d.oilMiles)}"></label></div></section>
    <div class="btns sticky"><button class="btn ghost" data-act="s-back">Back</button><button class="btn primary" data-act="s-finish">Finish</button></div>`;
}

// Work out when the last service was from a My BMW "due in" number.
function bmwLast(id, milesLeft, dueDate) {
  const cur = ctx().cur || 0;
  if (id === 'oil')
    return {
      miles: milesLeft != null ? Math.max(0, Math.round(cur + milesLeft - FACTORY.oilMiles)) : null,
      date: dueDate ? C.addMonths(dueDate, -FACTORY.oilMonths) : null,
    };
  return { miles: null, date: dueDate ? C.addMonths(dueDate, -FACTORY.brakeFluidMonths) : null };
}
const historyRec = (itemId, o) => ({ itemId, date: null, miles: null, cost: null, shop: '', notes: '', photo: null, source: 'setup', createdAt: Date.now(), ...o });

async function finishSetup() {
  const d = draft;
  const miles = num(d.miles);
  const now = C.today();
  const ops = [{ store: 'mileage', put: { date: now, miles, source: 'setup' } }];
  if (d.origs === 'yes')
    for (const id of ORDER)
      if (ITEMS[id].setupNever) ops.push({ store: 'history', put: historyRec(id, { miles: 0, notes: 'Original, never replaced', source: 'original' }) });
  const om = num(d.oilMiles);
  const od = d.oilDate && d.oilDate <= now ? d.oilDate : null;
  if (om != null || od) ops.push({ store: 'history', put: historyRec('oil', { date: od, miles: om }) });
  ops.push({ store: 'meta', put: { key: 'bmw', value: {} } });
  ops.push({ store: 'meta', put: { key: 'settings', value: { ...S.settings, setupDone: true, setupAt: new Date().toISOString(), airFilterType: d.air } } });
  await DB.batch(ops);
  await load();
  draft = null;
  go('#/');
  toast('All set. Tap any "Check it" row to answer it.');
  if (navigator.onLine) runRecallCheck(false);
}

// ---------------------------------------------------------------- sheets
function milesSheet() {
  const m = ctx().m;
  openSheet(`<h2>Update mileage</h2>
    <p class="muted small">${m.latest ? `Last entered: ${fmtN(m.latest.miles)} mi, ${ago(m.latest.date)}.` : ''}</p>
    <label class="field">Odometer now<input id="f-miles" type="text" inputmode="numeric" pattern="[0-9]*" value="${m.cur ?? ''}" data-focus></label>
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-miles">Save</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
  const f = $('#f-miles');
  f.select();
}

function doneSheet(id) {
  const cx = ctx();
  const it = C.effectiveItem(ITEMS[id], S.over[id], S.settings);
  const cur = cx.cur;
  openSheet(`<h2>Mark done</h2><p class="muted small">${esc(it.name)}</p>
    <div class="grid2">
      <label class="field">Date<input id="d-date" type="date" max="${C.today()}" value="${C.today()}"></label>
      <label class="field">Mileage<input id="d-miles" type="text" inputmode="numeric" value="${cur ?? ''}" data-def="${cur ?? ''}"></label></div>
    <p class="muted small" id="d-hint">Not today? Change the date and the mileage.</p>
    <details><summary>Cost, shop, notes, receipt (optional)</summary>
      <label class="field">Cost<input id="d-cost" type="text" inputmode="decimal" placeholder="$"></label>
      <label class="field">Where<input id="d-shop" type="text" placeholder="Shop or DIY"></label>
      <label class="field">Notes<input id="d-notes" type="text"></label>
      <label class="field">Receipt photo<input id="d-photo" type="file" accept="image/*"></label>
      <img id="d-prev" class="prev" alt="" hidden>
    </details>
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-done" data-id="${id}">Save</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
}

function resolveSheet(id) {
  const it = C.effectiveItem(ITEMS[id], S.over[id], S.settings);
  if (it.kind === 'tires') return tiresSheet();
  const orig = !!ITEMS[id].setupNever;
  const bmw = id === 'oil' || id === 'brakefluid';
  openSheet(`<h2>${esc(it.name)}</h2><p class="muted small">${esc(it.short)}</p>
    <p class="strong" style="margin-top:10px">When was it last done?</p>
    <div class="grid2"><label class="field">Date<input id="r-date" type="date" max="${C.today()}"></label>
    <label class="field">Mileage<input id="r-miles" type="text" inputmode="numeric" placeholder="if you know"></label></div>
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-resolve" data-id="${id}">Save</button>
    ${orig ? `<button class="btn ghost" data-act="resolve-original" data-id="${id}">Original part, never replaced</button>` : ''}
    ${bmw ? `<details><summary>Copy from the My BMW app instead</summary>
      <p class="muted small">Enter what the app says is due and I will work back to when it was last done.</p>
      <div class="grid2">${id === 'oil' ? `<label class="field">Due in (miles)<input id="r-bmw-miles" type="text" inputmode="numeric"></label>` : ''}
      <label class="field">Due by date<input id="r-bmw-date" type="date"></label></div>
      <button class="btn ghost" data-act="save-resolve-bmw" data-id="${id}">Use these numbers</button></details>` : ''}
    <a class="btn ghost" href="#/item/${id}">Open details</a>
    <button class="btn ghost" data-act="close-sheet">Not sure yet</button></div>`);
}

function intervalSheet(id) {
  const it = C.effectiveItem(ITEMS[id], S.over[id], S.settings);
  openSheet(`<h2>Edit interval</h2><p class="muted small">${esc(it.name)}. Whichever comes first applies when both are filled in. Leave one blank for none.</p>
    <div class="grid2"><label class="field">Miles<input id="i-miles" type="text" inputmode="numeric" value="${it.miles ?? ''}" data-focus></label>
    <label class="field">Months<input id="i-months" type="text" inputmode="numeric" value="${it.months ?? ''}"></label></div>
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-interval" data-id="${id}">Save</button>
    ${it.customInterval ? `<button class="btn ghost" data-act="reset-interval" data-id="${id}">Back to starting value</button>` : ''}
    <button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
}

function quoteSheet(id) {
  const it = C.effectiveItem(ITEMS[id], S.over[id], S.settings);
  openSheet(`<h2>Price quote</h2><p class="muted small">${esc(it.name)}</p>
    <label class="field">Amount<input id="q-amt" type="text" inputmode="decimal" placeholder="$" value="${it.quote ? it.quote.amount : ''}" data-focus></label>
    <label class="field">Who quoted it<input id="q-label" type="text" placeholder="e.g. Local shop, Mar 2026" value="${it.quote && it.quote.label !== 'My quote' ? esc(it.quote.label) : ''}"></label>
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-quote" data-id="${id}">Save</button>
    ${it.quote ? `<button class="btn ghost" data-act="clear-quote" data-id="${id}">Remove quote</button>` : ''}
    <button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
}

function tiresSheet() {
  const ex = (S.over.tires || {}).extra || {};
  openSheet(`<h2>Tread + tire age</h2>
    <label class="field">Tread depth (32nds of an inch)<input id="t-tread" type="text" inputmode="decimal" value="${ex.tread ?? ''}" data-focus></label>
    <p class="muted small">New tires are about 10/32 to 11/32. 4/32 or less is time to shop. 2/32 is the legal minimum in most states.</p>
    <label class="field">DOT date code (4 digits)<input id="t-dot" type="text" inputmode="numeric" maxlength="4" value="${ex.dot ? esc(ex.dot.code) : ''}"></label>
    <p class="muted small">On the tire sidewall, find "DOT" and read the last four digits. 2321 means week 23 of 2021.</p>
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-tires">Save</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
}

function bmwSheet(id) {
  const b = id === 'brakes' ? S.bmw.brakePads : S.bmw.vehicleCheck;
  openSheet(`<h2>From the My BMW app</h2><p class="muted small">${id === 'brakes' ? 'Brakes' : 'Vehicle check'}, from the service requirements list.</p>
    <label class="field">${id === 'brakes' ? 'Miles of pad life left' : 'Due in (miles)'}<input id="b-miles" type="text" inputmode="numeric" value="${b && b.milesLeft != null ? b.milesLeft : ''}" data-focus></label>
    ${id === 'brakes' ? '' : `<label class="field">Or by date<input id="b-date" type="date" value="${b && b.dueDate ? b.dueDate : ''}"></label>`}
    <p class="err" id="f-err"></p>
    <div class="btns"><button class="btn primary" data-act="save-bmw" data-id="${id}">Save</button><button class="btn ghost" data-act="close-sheet">Cancel</button></div>`);
}

function entrySheet(hid) {
  const h = S.history.find((x) => x.id === hid);
  if (!h) return;
  const it = ITEMS[h.itemId] || { name: h.itemId };
  openSheet(`<h2>${esc(it.name)}</h2>
    <dl class="kv"><dt>Date</dt><dd>${fmtDate(h.date) || 'Not known'}</dd><dt>Mileage</dt><dd>${h.miles != null ? fmtN(h.miles) + ' mi' : 'Not known'}</dd>
    <dt>Cost</dt><dd>${h.cost != null ? money(h.cost) : 'Not entered'}</dd><dt>Where</dt><dd>${esc(h.shop) || 'Not entered'}</dd>
    ${h.notes ? `<dt>Notes</dt><dd>${esc(h.notes)}</dd>` : ''}</dl>
    ${h.photo ? `<img class="receipt" src="${h.photo}" alt="Receipt photo">` : ''}
    <div class="btns"><button class="btn danger-ghost" data-act="del-entry" data-id="${h.id}">Delete this entry</button><button class="btn ghost" data-act="close-sheet">Close</button></div>`);
}

// ---------------------------------------------------------------- files
async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

async function exportBackup() {
  const nowIso = new Date().toISOString();
  const dump = await DB.dumpAll();
  const settings = { ...S.settings, lastBackup: nowIso };
  dump.meta = dump.meta.filter((r) => r.key !== 'settings').concat([{ key: 'settings', value: settings }]);
  const payload = { app: APP_ID, version: 1, exportedAt: nowIso, data: dump };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const res = await deliver(blob, `330i-care-backup-${C.today()}.json`);
  if (res === 'cancelled') return;
  S.settings = settings;
  await saveSettings();
  toast(res === 'shared' ? 'Backup saved' : 'Backup downloaded. Find it in Files.');
  render();
}

let pendingRestore = null;
async function readRestoreFile(file) {
  try {
    const p = JSON.parse(await file.text());
    if (!p || p.app !== APP_ID || !p.data || !Array.isArray(p.data.history) || !Array.isArray(p.data.mileage)) throw new Error('bad');
    pendingRestore = p;
    confirmSheet({
      title: 'Replace everything with this backup?',
      body: `Backup from ${esc(fmtDate((p.exportedAt || '').slice(0, 10)))}: ${plural(p.data.history.length, 'service entry').replace('entrys', 'entries')} and ${plural(p.data.mileage.length, 'mileage entry').replace('entrys', 'entries')}. What is on this phone now will be replaced.`,
      yes: 'Restore',
      act: 'do-restore',
    });
  } catch {
    toast("That file isn't a 330i Care backup");
  }
}

async function readPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const wrapCal = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//330i Care//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR', ''].join('\r\n');

// Same UID every time, so importing again updates the event instead of copying it.
function veventFor(ev) {
  const it = ev.item;
  const day = ev.estDue.replace(/-/g, '');
  const end = C.addDays(ev.estDue, 1).replace(/-/g, '');
  const desc = `${it.name} is due (estimated). ${intervalText(it)}. Open 330i Care to update mileage and mark it done.`;
  return [
    'BEGIN:VEVENT', `UID:${it.id}-due@330i-care`, `DTSTAMP:${icsStamp()}`, `SEQUENCE:${Math.floor(Date.now() / 1000)}`,
    `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsText('BMW 330i: ' + it.name + ' due')}`, `DESCRIPTION:${icsText(desc)}`, 'TRANSP:TRANSPARENT',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(it.name + ' due in a week')}`, 'TRIGGER:-P6DT15H', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(it.name + ' due today')}`, 'TRIGGER:PT9H', 'END:VALARM',
    'END:VEVENT',
  ];
}
const icsFor = (ev) => wrapCal(veventFor(ev));

function mileageEvent() {
  const d = new Date();
  if (d.getDate() !== 1) { d.setMonth(d.getMonth() + 1); d.setDate(1); }
  const day = C.toStr(d).replace(/-/g, '');
  const end = C.addDays(C.toStr(d), 1).replace(/-/g, '');
  return [
    'BEGIN:VEVENT', 'UID:mileage-monthly@330i-care', `DTSTAMP:${icsStamp()}`, `SEQUENCE:${Math.floor(Date.now() / 1000)}`,
    `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${end}`, 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
    'SUMMARY:Update BMW mileage', `DESCRIPTION:${icsText('Open the 330i Care icon on your Home Screen and tap Update mileage.')}`, 'TRANSP:TRANSPARENT',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Update BMW mileage', 'TRIGGER:PT9H', 'END:VALARM',
    'END:VEVENT',
  ];
}

async function runRecallCheck(manual) {
  try {
    const res = await R.checkRecalls(S.settings.vin);
    S.recalls = { ...S.recalls, ...res, error: null };
  } catch {
    S.recalls = { ...S.recalls, error: 'Could not reach NHTSA. You may be offline. Showing the last result.' };
    if (manual) toast('Could not reach NHTSA');
  }
  await saveRecalls();
  render();
}

// ---------------------------------------------------------------- actions
const A = {
  'close-sheet': () => closeSheet(),
  'dismiss-install': () => { installDismissed = true; render(); },
  'update-miles': () => milesSheet(),
  'save-miles': async () => {
    const v = num($('#f-miles').value);
    const m = ctx().m;
    const err = $('#f-err');
    if (v == null || v < 0 || v > 999999) return (err.textContent = 'Enter the odometer reading.');
    if (m.latest && v < m.latest.miles) return (err.textContent = `That is lower than your last entry (${fmtN(m.latest.miles)}).`);
    const rec = { date: C.today(), miles: Math.round(v), source: 'update' };
    rec.id = await DB.put('mileage', rec);
    S.mileage.push(rec);
    closeSheet();
    toast('Mileage updated');
    render();
  },
  done: (t) => doneSheet(t.dataset.id),
  'save-done': async (t) => {
    const id = t.dataset.id;
    const err = $('#f-err');
    const date = $('#d-date').value || C.today();
    if (date > C.today()) return (err.textContent = 'That date is in the future.');
    const miles = num($('#d-miles').value);
    const def = num($('#d-miles').dataset.def);
    const cost = num($('#d-cost').value);
    const shop = $('#d-shop').value.trim();
    const notes = $('#d-notes').value.trim();
    const photoFile = $('#d-photo').files[0];
    let photo = null;
    if (photoFile) {
      try { photo = await readPhoto(photoFile); } catch { return (err.textContent = "Couldn't read that photo. Try another."); }
    }
    const entry = { itemId: id, date, miles: miles != null ? Math.round(miles) : null, cost, shop, notes, photo, source: 'done', createdAt: Date.now() };
    entry.id = await DB.put('history', entry);
    S.history.push(entry);
    if (entry.miles != null && entry.miles !== def) {
      const mrec = { date, miles: entry.miles, source: 'done' };
      mrec.id = await DB.put('mileage', mrec);
      S.mileage.push(mrec);
    }
    if (id === 'tires') await saveOver('tires', { extra: {} });
    closeSheet();
    toast('Marked done');
    render();
  },
  interval: (t) => intervalSheet(t.dataset.id),
  'save-interval': async (t) => {
    const miles = num($('#i-miles').value);
    const months = num($('#i-months').value);
    if (miles == null && months == null) return ($('#f-err').textContent = 'Fill in miles, months or both.');
    await saveOver(t.dataset.id, { miles: miles == null ? null : Math.round(miles), months: months == null ? null : Math.round(months) });
    closeSheet();
    render();
  },
  'reset-interval': async (t) => {
    const rec = { ...(S.over[t.dataset.id] || { id: t.dataset.id }) };
    delete rec.miles;
    delete rec.months;
    S.over[t.dataset.id] = rec;
    await DB.put('items', rec);
    closeSheet();
    render();
  },
  quote: (t) => quoteSheet(t.dataset.id),
  'save-quote': async (t) => {
    const amt = num($('#q-amt').value);
    if (amt == null || amt < 0) return ($('#f-err').textContent = 'Enter an amount.');
    await saveOver(t.dataset.id, { quote: { amount: amt, label: $('#q-label').value.trim() || 'My quote' } });
    closeSheet();
    render();
  },
  'clear-quote': async (t) => {
    await saveOver(t.dataset.id, { quote: { amount: null } });
    closeSheet();
    render();
  },
  tires: () => tiresSheet(),
  'save-tires': async () => {
    const tread = num($('#t-tread').value);
    const raw = $('#t-dot').value.trim();
    const dot = raw ? C.parseDot(raw) : null;
    if (raw && !dot) return ($('#f-err').textContent = 'DOT code should be 4 digits, like 2321.');
    const extra = {};
    if (tread != null) extra.tread = tread;
    if (dot) extra.dot = { ...dot, code: raw };
    await saveOver('tires', { extra });
    closeSheet();
    render();
  },
  bmwdue: (t) => bmwSheet(t.dataset.id),
  'save-bmw': async (t) => {
    const miles = num($('#b-miles').value);
    const dateEl = $('#b-date');
    const dueDate = dateEl ? dateEl.value || null : null;
    const now = C.today();
    if (t.dataset.id === 'brakes') {
      if (miles == null) return ($('#f-err').textContent = 'Enter the miles shown.');
      S.bmw.brakePads = { milesLeft: miles, enteredOn: now };
    } else {
      if (miles == null && !dueDate) return ($('#f-err').textContent = 'Enter miles, a date, or both.');
      S.bmw.vehicleCheck = { milesLeft: miles, dueDate, enteredOn: now, enteredMiles: ctx().cur };
    }
    await saveBmw();
    closeSheet();
    render();
  },
  air: async (t) => {
    S.settings.airFilterType = t.dataset.v;
    await saveSettings();
    render();
  },
  entry: (t) => entrySheet(+t.dataset.id),
  'del-entry': (t) => confirmSheet({ title: 'Delete this entry?', body: 'It is removed from history and the due date recalculates.', yes: 'Delete', danger: true, act: 'do-del-entry', data: `data-id="${t.dataset.id}"` }),
  'do-del-entry': async (t) => {
    const id = +t.dataset.id;
    await DB.remove('history', id);
    S.history = S.history.filter((h) => h.id !== id);
    closeSheet();
    toast('Deleted');
    render();
  },
  cal: async (t) => {
    const ev = evalItem(t.dataset.id, ctx());
    if (!ev.estDue) return;
    const blob = new Blob([icsFor(ev)], { type: 'text/calendar' });
    const r = await deliver(blob, `${ev.item.id}-due.ics`);
    if (r === 'downloaded') toast('Saved. Open the file to add it to Calendar.');
  },
  'cal-all': async () => {
    const evs = allEvals(ctx()).filter((e) => e.estDue && e.status !== 'check');
    const blob = new Blob([wrapCal([...evs.flatMap(veventFor), ...mileageEvent()])], { type: 'text/calendar' });
    const r = await deliver(blob, '330i-care-reminders.ics');
    if (r === 'downloaded') toast('Saved. Open the file to add everything to Calendar.');
  },
  'recalls-check': async () => {
    const v = $('#vin').value.trim().toUpperCase();
    if (v && !R.validVin(v)) return ($('#f-err').textContent = 'A VIN is 17 letters and numbers, with no I, O or Q.');
    S.settings.vin = v;
    await saveSettings();
    toast('Checking...');
    await runRecallCheck(true);
  },
  'recall-handled': async (t) => {
    const h = new Set(S.recalls.handled || []);
    const n = t.dataset.n;
    if (h.has(n)) h.delete(n); else h.add(n);
    S.recalls = { ...S.recalls, handled: [...h] };
    await saveRecalls();
    render();
  },
  export: () => exportBackup(),
  restore: () => $('#restore-file').click(),
  'do-restore': async () => {
    const p = pendingRestore;
    if (!p) return;
    await DB.replaceAll(p.data);
    await load();
    pendingRestore = null;
    closeSheet();
    go('#/');
    toast('Backup restored');
  },
  wipe: () => confirmSheet({ title: 'Delete everything?', body: `This removes ${plural(S.history.length, 'service entry').replace('entrys', 'entries')} and ${plural(S.mileage.length, 'mileage entry').replace('entrys', 'entries')} from this phone. It cannot be undone. Back up first if unsure.`, yes: 'Delete all data', danger: true, act: 'do-wipe' }),
  'do-wipe': async () => {
    await DB.replaceAll({});
    await load();
    draft = null;
    closeSheet();
    go('#/setup');
  },
  // setup
  resolve: (t) => resolveSheet(t.dataset.id),
  'save-resolve': async (t) => {
    const id = t.dataset.id;
    const it = C.effectiveItem(ITEMS[id], S.over[id], S.settings);
    const date = $('#r-date').value || null;
    const miles = num($('#r-miles').value);
    const err = $('#f-err');
    if (date && date > C.today()) return (err.textContent = 'That date is in the future.');
    if (date == null && miles == null) return (err.textContent = 'Add a date or a mileage, or tap Not sure yet.');
    if (it.miles && !it.months && miles == null) return (err.textContent = 'This one counts miles, so add the mileage.');
    if (it.months && !it.miles && !date) return (err.textContent = 'This one counts time, so add the date.');
    await addHistory(historyRec(id, { date, miles: miles != null ? Math.round(miles) : null }));
    closeSheet();
    toast('Saved');
    render();
  },
  'resolve-original': async (t) => {
    await addHistory(historyRec(t.dataset.id, { miles: 0, notes: 'Original, never replaced', source: 'original' }));
    closeSheet();
    toast('Saved as original');
    render();
  },
  'save-resolve-bmw': async (t) => {
    const id = t.dataset.id;
    const mEl = $('#r-bmw-miles');
    const last = bmwLast(id, mEl ? num(mEl.value) : null, $('#r-bmw-date').value || null);
    if (last.miles == null && !last.date) return ($('#f-err').textContent = 'Enter what the My BMW app shows.');
    await addHistory(historyRec(id, { date: last.date, miles: last.miles, notes: 'Worked out from My BMW app numbers', source: 'bmw' }));
    closeSheet();
    toast('Saved');
    render();
  },
  'browser-ok': () => {
    try { sessionStorage.setItem('browserOk', '1'); } catch { /* ignore */ }
    render(true);
  },
  's-next': () => {
    const v = num(draft.miles);
    if (v == null || v < 0) return toast('Enter the odometer reading first');
    draft.step = 2;
    render(true);
  },
  's-back': () => { draft.step = 1; render(true); },
  's-air': (t) => { draft.air = t.dataset.v; render(); },
  's-origs': (t) => { draft.origs = t.dataset.v; render(); },
  's-finish': () => finishSetup(),
};

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const fn = A[t.dataset.act];
  if (fn) {
    e.preventDefault();
    Promise.resolve(fn(t, e)).catch((err) => { console.error(err); toast('Something went wrong'); });
  }
});
document.addEventListener('input', (e) => {
  const p = e.target.dataset && e.target.dataset.draft;
  if (p && draft) setPath(draft, p, e.target.value);
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'restore-file' && t.files[0]) {
    await readRestoreFile(t.files[0]);
    t.value = '';
  }
  if (t.id === 'd-date') {
    const miles = $('#d-miles');
    const isToday = t.value === C.today();
    if (!isToday && miles.value === miles.dataset.def) miles.value = '';
    if (isToday && miles.value === '') miles.value = miles.dataset.def;
    $('#d-hint').textContent = isToday ? 'Not today? Change the date and the mileage.' : 'Add the mileage from then if you know it, so mile-based reminders work.';
  }
  if (t.id === 'd-photo' && t.files[0]) {
    try {
      const url = await readPhoto(t.files[0]);
      const img = $('#d-prev');
      img.src = url;
      img.hidden = false;
    } catch { toast("Couldn't read that photo"); }
  }
});

// ---------------------------------------------------------------- routing
function go(hash) {
  if (location.hash === hash) render(true);
  else location.hash = hash;
}
function render(scrollTop) {
  if (!S.ready) return;
  let hash = location.hash || '#/';
  if (!S.settings.setupDone && hash !== '#/setup') {
    history.replaceState(null, '', '#/setup');
    hash = '#/setup';
  }
  const view = $('#view');
  const keep = scrollTop ? 0 : window.scrollY;
  let html;
  let tab = 'home';
  let chrome = true;
  const m = /^#\/item\/(\w+)/.exec(hash);
  if (needsInstall()) { html = installView(); chrome = false; }
  else if (hash === '#/setup') { html = setupView(); chrome = false; }
  else if (m) { html = itemView(m[1]); chrome = false; }
  else if (hash === '#/history') { html = historyView(); tab = 'history'; }
  else if (hash === '#/more') { html = moreView(); tab = 'more'; }
  else if (hash === '#/recalls') { html = recallsView(); tab = 'more'; }
  else if (hash === '#/watch') { html = watchView(); tab = 'more'; }
  else html = homeView();
  view.innerHTML = html;
  document.body.classList.toggle('no-nav', !chrome);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  window.scrollTo(0, keep);
}
let lastHash = null;
window.addEventListener('hashchange', () => {
  closeSheet();
  render(location.hash !== lastHash);
  lastHash = location.hash;
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      try { S.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { /* ignore */ }
    }
    await DB.open();
    await load();
  } catch (e) {
    $('#view').innerHTML = `<div class="banner warn"><b>This browser blocked local storage.</b> The app needs it to save your data. Open it from the Home Screen icon, not a private tab.</div>`;
    return;
  }
  S.ready = true;
  lastHash = location.hash;
  render(true);
  // Refresh "est." numbers when the app is reopened after a while.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#sheet-root.open')) render(); });
  if (S.settings.setupDone && navigator.onLine && (!S.recalls.checkedAt || C.diffDays(S.recalls.checkedAt.slice(0, 10), C.today()) >= 7)) runRecallCheck(false);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.__app = { S, ctx, evalItem, allEvals, C }; // handy for tests
})();
