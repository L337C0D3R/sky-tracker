// Rich "details" sheet for any selected object: live position, facts, orbit,
// upcoming passes / rise-set, and a Wikipedia summary.
import { Sky } from './sky.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (x, d = 0) => Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------- Static facts ----------------
const PLANET_FACTS = {
  Sun: { what: 'G2V yellow dwarf star', Diameter: '1,392,700 km', Mass: '333,000 × Earth', 'Surface temp': '≈ 5,500 °C', Age: '≈ 4.6 billion years', Rotation: '≈ 25 days (equator)' },
  Moon: { what: 'Earth’s only natural satellite', Diameter: '3,474 km', Mass: '0.012 × Earth', 'Orbit period': '27.3 days', 'Phase cycle': '29.5 days', 'Surface gravity': '0.17 g', Temperature: '−173 to 127 °C' },
  Mercury: { what: 'Smallest planet, closest to the Sun', Diameter: '4,879 km', Mass: '0.055 × Earth', Moons: '0', 'Day (rotation)': '58.6 days', Year: '88 days', Temperature: '−173 to 427 °C' },
  Venus: { what: 'Hottest planet, thick CO₂ atmosphere', Diameter: '12,104 km', Mass: '0.815 × Earth', Moons: '0', 'Day (rotation)': '243 days, backwards', Year: '225 days', Temperature: '≈ 464 °C' },
  Mars: { what: 'The red planet', Diameter: '6,779 km', Mass: '0.107 × Earth', Moons: '2 (Phobos, Deimos)', 'Day (rotation)': '24.6 h', Year: '687 days', Temperature: '≈ −63 °C average' },
  Jupiter: { what: 'Largest planet, a gas giant', Diameter: '139,820 km', Mass: '318 × Earth', Moons: '95+', 'Day (rotation)': '9.9 h', Year: '11.9 years', Temperature: '≈ −110 °C (cloud tops)' },
  Saturn: { what: 'Gas giant with the brightest rings', Diameter: '116,460 km', Mass: '95 × Earth', Moons: '274 (2025 count)', 'Day (rotation)': '10.7 h', Year: '29.5 years', Temperature: '≈ −140 °C (cloud tops)' },
  Uranus: { what: 'Ice giant tipped on its side', Diameter: '50,724 km', Mass: '14.5 × Earth', Moons: '28+', 'Day (rotation)': '17.2 h, backwards', Year: '84 years', Temperature: '≈ −195 °C' },
  Neptune: { what: 'Windiest planet, an ice giant', Diameter: '49,244 km', Mass: '17.1 × Earth', Moons: '16', 'Day (rotation)': '16.1 h', Year: '165 years', Temperature: '≈ −200 °C' },
  Pluto: { what: 'Dwarf planet in the Kuiper belt', Diameter: '2,377 km', Mass: '0.002 × Earth', Moons: '5 (largest: Charon)', 'Day (rotation)': '6.4 days', Year: '248 years', Temperature: '≈ −230 °C' },
};
const ASTEROID_FACTS = {
  Ceres: { d: '939 km', note: 'Largest object in the asteroid belt; a dwarf planet visited by NASA’s Dawn (2015–18).' },
  Pallas: { d: '512 km', note: 'Second asteroid ever discovered (1802), on a steeply tilted orbit.' },
  Juno: { d: '247 km', note: 'Third asteroid discovered (1804).' },
  Vesta: { d: '525 km', note: 'Brightest asteroid; sometimes visible to the naked eye. Orbited by Dawn in 2011–12.' },
  Hygiea: { d: '434 km', note: 'Fourth-largest asteroid; may be round enough to be a dwarf planet.' },
  Psyche: { d: '≈ 222 km', note: 'Metal-rich asteroid; NASA’s Psyche spacecraft arrives in 2029.' },
  Eros: { d: '16.8 km', note: 'First asteroid orbited and landed on (NEAR Shoemaker, 2001).' },
  Itokawa: { d: '0.33 km', note: 'Japan’s Hayabusa returned the first asteroid samples from it (2010).' },
  Didymos: { d: '0.78 km', note: 'Its moonlet Dimorphos was hit by NASA’s DART in 2022, changing its orbit.' },
  Apophis: { d: '0.34 km', note: 'Will pass ~32,000 km from Earth on 13 April 2029, visible to the naked eye. No impact risk.' },
  Bennu: { d: '0.49 km', note: 'NASA’s OSIRIS-REx returned samples from it in 2023.' },
  Ryugu: { d: '0.9 km', note: 'Japan’s Hayabusa2 returned samples from it in 2020.' },
};
const OWNERS = {
  US: 'United States', CIS: 'Russia (incl. former USSR)', PRC: 'China', ISS: 'International (ISS partners)', ESA: 'European Space Agency',
  JPN: 'Japan', IND: 'India', FR: 'France', UK: 'United Kingdom', GER: 'Germany', CA: 'Canada', IT: 'Italy', ISRA: 'Israel',
  SKOR: 'South Korea', EUME: 'EUMETSAT', EUTE: 'Eutelsat', SES: 'SES', GLOB: 'Globalstar', IRID: 'Iridium', ORB: 'Orbcomm',
  O3B: 'O3b / SES', AB: 'Arab Satellite Comms Org.', NZ: 'New Zealand', UAE: 'United Arab Emirates', TURK: 'Türkiye', BRAZ: 'Brazil',
  ARGN: 'Argentina', AUS: 'Australia', SPN: 'Spain', TWN: 'Taiwan', IRAN: 'Iran', NKOR: 'North Korea', ITSO: 'Intelsat',
};
const SITES = {
  AFETR: 'Cape Canaveral, USA', AFWTR: 'Vandenberg, USA', TYMSC: 'Baikonur, Kazakhstan', PLMSC: 'Plesetsk, Russia', VOSTO: 'Vostochny, Russia',
  KYMSC: 'Kapustin Yar, Russia', JSC: 'Jiuquan, China', TSC: 'Taiyuan, China', XSC: 'Xichang, China', WSC: 'Wenchang, China', YSLA: 'Yellow Sea (sea launch), China',
  SRILR: 'Sriharikota, India', FRGUI: 'Kourou, French Guiana', TNSTA: 'Tanegashima, Japan', KSCUT: 'Uchinoura, Japan', RLLB: 'Mahia, New Zealand',
  WRAS: 'Wallops Island, USA', KWAJ: 'Kwajalein Atoll', SEAL: 'Sea Launch platform', YAVNE: 'Palmachim, Israel', SNMLP: 'San Marco, Kenya',
  SVOB: 'Svobodny, Russia', DLS: 'Dombarovsky, Russia', NSC: 'Naro, South Korea', SEMLS: 'Semnan, Iran', SMTS: 'Shahrud, Iran',
  YUN: 'Sohae, North Korea', KODAK: 'Kodiak, USA', OREN: 'Yasny, Russia', ERAS: 'Air launch (Pegasus)', STAR: 'Starbase, USA',
};
const OBJ_TYPE = { PAY: 'Payload (spacecraft)', 'R/B': 'Rocket body (spent stage)', DEB: 'Debris fragment', UNK: 'Unknown object' };
const OPS = { '+': 'Operational', '-': 'Not operational', P: 'Partially operational', B: 'Backup', S: 'Spare', X: 'Extended mission', D: 'Decayed', '?': 'Unknown' };
const SAT_WIKI = { 25544: 'International Space Station', 48274: 'Tiangong space station', 20580: 'Hubble Space Telescope', 43013: 'NOAA-20', 33591: 'NOAA-19', 25994: 'Terra (satellite)', 27424: 'Aqua (satellite)', 39084: 'Landsat 8', 49260: 'Landsat 9' };
const PLANET_WIKI = { Mercury: 'Mercury (planet)', Ceres: 'Ceres (dwarf planet)' };

