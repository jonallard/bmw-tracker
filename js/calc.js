// Pure logic: dates, mileage estimate, and "what is due". No DOM in here.
import { applyAirFilterType } from './items.js';

export const SOON_MILES = 1000;
export const SOON_DAYS = 30;

// ---------- dates (all as local 'YYYY-MM-DD' strings) ----------
const pad = (n) => String(n).padStart(2, '0');
export const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
export const today = () => toStr(new Date());
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return toStr(d);
}
export function addMonths(s, n) {
  const d = parse(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toStr(d);
}

// ---------- mileage ----------
// entries: [{date, miles}]. Average miles/day comes from the entries over the
// last year; it needs two readings at least a week apart.
export function mileageModel(entries, now = today()) {
  const pts = entries
    .filter((e) => e.date && Number.isFinite(e.miles))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.miles - b.miles));
  if (!pts.length) return { cur: null, latest: null, rate: null, isEst: false, daysSince: 0 };
  const latest = pts[pts.length - 1];
  const cutoff = addDays(latest.date, -365);
  const first = pts.find((p) => p.date >= cutoff);
  const span = diffDays(first.date, latest.date);
  let rate = null;
  if (span >= 7 && latest.miles > first.miles) rate = (latest.miles - first.miles) / span;
  const daysSince = Math.max(0, diffDays(latest.date, now));
  const isEst = !!rate && daysSince > 0;
  const cur = rate ? Math.round(latest.miles + rate * daysSince) : latest.miles;
  return { cur, latest, rate, isEst, daysSince };
}

// ---------- tires ----------
// DOT date code is 4 digits: week then 2-digit year, e.g. 2321 = week 23 of 2021.
export function parseDot(code) {
  const m = /^(\d{2})(\d{2})$/.exec(String(code || '').trim());
  if (!m) return null;
  const week = +m[1];
  const year = 2000 + +m[2];
  if (week < 1 || week > 53) return null;
  return { week, year };
}
export function tireAgeYears(dot, now = today()) {
  if (!dot) return null;
  const made = addDays(`${dot.year}-01-01`, (dot.week - 1) * 7);
  return diffDays(made, now) / 365.25;
}

// ---------- item state ----------
export function effectiveItem(def, over = {}, settings = {}) {
  let it = applyAirFilterType(def, settings.airFilterType);
  it = { ...it };
  if (over.miles !== undefined) it.miles = over.miles;
  if (over.months !== undefined) it.months = over.months;
  it.customInterval = over.miles !== undefined || over.months !== undefined;
  it.defaultMiles = def.miles;
  it.defaultMonths = def.months;
  const q = over.quote !== undefined ? over.quote : it.defaultQuote;
  it.quote = q && q.amount != null ? q : null;
  it.extra = over.extra || {};
  return it;
}

export function latestEntry(entries) {
  if (!entries.length) return null;
  return entries.slice().sort((a, b) => {
    const da = a.date || '0000-00-00';
    const db = b.date || '0000-00-00';
    return da < db ? 1 : da > db ? -1 : b.id - a.id;
  })[0];
}

const sev = (left, soon) => (left == null ? -1 : left < 0 ? 2 : left <= soon ? 1 : 0);

