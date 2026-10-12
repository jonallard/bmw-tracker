// Safety recall lookup against NHTSA's free public APIs. Needs a connection;
// results are cached on the phone so the last answer shows offline.
// NHTSA looks recalls up by make, model and year, not by VIN, so a hit means
// "applies to this model year". The official VIN check stays one tap away.

export const NHTSA_VIN_URL = 'https://www.nhtsa.gov/recalls';
const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/';
const RECALLS = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
export const DEFAULT_VEHICLE = { make: 'BMW', model: '330i', year: 2022 };
export const validVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(v || '').trim());

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function decodeVin(vin) {
  const j = await getJson(`${VPIC}${encodeURIComponent(vin.trim())}?format=json`);
  const v = (j.Results || [])[0] || {};
  const year = parseInt(v.ModelYear, 10);
  if (!v.Make || !v.Model || !year) return null;
  return { make: v.Make, model: v.Model, trim: v.Trim || '', year };
}

// NHTSA's model names for BMW are not obvious, so try a few spellings.
export function modelNames(vehicle) {
  const names = [vehicle.model, '330i', '330i xDrive', '3 Series'];
  return [...new Set(names.filter(Boolean).map((n) => n.trim()))];
}

export function normalize(row) {
  return {
    id: String(row.NHTSACampaignNumber || row.nhtsaCampaignNumber || ''),
    component: row.Component || row.component || '',
    summary: row.Summary || row.summary || '',
    consequence: row.Consequence || row.consequence || '',
    remedy: row.Remedy || row.remedy || '',
    date: row.ReportReceivedDate || row.reportReceivedDate || '',
  };
}

// Returns { checkedAt, vehicle, decoded, items }. Throws if every lookup failed.
export async function checkRecalls(vin, now = new Date()) {
  let vehicle = { ...DEFAULT_VEHICLE };
  let decoded = false;
  if (validVin(vin)) {
    try {
      const d = await decodeVin(vin);
      if (d) { vehicle = d; decoded = true; }
    } catch { /* fall back to the default vehicle */ }
  }
  const found = new Map();
  let anyOk = false;
  for (const model of modelNames(vehicle)) {
    const url = `${RECALLS}?make=${encodeURIComponent(vehicle.make)}&model=${encodeURIComponent(model)}&modelYear=${vehicle.year}`;
    try {
      const j = await getJson(url);
      anyOk = true;
      for (const row of j.results || j.Results || []) {
        const n = normalize(row);
        if (n.id && !found.has(n.id)) found.set(n.id, n);
      }
    } catch { /* try the next spelling */ }
  }
  if (!anyOk) throw new Error('lookup failed');
  return { checkedAt: now.toISOString(), vehicle, decoded, items: [...found.values()] };
}