// ---------------- Remote lookups ----------------
const wikiCache = new Map();
async function wikiSummary(title) {
  if (wikiCache.has(title)) return wikiCache.get(title);
  const p = fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && j.type === 'standard' && j.extract ? j : null))
    .catch(() => null);
  wikiCache.set(title, p);
  return p;
}
async function wikiFirst(titles, accept = () => true) {
  for (const t of titles) {
    const j = await wikiSummary(t);
    if (j && accept(j)) return j;
  }
  return null;
}
function wikiTitlesFor(o) {
  if (o.kind === 'planet') return [[PLANET_WIKI[o.name] || o.name], () => true];
  if (o.kind === 'asteroid') return [[PLANET_WIKI[o.name] || `${o.el.id} ${o.name}`], () => true];
  if (o.kind === 'star') return o.proper ? [[`${o.name} (star)`, o.name], (j) => /\bstar\b|binary|system/i.test(j.extract)] : [[], () => false];
  if (o.kind === 'satellite') {
    if (SAT_WIKI[o.norad]) return [[SAT_WIKI[o.norad]], () => true];
    const n = o.name.toUpperCase();
    if (n.startsWith('STARLINK')) return [['Starlink'], () => true];
    if (n.startsWith('ONEWEB')) return [['OneWeb'], () => true];
    if (n.startsWith('IRIDIUM')) return [['Iridium satellite constellation'], () => true];
    if (n.startsWith('GPS ') || n.startsWith('NAVSTAR')) return [['Global Positioning System'], () => true];
    if (n.startsWith('GLONASS') || n.startsWith('COSMOS') && o.group === 'gnss') return [['GLONASS'], () => true];
    if (n.startsWith('GSAT0') || n.startsWith('GALILEO')) return [['Galileo (satellite navigation)'], () => true];
    if (n.startsWith('BEIDOU')) return [['BeiDou'], () => true];
    if (n.startsWith('CSS') || n.startsWith('TIANHE') || n.startsWith('WENTIAN') || n.startsWith('MENGTIAN')) return [['Tiangong space station'], () => true];
    if (/R\/B|DEB/.test(n)) return [[], () => false];
    const clean = o.name.replace(/\(.*?\)/g, '').trim();
    const t = clean.charAt(0) + clean.slice(1).toLowerCase();
    return [[`${clean} (satellite)`, `${t} (satellite)`, clean, t], (j) => /satellite|spacecraft|telescope|space station|observatory|mission/i.test(j.extract)];
  }
  return [[], () => false];
}