// Returns everything the screens need about one item.
export function evaluate(it, entries, ctx, settings = {}, bmw = null) {
  const { cur, rate, now } = ctx;
  const last = latestEntry(entries);
  const base = { item: it, last, status: 'ok', milesLeft: null, daysLeft: null, primary: null,
    dueDate: null, estDue: null, sortKey: 1e9, costDollars: costFor(it, entries) };

  if (it.kind === 'record') return { ...base, status: 'ok', sortKey: 1e9 };

  if (it.kind === 'tires') {
    const t = it.extra.tread;
    const dot = it.extra.dot;
    const age = tireAgeYears(dot, now);
    if (t == null && age == null) return { ...base, status: 'check', age, tread: t };
    const sTread = t == null ? -1 : t <= 2 ? 2 : t <= 4 ? 1 : 0;
    const sAge = age == null ? -1 : age >= 10 ? 2 : age >= 6 ? 1 : 0;
    const s = Math.max(sTread, sAge);
    return { ...base, status: ['ok', 'soon', 'overdue'][s], age, tread: t, sortKey: 1e8 - s * 1e8 };
  }

  if (it.kind === 'cardue') {
    const cd = bmw && bmw.vehicleCheck;
    const stale = cd && last && last.date && cd.enteredOn && last.date >= cd.enteredOn;
    if (!cd || stale || (cd.milesLeft == null && !cd.dueDate)) return { ...base, status: 'ok', noSchedule: true };
    const milesLeft = cd.milesLeft != null && cur != null ? cd.enteredMiles + cd.milesLeft - cur : null;
    const daysLeft = cd.dueDate ? diffDays(now, cd.dueDate) : null;
    return finish(base, it, milesLeft, daysLeft, rate, ctx, cd.dueDate || null, null);
  }

  let usable = last;
  if (!usable && it.optional) usable = { miles: 0, date: null, assumed: true };
  if (!usable) return { ...base, status: 'check' };

  let milesLeft = null;
  let daysLeft = null;
  let dueDate = null;
  if (it.miles && usable.miles != null && cur != null) milesLeft = usable.miles + it.miles - cur;
  if (it.months && usable.date) {
    dueDate = addMonths(usable.date, it.months);
    daysLeft = diffDays(now, dueDate);
  }
  if (milesLeft == null && daysLeft == null) return { ...base, status: 'check' };
  return finish(base, it, milesLeft, daysLeft, rate, ctx, dueDate, it.miles);
}

function finish(base, it, milesLeft, daysLeft, rate, ctx, dueDate, intervalMiles) {
  const sm = sev(milesLeft, SOON_MILES);
  const sd = sev(daysLeft, SOON_DAYS);
  const worst = Math.max(sm, sd);
  const status = worst === 2 ? 'overdue' : worst === 1 ? 'soon' : 'ok';

  // Whichever comes first: pick the dimension that is more urgent.
  let primary;
  if (milesLeft == null) primary = 'days';
  else if (daysLeft == null) primary = 'miles';
  else if (sm !== sd) primary = sm > sd ? 'miles' : 'days';
  else if (rate) primary = daysLeft <= milesLeft / rate ? 'days' : 'miles';
  else {
    const fm = milesLeft / (intervalMiles || 1);
    const fd = daysLeft / ((it.months || 1) * 30.4375);
    primary = fd <= fm ? 'days' : 'miles';
  }

  // Estimated due date (for the calendar and for ordering).
  const cands = [];
  if (daysLeft != null) cands.push(daysLeft);
  if (milesLeft != null && rate) cands.push(milesLeft <= 0 ? 0 : Math.ceil(milesLeft / rate));
  const estDays = cands.length ? Math.max(0, Math.min(...cands)) : null;
  const estDue = estDays == null ? null : addDays(ctx.now, estDays);

  let sortKey;
  if (rate || milesLeft == null) {
    sortKey = Math.min(...[daysLeft, milesLeft != null && rate ? milesLeft / rate : null].filter((v) => v != null));
  } else if (daysLeft == null) {
    sortKey = (milesLeft / (intervalMiles || 1)) * 365;
  } else {
    sortKey = Math.min(daysLeft, (milesLeft / (intervalMiles || 1)) * 365);
  }
  return { ...base, status, milesLeft, daysLeft, primary, dueDate, estDue, sortKey };
}

// Most recent real price paid, else the saved quote. Never invented.
export function costFor(it, entries) {
  const paid = entries
    .filter((e) => e.cost != null)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1))[0];
  if (paid) return { amount: paid.cost, label: 'You paid', kind: 'paid', date: paid.date };
  if (it.quote) return { amount: it.quote.amount, label: it.quote.label || 'My quote', kind: 'quote' };
  return null;
}

export const GROUPS = [
  ['overdue', 'Overdue'],
  ['soon', 'Due soon'],
  ['ok', 'OK'],
  ['check', 'Check it'],
];

export function sortEvals(list) {
  return list.slice().sort((a, b) => a.sortKey - b.sortKey);
}