const satcatCache = new Map();
function satcat(norad) {
  if (!satcatCache.has(norad)) {
    satcatCache.set(norad, fetch(`api/satcat?id=${norad}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((v) => { if (!v) satcatCache.delete(norad); return v; })); // don't remember failures
  }
  return satcatCache.get(norad);
}

// ---------------- Star helpers ----------------
function starTempK(bv) {
  return Math.round(4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)) / 50) * 50;
}
function spectralWords(sp) {
  if (!sp) return null;
  const s = sp.trim();
  if (/^D/.test(s)) return 'White dwarf';
  const color = { O: 'Blue', B: 'Blue-white', A: 'White', F: 'Yellow-white', G: 'Yellow', K: 'Orange', M: 'Red', C: 'Red carbon', S: 'Red', W: 'Wolf-Rayet' }[s[0]];
  const m = s.match(/(III|IV|II|Ia|Ib|I|V)/);
  const lum = { III: 'giant', IV: 'subgiant', II: 'bright giant', Ia: 'supergiant', Ib: 'supergiant', I: 'supergiant', V: 'main-sequence star' }[m?.[1]] || 'star';
  return color ? `${color} ${lum}` : null;
}

// ---------------- Calendar (.ics) ----------------
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (t) => String(t).replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
function passIcs(sat, p, name, obs, url) {
  const dir = deps.cardinal;
  const desc = `Rises in the ${dir(p.startAz)}, highest ${p.maxEl.toFixed(0)}° in the ${dir(p.peakAz)} at ${p.peakT.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, sets in the ${dir(p.endAz)}. `
    + (p.visible ? 'Sunlit against a dark sky: look for a steady moving point of light.' : 'Not visible to the eye on this pass (Earth’s shadow or daylight).')
    + ` Track it live: ${url}`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SkyTracker AR//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${sat.norad}-${icsDate(p.start)}@skytracker`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(p.start)}`, `DTEND:${icsDate(p.end)}`,
    `SUMMARY:${icsText(`${name} pass · max ${p.maxEl.toFixed(0)}°${p.visible ? ' (visible)' : ''}`)}`,
    `DESCRIPTION:${icsText(desc)}`, `GEO:${obs.latitude.toFixed(4)};${obs.longitude.toFixed(4)}`, `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`${name} rises in 10 minutes`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
// Android: Google Calendar's add-event screen (opens the Calendar app when installed).
function openGoogleCalendar(sat, p, name, url) {
  const dir = deps.cardinal;
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${name} pass · max ${p.maxEl.toFixed(0)}°${p.visible ? ' (visible)' : ''}`,
    dates: `${icsDate(p.start)}/${icsDate(p.end)}`,
    details: `Rises in the ${dir(p.startAz)}, highest ${p.maxEl.toFixed(0)}° in the ${dir(p.peakAz)} at ${p.peakT.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, sets in the ${dir(p.endAz)}. ${p.visible ? 'Sunlit against a dark sky: look for a steady moving point of light.' : 'Not visible to the eye on this pass.'}\nTrack it live: ${url}`,
  });
  window.open(`https://calendar.google.com/calendar/render?${q}`, '_blank', 'noopener');
}

function openIcs(ics, filename) {
  const a = document.createElement('a');
  if (deps.isIOS) {
    // Safari opens text/calendar data in the native "Add to Calendar" sheet.
    a.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  } else {
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = filename;
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------- Rendering ----------------
let deps;
let current = null;
let token = 0;
// Live-panel state for the open object
let live = { info: null, passes: null, passesAt: 0, prev: null, rr: null, angSpeed: null, lastTick: 0 };

export function initDetails(d) {
  deps = d;
  $('dClose').onclick = closeDetails;
  $('dGuide').onclick = () => { const o = current; closeDetails(); deps.onGuide?.(o); };
  $('dShare').onclick = () => current && deps.onShare?.(current);
}

export function isOpen() { return !$('details').classList.contains('hidden'); }
export function currentObject() { return isOpen() ? current : null; }
export function closeDetails() { $('details').classList.add('hidden'); current = null; }

function grid(rows) {
  const r = rows.filter((x) => x && x[1] != null && x[1] !== '' && x[1] !== '—');
  if (!r.length) return '';
  return `<div class="d-grid">${r.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>`;
}
function section(title, html, id = '') {
  return `<section class="d-sec"${id ? ` id="${id}"` : ''}><h3>${esc(title)}</h3>${html}</section>`;
}
const t2 = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const t3 = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const dt = (d) => (d ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dayDt = (d) => (d ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function openDetails(o) {
  if (!o) return;
  current = o;
  const my = ++token;
  live = { info: null, passes: null, passesAt: 0, prev: null, rr: null, angSpeed: null, lastTick: 0 };
  const { sky, displayName, colorOf, cardinal } = deps;
  const col = colorOf(o);
  $('dIcon').style.background = col;
  $('dIcon').style.boxShadow = `0 0 14px ${col}`;
  $('dName').textContent = displayName(o);
  $('dType').innerHTML = esc(o.type + (o.kind === 'satellite' ? ` · NORAD ${o.norad}` : o.kind === 'star' && o.con ? ` in ${deps.consName(o.con)}` : ''))
    + (o.kind === 'satellite' ? '<span class="live">LIVE</span>' : '');
  $('dGuide').textContent = o.alt > 0 ? 'Guide me to it' : 'Show direction';
  const now = new Date();
  let html = '<div id="dLive"></div>';

  if (o.kind === 'planet') {
    const f = PLANET_FACTS[o.name] || {};
    const info = sky.bodyInfo(o, now);
    live.info = info;
    html += section('Tonight', grid([
      ['Rises', t2(info.rise)], ['Highest', info.transit ? `${t2(info.transit)} · ${info.transitAlt.toFixed(0)}° up` : null], ['Sets', t2(info.set)],
      ['In constellation', esc(info.constellation)], ['Apparent size', info.angularDiam ? (info.angularDiam > 120 ? `${(info.angularDiam / 60).toFixed(1)}′` : `${info.angularDiam.toFixed(1)}″`) : null],
      ['From the Sun', info.elongation != null ? `${info.elongation.toFixed(1)}° (${info.visibility} sky)` : null],
      o.phase != null && o.name !== 'Sun' ? ['Illuminated', `${Math.round(o.phase * 100)}%`] : null,
      info.phaseName ? ['Phase', `${info.phaseName} · day ${info.ageDays.toFixed(1)}`] : null,
    ]));
    if (info.quarters) html += section('Next phases', grid(info.quarters.map((q) => [q.name, dayDt(q.date) + ' ' + t2(q.date)])));
    if (info.civilDusk) html += section('Twilight', grid([['Civil dusk', t2(info.civilDusk)], ['Dark sky from', t2(info.astroDusk)], ['Dark sky until', t2(info.astroDawn)], ['Civil dawn', t2(info.civilDawn)]]));
    const { what, ...rest } = f;
    html += section('Facts', `${what ? `<p class="d-lead">${esc(what)}</p>` : ''}${grid(Object.entries(rest))}`);
  } else if (o.kind === 'asteroid') {
    const f = ASTEROID_FACTS[o.name] || {};
    const el = o.el;
    html += section('Facts', `${f.note ? `<p class="d-lead">${esc(f.note)}</p>` : ''}${grid([
      ['Type', esc(o.type)], ['Diameter', f.d], ['Brightness now', `mag ${o.mag.toFixed(1)}`],
      ['Seen with', o.mag < 6.5 ? 'Naked eye (dark sky)' : o.mag < 9.5 ? 'Binoculars' : o.mag < 13 ? 'Small telescope' : 'Large telescope'],
      ['Absolute mag (H)', el.H.toFixed(1)],
    ])}`);
    html += section('Orbit around the Sun', grid([
      ['Semi-major axis', `${el.a.toFixed(3)} AU`], ['Year length', `${(el.a ** 1.5).toFixed(2)} years`],
      ['Eccentricity', el.e.toFixed(3)], ['Inclination', `${el.i.toFixed(2)}°`],
      ['Closest to Sun', `${(el.a * (1 - el.e)).toFixed(2)} AU`], ['Farthest', `${(el.a * (1 + el.e)).toFixed(2)} AU`],
    ]) + '<p class="d-src">Orbital elements: NASA/JPL Horizons, osculating today.</p>');
  } else if (o.kind === 'star') {
    const lum = o.absmag != null ? 10 ** ((4.83 - o.absmag) / 2.5) : null;
    const yr = o.ly ? new Date().getFullYear() - Math.round(o.ly) : null;
    html += section('Facts', `${spectralWords(o.spect) ? `<p class="d-lead">${esc(spectralWords(o.spect))}</p>` : ''}${grid([
      ['Distance', o.ly ? `${o.ly < 100 ? o.ly.toFixed(1) : num(o.ly)} light-years` : null],
      ['Light left it', yr != null ? (yr > 0 ? `≈ ${yr} AD` : `≈ ${1 - yr} BC`) : null],
      ['Spectral type', esc(o.spect)], ['Surface temp', `≈ ${num(starTempK(o.bv))} K`],
      ['Brightness vs Sun', lum ? (lum >= 10 ? `${num(lum)} ×` : `${lum.toFixed(2)} ×`) : null],
      ['Apparent mag', o.mag.toFixed(2)], ['Absolute mag', o.absmag != null ? o.absmag.toFixed(2) : null],
      ['Constellation', esc(deps.consName(o.con))],
      ['Catalogue', `HIP ${o.hip}${o.desig ? ` · ${esc(o.desig)} ${esc(o.con)}` : ''}`],
      ['RA / Dec (J2000)', `${o.ra.toFixed(3)}h ${o.dec >= 0 ? '+' : ''}${o.dec.toFixed(2)}°`],
    ])}`);
  } else if (o.kind === 'satellite') {
    const orb = Sky.orbit(o);
    const n = o.name.toUpperCase();
    const lead = n.startsWith('STARLINK') ? 'One of SpaceX’s Starlink internet satellites, in low Earth orbit.'
      : /R\/B/.test(n) ? 'A spent rocket upper stage left in orbit after launching a satellite.'
        : /DEB/.test(n) ? 'A piece of orbital debris.' : '';
    html += section('Next passes over you', '<div id="dPasses" class="d-loading">Calculating…</div>');
    html += section('Orbit', grid([
      ['Height', `${num(orb.perigee)}–${num(orb.apogee)} km`], ['Orbit time', `${orb.period.toFixed(1)} min`],
      ['Orbits per day', orb.revsPerDay.toFixed(2)], ['Inclination', `${orb.inclination.toFixed(2)}°`],
      ['Eccentricity', orb.eccentricity.toFixed(5)], ['Speed', o.speed ? `${o.speed.toFixed(2)} km/s (${num(o.speed * 3600)} km/h)` : null],
    ]) + `<p class="d-src">From the latest TLE (epoch ${dayDt(o.epoch)}, ${((now - o.epoch) / 86400000).toFixed(1)} days old) via CelesTrak.</p>`);
    html += section('Identity', `${lead ? `<p class="d-lead">${esc(lead)}</p>` : ''}<div id="dSatcat">${grid([
      ['NORAD ID', o.norad], ['International ID', orb.intl], ['Launch year', orb.launchYear],
    ])}</div>`);
  }
  html += '<section class="d-sec" id="dWiki"></section>';
  $('dBody').innerHTML = html;
  $('dBody').scrollTop = 0;
  $('details').classList.remove('hidden');
  updateLive();

  // Async parts
  if (o.kind === 'satellite') {
    const renderPasses = () => {
      if (my !== token || !isOpen()) return;
      const ps = sky.passes(o, new Date(), 72, 6);
      live.passes = ps;
      live.passesAt = Date.now();
      $('dPasses').classList.remove('d-loading');
      $('dPasses').innerHTML = ps.length ? `<ul class="passes">${ps.map((p) => `
        <li class="${p.visible ? 'vis' : ''}">
          <div><b>${p.ongoing ? 'Now' : dt(p.start)}</b><span>${Math.round((p.end - p.start) / 60000)} min · ${cardinal(p.startAz)} → ${cardinal(p.endAz)}</span></div>
          <div class="pk"><b>${p.maxEl.toFixed(0)}°</b><span>max, ${cardinal(p.peakAz)} at ${t2(p.peakT)}</span></div>
          <em>${p.visible
            ? `Visible ${t3(p.visFrom)}–${t3(p.visTo)}${p.shadowEnter && p.shadowEnter <= p.visTo ? ' · then enters Earth’s shadow' : ''}${p.shadowExit && p.shadowExit >= p.visFrom ? ' · comes out of shadow first' : ''}`
            : !p.sunlitAny ? 'In Earth’s shadow the whole pass' : 'Daylight (sky too bright)'}</em>
          ${p.ongoing ? '' : `<button class="cal" data-k="${ps.indexOf(p)}">Add to Calendar</button>`}
        </li>`).join('')}</ul><p class="d-src">Passes above 10°. “Visible” = in sunlight while your sky is dark (Sun below −6°). On the sky, the path is solid in sunlight and dotted in Earth’s shadow.</p>`
        : '<p class="muted">No passes above 10° in the next 3 days from your location.</p>';
      $('dPasses').onclick = (e) => {
        const b = e.target.closest('button.cal');
        if (!b) return;
        const p = ps[+b.dataset.k];
        const name = deps.displayName(o);
        if (deps.isAndroid) openGoogleCalendar(o, p, name, deps.linkFor(o));
        else openIcs(passIcs(o, p, name, sky.observer, deps.linkFor(o)), `${name.replace(/[^\w]+/g, '-')}-pass.ics`);
      };
    };
    live.renderPasses = renderPasses;
    setTimeout(renderPasses, 30);
    satcat(o.norad).then((c) => {
      if (my !== token || !c) return;
      const rcs = c.RCS ? (c.RCS < 0.1 ? 'Small (< 0.1 m²)' : c.RCS < 1 ? 'Medium (0.1–1 m²)' : `Large (${c.RCS.toFixed(1)} m² radar size)`) : null;
      $('dSatcat').innerHTML = grid([
        ['NORAD ID', c.NORAD_CAT_ID], ['International ID', esc(c.OBJECT_ID)], ['Catalogue name', esc(c.OBJECT_NAME)],
        ['Object type', esc(OBJ_TYPE[c.OBJECT_TYPE] || c.OBJECT_TYPE)], ['Status', esc(OPS[c.OPS_STATUS_CODE] || '')],
        ['Owner', esc(OWNERS[c.OWNER] || c.OWNER)], ['Launched', c.LAUNCH_DATE ? dayDt(new Date(c.LAUNCH_DATE)) : null],
        ['Launch site', esc(SITES[c.LAUNCH_SITE] || c.LAUNCH_SITE)], ['Size', rcs],
        ['Years in orbit', c.LAUNCH_DATE ? ((Date.now() - new Date(c.LAUNCH_DATE)) / 3.15576e10).toFixed(1) : null],
      ]) + '<p class="d-src">Satellite catalogue: CelesTrak SATCAT.</p>';
    });
  }
  const [titles, accept] = wikiTitlesFor(o);
  if (titles.length) {
    $('dWiki').innerHTML = '<h3>About</h3><div class="d-loading">Loading from Wikipedia…</div>';
    wikiFirst(titles, accept).then((j) => {
      if (my !== token) return;
      if (!j) { $('dWiki').innerHTML = ''; return; }
      const img = j.thumbnail?.source;
      $('dWiki').innerHTML = `<h3>About</h3><div class="wiki">${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : ''}
        <p>${esc(j.extract)}</p></div>
        <a class="wiki-link" href="${esc(j.content_urls?.mobile?.page || j.content_urls?.desktop?.page)}" target="_blank" rel="noopener">Read more on Wikipedia →</a>`;
    });
  }
}

// ---------------- Live panel ----------------
const AU_KM = 149597870.7;
function countdown(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s` : `${m}m ${String(sec).padStart(2, '0')}s`;
}
const fix = (x, d) => Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// Called every animation frame by the main loop; redraws ~10×/s (satellites) or 4×/s (others).
export function liveTick(date) {
  const o = current;
  if (!o || !isOpen()) return;
  const nowMs = date.getTime();
  const sat = o.kind === 'satellite';
  if (nowMs - live.lastTick < (sat ? 100 : 250)) return;
  live.lastTick = nowMs;
  deps.sky.updateOne(o, date);

  // Rates from successive samples: range rate (non-satellites) and motion across the sky.
  const distKm = sat ? o.range : o.kind === 'star' ? null : o.dist * AU_KM;
  if (live.prev) {
    const dt = (nowMs - live.prev.t) / 1000;
    if (dt > 0.05) {
      const p = live.prev.e, e = o.e;
      const ang = Math.acos(Math.max(-1, Math.min(1, p[0] * e[0] + p[1] * e[1] + p[2] * e[2]))) * 180 / Math.PI;
      live.angSpeed = live.angSpeed == null ? ang / dt : live.angSpeed + (ang / dt - live.angSpeed) * 0.3;
      if (distKm != null && live.prev.d != null && !sat) {
        const rr = (distKm - live.prev.d) / dt;
        live.rr = live.rr == null ? rr : live.rr + (rr - live.rr) * 0.3;
      }
    }
  }
  live.prev = { t: nowMs, e: o.e, d: distKm };
  if (sat && live.passesAt && nowMs - live.passesAt > 60000) live.renderPasses?.();

  const { lightTime, cardinal } = deps;
  const rows = [
    ['Direction', `${fix(o.az, 3)}° ${cardinal(o.az)}`],
    ['Altitude', `<span class="${o.alt > 0 ? 'up' : 'down'}">${fix(o.alt, 3)}°${o.alt > 0 ? '' : ' (below horizon)'}</span>`],
  ];
  if (sat) rows.push(['Distance from you', `${fix(o.range, 1)} km`]);
  else if (o.kind === 'star') rows.push(['Distance from you', deps.fmtDist(o)]);
  else rows.push(['Distance from you', `${fix(distKm, 0)} km`], ['In AU', fix(o.dist, 6)]);

  const rr = sat ? o.rangeRate : live.rr;
  if (rr != null) rows.push([rr < 0 ? 'Approaching at' : 'Moving away at', `<span class="${rr < 0 ? 'up' : 'down'}">${fix(Math.abs(rr), 3)} km/s</span>`]);
  if (live.angSpeed != null) {
    rows.push(['Moving across sky', live.angSpeed >= 0.05 ? `${fix(live.angSpeed, 3)}°/s` : `${fix(live.angSpeed * 60, 3)}°/min`]);
  }
  if (sat) {
    rows.push(
      ['Height', `${fix(o.height, 2)} km`],
      ['Speed', `${fix(o.speed, 3)} km/s · ${num(o.speed * 3600)} km/h`],
      ['Over', `${fix(Math.abs(o.lat), 3)}°${o.lat >= 0 ? 'N' : 'S'}, ${fix(Math.abs(o.lon), 3)}°${o.lon >= 0 ? 'E' : 'W'}`],
      ['Lighting', o.sunlit ? 'Sunlit' : 'Earth’s shadow'],
      ['Light time', lightTime(o)],
    );
    const ps = live.passes;
    const next = ps?.find((p) => p.end > date);
    if (next) {
      rows.push(next.start <= date
        ? ['Pass', `<span class="up">Overhead now · ends in ${countdown(next.end - date)}</span>`]
        : ['Next pass in', `${countdown(next.start - date)}${next.visible ? ' · visible' : ''}`]);
    }
  } else {
    if (o.kind !== 'star') rows.push(['Light time', lightTime(o)]);
    if (o.mag != null && Number.isFinite(o.mag)) rows.push(['Magnitude', fix(o.mag, 2)]);
    const inf = live.info;
    if (inf) {
      const future = (d) => d && d > date;
      if (o.alt > 0 && future(inf.set)) rows.push(['Sets in', countdown(inf.set - date)]);
      if (o.alt <= 0 && future(inf.rise)) rows.push(['Rises in', countdown(inf.rise - date)]);
      if (future(inf.transit)) rows.push(['Highest in', countdown(inf.transit - date)]);
    }
  }
  const stamp = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + `.${Math.floor((nowMs % 1000) / 100)}`;
  $('dLive').innerHTML = `<div class="d-live-h"><span class="pulse"></span>Live · ${sat ? '10' : '4'}× per second<span class="d-stamp">${stamp}</span></div>${grid(rows)}`;
}
export function updateLive() { if (current) { live.lastTick = 0; liveTick(new Date()); } }
