/* Political Atlas (PRP · Realtime Intelligence): map, table and country profile panel. Data lives in data/*.json and
   is refreshed monthly by scripts/update-data.mjs. Map colours are CSS custom properties over PRP tokens (styles.css),
   written into SVG fills as var(...), so the map follows the light/dark theme without redrawing. */

const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const DAY = 86400000;

// Countries too small to click at world scale get a marker dot (lon, lat). A dot is drawn only once the country has a
// record, so the list can name countries still to be added. Tuvalu has no shape at all in the 50m boundaries, so its
// dot is the only way to reach it; Kiribati's dot is on Tarawa, its capital, not on Kiritimati, its largest island.
const MARKERS = {
  VAT: [12.45, 41.9], MCO: [7.42, 43.74], SMR: [12.46, 43.94], LIE: [9.55, 47.16],
  AND: [1.52, 42.51], MLT: [14.44, 35.9], LUX: [6.13, 49.61], XKX: [20.9, 42.6],
  ATG: [-61.8, 17.08], KNA: [-62.75, 17.33], DMA: [-61.37, 15.42], LCA: [-60.98, 13.9],
  VCT: [-61.2, 13.25], GRD: [-61.68, 12.12], BRB: [-59.55, 13.17], TTO: [-61.25, 10.6],
  // Africa
  CPV: [-23.6, 15.1], GMB: [-15.4, 13.45], STP: [6.61, 0.25], COM: [43.33, -11.7], MUS: [57.56, -20.25], SYC: [55.46, -4.67],
  // Middle East and Asia
  BHR: [50.54, 26.03], PSE: [35.22, 31.94], LBN: [35.85, 33.88], SGP: [103.82, 1.35], BRN: [114.6, 4.5], MDV: [73.5, 4.2],
  // Oceania
  TUV: [179.2, -8.5], NRU: [166.93, -0.52], KIR: [173, 1.4], MHL: [171.2, 7.1], FSM: [158.2, 6.9], PLW: [134.58, 7.5],
  TON: [-175.2, -21.17], WSM: [-172.1, -13.75]
};

// On the map, systems fold into three families (three categorical colours is the most a map can carry and stay
// colour-blind safe) plus "Other"; the tooltip, profile and table name each country's exact system.
const FAMILIES = {
  parl: { label: 'Parliamentary', note: 'republic or constitutional monarchy', color: 'var(--c-parl)' },
  pres: { label: 'Presidential or semi-presidential', note: '', color: 'var(--c-pres)' },
  auto: { label: 'One-party or monarch’s rule', note: 'also theocratic and military rule', color: 'var(--c-auto)' },
  other: { label: 'Other', note: 'directorial, transitional, territory', color: 'var(--c-other)' }
};
const SYSTEM_TYPES = {
  'presidential': { label: 'Presidential republic', family: 'pres' },
  'semi-presidential': { label: 'Semi-presidential', family: 'pres' },
  'parliamentary-republic': { label: 'Parliamentary republic', family: 'parl' },
  'parliamentary-monarchy': { label: 'Constitutional monarchy', family: 'parl' },
  // "Ruling monarchy" (Jude, 13 November 2026; "Absolute monarchy" before): a monarch who rules as well as reigns,
  // with or without a constitution and an elected chamber. "Absolute" fitted Saudi Arabia and Oman but not Jordan,
  // Kuwait, Bahrain or Morocco, which have both. The type keeps its id in the data.
  'absolute-monarchy': { label: 'Ruling monarchy', family: 'auto' },
  'one-party': { label: 'One-party state', family: 'auto' },
  'directorial': { label: 'Directorial', family: 'other' },
  // The Holy See (an elective monarchy) and Iran (a republic under a supreme leader) are both theocracies.
  'theocratic': { label: 'Theocracy', family: 'auto' },
  'military': { label: 'Military government', family: 'auto' },
  'transitional': { label: 'Transitional', family: 'other' },
  'dependent-territory': { label: 'Autonomous territory', family: 'other' }
};
const systemOf = c => SYSTEM_TYPES[c.systemType] || { label: c.system, family: 'other' };
const familyColor = c => FAMILIES[systemOf(c).family].color;

const ELECTION_BUCKETS = [
  { max: 90, label: 'Within 3 months', color: 'var(--e-1)' },
  { max: 180, label: '3–6 months', color: 'var(--e-2)' },
  { max: 365, label: '6–12 months', color: 'var(--e-3)' },
  { max: 730, label: '1–2 years', color: 'var(--e-4)' },
  { max: Infinity, label: 'Later / none scheduled', color: 'var(--e-5)' }
];

const STATUS = {
  'stable': { label: 'Stable government', note: '', color: 'var(--c-stable)' },
  'in-flux': { label: 'In flux', note: 'formation, caretaker or election under way', color: 'var(--c-flux)' }
};

const CAPTIONS = {
  system: 'Countries coloured by system of government. Parliamentary systems include constitutional monarchies; the tooltip, profile and table give each country’s exact system. Dots mark states too small to click at this scale.',
  election: 'Countries coloured by the time to their next scheduled national election, counted from today: the stronger the colour, the sooner the vote.',
  status: 'Countries coloured by government stability. “In flux” means a government is being formed, is a caretaker, or an election or count is under way.'
};

const state = { countries: new Map(), byNumeric: new Map(), byName: new Map(), mode: 'system', selected: null, manifest: null, view: 'map', sort: { key: 'name', dir: 1 }, region: '' };

// The region filter groups "Europe (transcontinental)" (Russia, Turkey, the South Caucasus) with Europe.
const regionOf = c => c.region.replace(/\s*\(.*\)$/, '');
const inRegion = c => !state.region || regionOf(c) === state.region;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseDate(str) {
  if (!str || !/^\d{4}/.test(str)) return null;
  const [y, m, d] = str.split('-');
  // Year-only and month-only dates are approximate; use mid-period.
  return new Date(Date.UTC(+y, m ? +m - 1 : 6, d ? +d : (m ? 15 : 1)));
}

function formatDate(str) {
  const dt = parseDate(str);
  if (!dt) return str || 'TBD';
  const parts = str.split('-').length;
  const opts = parts === 3 ? { day: 'numeric', month: 'short', year: 'numeric' }
    : parts === 2 ? { month: 'short', year: 'numeric' } : { year: 'numeric' };
  return dt.toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

function nextElection(c) {
  const now = Date.now();
  return c.elections
    .filter(e => e.status === 'upcoming')
    .map(e => ({ ...e, dt: parseDate(e.date) }))
    .filter(e => e.dt && e.dt.getTime() >= now - DAY)
    .sort((a, b) => a.dt - b.dt)[0] || null;
}

function daysUntil(dt) { return Math.ceil((dt.getTime() - Date.now()) / DAY); }
const countdown = days => (days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`);
// Year-only dates are mid-year placeholders, so the table and tooltip count down only to dates with a month.
const soonLabel = (e, days) => (e.date.split('-').length > 1 && days >= 0 && days < 730 ? countdown(days) : '');

function fillFor(c) {
  if (state.mode === 'system') return familyColor(c);
  if (state.mode === 'status') return STATUS[c.status]?.color;
  const ne = nextElection(c);
  const days = ne ? daysUntil(ne.dt) : Infinity;
  return ELECTION_BUCKETS.find(b => days <= b.max).color;
}

// The person who holds the most power in practice, whom the tooltip names: the head of government in parliamentary
// systems, the head of state where the president, monarch or party leader directs the government (France's president,
// not its prime minister), or a regent who exercises the head of state's powers for him (Liechtenstein's Hereditary
// Prince Alois). Each record says which it is, in executive.leader.
const leaderOf = c => c.executive[c.executive.leader] || c.executive.headOfGovernment;

// What the current colour means for one country, in words (tooltip line).
function modeDetail(c) {
  if (state.mode === 'system') return systemOf(c).label;
  if (state.mode === 'status') return STATUS[c.status]?.label || c.status;
  const ne = nextElection(c);
  if (!ne) return 'No national election scheduled';
  const soon = soonLabel(ne, daysUntil(ne.dt));
  return `Next election ${formatDate(ne.date)}${soon ? `, ${soon}` : ''}`;
}

async function loadData() {
  const manifest = await fetch('data/manifest.json', { cache: 'no-cache' }).then(r => r.json());
  state.manifest = manifest;
  const lists = await Promise.all(manifest.files.map(f => fetch(`data/${f}`, { cache: 'no-cache' }).then(r => r.json())));
  for (const c of lists.flat()) {
    state.countries.set(c.iso3, c);
    if (c.numeric) state.byNumeric.set(c.numeric, c);
    state.byName.set(c.name.toLowerCase(), c);
  }
  // Natural Earth names that differ from ours
  state.byName.set('kosovo', state.countries.get('XKX'));
  state.byName.set('n. cyprus', state.countries.get('CYP'));
  document.getElementById('updated').innerHTML =
    `<span>Updated <b>${esc(formatDate(manifest.lastUpdated))}</b></span><span>Coverage <b>${state.countries.size} countries and territories</b></span>` +
    '<span>Refresh <b>monthly, reviewed</b></span><span>Boundaries <b>Natural Earth</b></span>';
}

function countryForFeature(f) {
  return state.byNumeric.get(f.id) || state.byName.get((f.properties?.name || '').toLowerCase()) || null;
}

let svg, g, path, projection, zoom;

async function drawMap() {
  const world = await fetch(WORLD_URL).then(r => r.json());
  const features = topojson.feature(world, world.objects.countries).features
    .filter(f => f.properties.name !== 'Antarctica')
    // Covered countries last, so their outlines sit on top of their neighbours'.
    .sort((a, b) => !!countryForFeature(a) - !!countryForFeature(b));

  // Fixed internal coordinate space; the SVG scales to its container via viewBox,
  // so layout changes (resizes, panes opening) never invalidate projection maths.
  const width = 1000, height = 600;
  svg = d3.select('#map');
  projection = d3.geoNaturalEarth1().fitExtent([[10, 10], [width - 10, height - 10]], { type: 'FeatureCollection', features });
  path = d3.geoPath(projection);
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet');

  g = svg.append('g');
  const tooltip = document.getElementById('tooltip');

  g.selectAll('path.country')
    .data(features)
    .join('path')
    .attr('d', path)
    .attr('class', f => `country ${countryForFeature(f) ? 'active' : 'inactive'}`)
    .attr('data-iso', f => countryForFeature(f)?.iso3 || null)
    .on('mousemove', (ev, f) => showTip(ev, countryForFeature(f), f.properties.name))
    .on('mouseleave', () => { tooltip.hidden = true; })
    .on('click', (ev, f) => { const c = countryForFeature(f); if (c) select(c.iso3, true); });

  const markerData = Object.entries(MARKERS).filter(([iso]) => state.countries.has(iso));
  g.selectAll('circle.microstate')
    .data(markerData)
    .join('circle')
    .attr('class', 'microstate')
    .attr('data-iso', d => d[0])
    .attr('cx', d => projection(d[1])[0])
    .attr('cy', d => projection(d[1])[1])
    .attr('r', 3)
    .on('mousemove', (ev, d) => showTip(ev, state.countries.get(d[0])))
    .on('mouseleave', () => { tooltip.hidden = true; })
    .on('click', (ev, d) => select(d[0], true));

  // Linear interpolation avoids d3's default fly-out/fly-in on long programmatic pans.
  zoom = d3.zoom().scaleExtent([1, 40]).interpolate(d3.interpolate).on('zoom', ev => {
    g.attr('transform', ev.transform);
    // Keep microstate markers a constant ~4px on screen at every zoom level. Until the map is zoomed in they are marked
    // "far": on a phone the browser snaps a tap on a small country (Germany) to a nearby dot (Luxembourg), so styles.css
    // lets taps pass through far dots on narrow screens.
    g.selectAll('circle.microstate').attr('r', 4 / Math.max(1, ev.transform.k)).classed('far', ev.transform.k < 2);
  });
  svg.call(zoom);

  document.getElementById('zoom-in').onclick = () => svg.transition().call(zoom.scaleBy, 1.6);
  document.getElementById('zoom-out').onclick = () => svg.transition().call(zoom.scaleBy, 1 / 1.6);
  document.getElementById('zoom-reset').onclick = () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);

  // Open on the whole world, or on the region the address names (?region=Africa).
  svg.call(zoom.transform, d3.zoomIdentity);
  markRegion();
  if (state.region) focusRegion(0);
  recolor();
}

// A box in degrees ([[west, south], [east, north]]) as a box in the map's own (projected) coordinates. The box is first
// kept inside the map (±180°, ±85°): a padded box round a country near the 180° line (Fiji, Tonga, the United States'
// west) would otherwise wrap to the far side of the map and the view would land somewhere else. Its edges are then
// projected point by point, because Natural Earth's meridians curve, so two corners alone do not bound it.
function projectBounds([[x0, y0], [x1, y1]]) {
  const lon = x => Math.max(-180, Math.min(180, x)), lat = y => Math.max(-85, Math.min(85, y));
  [x0, x1, y0, y1] = [lon(x0), lon(x1), lat(y0), lat(y1)];
  const edge = [];
  for (let i = 0; i <= 8; i++) {
    const x = x0 + ((x1 - x0) * i) / 8, y = y0 + ((y1 - y0) * i) / 8;
    edge.push([x, y0], [x, y1], [x0, y], [x1, y]);
  }
  const p = edge.map(projection);
  return [[d3.min(p, q => q[0]), d3.min(p, q => q[1])], [d3.max(p, q => q[0]), d3.max(p, q => q[1])]];
}
function focusBounds(bounds, duration = 750) { focusBox(projectBounds(bounds), duration); }

// The transform that makes a box in the map's own (projected) coordinates fill 90% of the view.
function boxTransform([[px0, py0], [px1, py1]]) {
  const { width, height } = svg.node().viewBox.baseVal;
  const k = Math.max(1, Math.min(40, 0.9 / Math.max((px1 - px0) / width, (py1 - py0) / height)));
  return d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-(px0 + px1) / 2, -(py0 + py1) / 2);
}

// Zoom so a box in the map's own (projected) coordinates fills 90% of the view.
function focusBox(box, duration = 750) {
  const t = boxTransform(box);
  if (duration) svg.transition().duration(duration).call(zoom.transform, t);
  else svg.call(zoom.transform, t);
}

// A country's largest polygon, so overseas territories don't stretch a zoom to the whole globe.
function mainPolygon(f) {
  return f.geometry.type === 'MultiPolygon'
    ? { type: 'Polygon', coordinates: f.geometry.coordinates.reduce((a, b) => (d3.geoArea({ type: 'Polygon', coordinates: b }) > d3.geoArea({ type: 'Polygon', coordinates: a }) ? b : a)) }
    : f.geometry;
}

/* ---------------------------------------------------------------- region filter */
// The list is built from the records, so a region appears as soon as its first country has a record.
function setupRegions() {
  const select = document.getElementById('region');
  const counts = new Map();
  for (const c of state.countries.values()) counts.set(regionOf(c), (counts.get(regionOf(c)) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">All regions (${state.countries.size})</option>` +
    names.map(n => `<option value="${esc(n)}">${esc(n)} (${counts.get(n)})</option>`).join('');
  const asked = new URLSearchParams(location.search).get('region');
  state.region = names.find(n => n.toLowerCase() === (asked || '').toLowerCase()) || '';
  select.value = state.region;
  select.onchange = () => {
    state.region = select.value;
    const params = new URLSearchParams(location.search);
    if (state.region) params.set('region', state.region); else params.delete('region');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    markRegion();
    if (state.view === 'table') { renderTable(); markTableRow(); }
    if (!state.selected) renderUpcoming();
    if (state.region) focusRegion();
    else svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);
  };
}

function markRegion() {
  if (!g) return;
  g.selectAll('path.country.active').classed('out-region', f => !inRegion(countryForFeature(f)));
  g.selectAll('circle.microstate').classed('out-region', d => !inRegion(state.countries.get(d[0])));
}

// Zoom to the region's countries. Europe's box leaves out the transcontinental states, whose Asian territory (Russia's
// above all) would otherwise stretch it across the continent.
function focusRegion(duration = 750) {
  const members = [...state.countries.values()].filter(inRegion);
  const core = members.filter(c => c.region === state.region);
  let boxes = [];
  for (const c of core.length ? core : members) {
    const node = g.select(`path.country[data-iso="${c.iso3}"]`);
    if (!node.empty()) boxes.push(path.bounds(mainPolygon(node.datum())));
    else if (MARKERS[c.iso3]) { const p = projection(MARKERS[c.iso3]); boxes.push([p, p]); }
  }
  const union = list => list.reduce(([[a, b], [c, d]], [[e, f], [h, i]]) => [[Math.min(a, e), Math.min(b, f)], [Math.max(c, h), Math.max(d, i)]]);
  if (!boxes.length) return;
  // A region that wraps round the edge of the map (Oceania: Tonga and Samoa lie west of the 180° line, Australia east
  // of it) would fill the whole width, so it is shown from the side that holds most of its countries.
  const { width } = svg.node().viewBox.baseVal;
  const [[x0], [x1]] = union(boxes);
  if (x1 - x0 > 0.6 * width) {
    const west = boxes.filter(([[a], [c]]) => (a + c) / 2 < width / 2), east = boxes.filter(b => !west.includes(b));
    boxes = west.length > east.length ? west : east;
  }
  const [[bx0, by0], [bx1, by1]] = union(boxes);
  focusBox([[bx0 - 10, by0 - 10], [bx1 + 10, by1 + 10]], duration);
}

function showTip(ev, c, fallbackName) {
  const tooltip = document.getElementById('tooltip');
  const box = document.querySelector('.map-stage').getBoundingClientRect();
  if (c) {
    const who = leaderOf(c);
    tooltip.innerHTML = `<strong>${esc(c.name)}</strong>${esc(who.name)}<span class="tip-role">${esc(who.title)}${who.party ? ` · ${esc(who.party)}` : ''}</span>` +
      `<span class="tip-sub"><span class="swatch" style="background:${fillFor(c)}"></span>${esc(modeDetail(c))}</span>`;
  } else {
    tooltip.innerHTML = `<strong>${esc(fallbackName)}</strong><span class="tip-sub">Not covered</span>`;
  }
  tooltip.hidden = false;
  const x = Math.min(ev.clientX - box.left + 14, box.width - tooltip.offsetWidth - 8);
  const y = Math.min(ev.clientY - box.top + 14, box.height - tooltip.offsetHeight - 8);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function recolor() {
  g.selectAll('path.country.active').attr('fill', f => fillFor(countryForFeature(f)));
  g.selectAll('circle.microstate').attr('fill', d => fillFor(state.countries.get(d[0])));
  renderLegend();
  document.getElementById('caption').textContent = `${CAPTIONS[state.mode]} Boundaries: Natural Earth.`;
}

function renderLegend() {
  const el = document.getElementById('legend');
  let title, items;
  if (state.mode === 'system') {
    const used = new Set([...state.countries.values()].map(c => systemOf(c).family));
    title = 'System of government';
    items = Object.entries(FAMILIES).filter(([k]) => used.has(k)).map(([, v]) => v);
  } else if (state.mode === 'status') {
    title = 'Government stability';
    items = Object.values(STATUS);
  } else {
    title = 'Next national election';
    items = ELECTION_BUCKETS;
  }
  el.innerHTML = `<h4>${title}</h4><ul>${items.map(i =>
    `<li><span class="swatch" style="background:${i.color}"></span>${esc(i.label)}${i.note ? ` <small>${esc(i.note)}</small>` : ''}</li>`).join('')}
    <li><span class="swatch" style="background:var(--c-none)"></span>Not covered</li></ul>`;
}

function select(iso3, fromMap = false) {
  const c = state.countries.get(iso3);
  if (!c) return;
  state.selected = iso3;
  g.selectAll('.country, .microstate').classed('selected', function () { return this.dataset.iso === iso3; });
  // Draw the selected outline above its neighbours, and keep the microstate dots on top.
  g.selectAll('.country.selected').raise();
  g.selectAll('circle.microstate').raise();
  if (location.hash !== `#${iso3}`) history.replaceState(null, '', `#${iso3}`);
  markTableRow();
  renderCountry(c);
  if (!fromMap) zoomTo(iso3);
}

// The box in degrees that a selection frames: round a country's largest polygon (so overseas territories don't zoom out
// to the whole globe), or round its marker dot.
function shapeBounds(f) {
  let [[x0, y0], [x1, y1]] = d3.geoBounds(mainPolygon(f));
  // A polygon that crosses the 180° line (Russia's mainland reaches Chukotka) comes back with its east edge west of its
  // west edge: keep the side of the line that holds more of it.
  if (x1 < x0) { if (180 - x0 >= x1 + 180) x1 = 180; else x0 = -180; }
  // Room round the country: 1.2 times its width, at least 8° and at most 25° a side, so a large country (the United
  // States, Australia) still fills the view rather than a hemisphere.
  const pad = Math.max(8, Math.min(25, (x1 - x0) * 1.2));
  return [[x0 - pad, y0 - pad / 2], [x1 + pad, y1 + pad / 2]];
}
// projectBounds keeps the box inside ±180°, or a box round Tuvalu (179.2°E) would wrap to the far side of the map.
const markerBounds = ([lon, lat]) => [[lon - 4, lat - 3], [lon + 4, lat + 3]];

function zoomTo(iso3) {
  const node = g.select(`path.country[data-iso="${iso3}"]`);
  if (!node.empty()) return focusBounds(shapeBounds(node.datum()));
  if (MARKERS[iso3]) focusBounds(markerBounds(MARKERS[iso3]));
}

function personCard(role, p, extraClass = '') {
  return `<div class="card ${extraClass}"><div class="role">${esc(role)}</div>
    <div class="who">${esc(p.name)}</div>
    <div class="party">${esc(p.title)}${p.party ? ` · ${esc(p.party)}` : ''}${p.since ? ` · since ${esc(p.since)}` : ''}</div></div>`;
}

function renderCountry(c) {
  const panel = document.getElementById('panel');
  const { headOfState: hos, headOfGovernment: hog, regent, governingParties } = c.executive;
  const sameExec = hos.name === hog.name;
  const elections = [...c.elections].sort((a, b) => (parseDate(a.date) || Infinity) - (parseDate(b.date) || Infinity));

  panel.innerHTML = `
    <div class="c-head">
      <img src="https://flagcdn.com/w80/${esc(c.iso2)}.png" alt="" loading="lazy" onerror="this.remove()">
      <div>
        <h2>${esc(c.name)}</h2>
        <p class="c-system">${esc(c.system)}</p>
        <span class="badge ${esc(c.status)}">${c.status === 'stable' ? 'Stable government' : 'In flux'}</span>
      </div>
      <button class="close" type="button" aria-label="Close" id="close">✕</button>
    </div>

    <h3>Executive</h3>
    <div class="power-grid">
      ${sameExec ? personCard('Head of state & government', hos, 'full')
        : personCard('Head of state', hos) + personCard('Head of government', hog)}
      ${regent ? personCard('Regent (exercises the head of state\'s powers)', regent, 'full') : ''}
      <div class="card full"><div class="role">Governing parties</div>
        <div class="chips">${governingParties.map(p => `<span class="chip">${esc(p)}</span>`).join('')}</div></div>
    </div>

    <h3>Legislature</h3>
    <div class="card">${c.legislature.map(l => `
      <div class="leg-item"><div class="role">${esc(l.name)}</div>
        <div class="control">${esc(l.control)}</div>
        ${l.detail ? `<div class="detail">${esc(l.detail)}</div>` : ''}</div>`).join('')}
    </div>

    <h3>Judiciary</h3>
    <div class="card">${esc(c.judiciary)}</div>

    <h3>Key election dates</h3>
    <ul class="timeline">${elections.map(e => {
      const dt = parseDate(e.date);
      const days = dt ? daysUntil(dt) : null;
      const count = e.status === 'upcoming' && days !== null && days >= 0 && days < 730
        ? `<span class="t-count">${countdown(days)}</span>` : '';
      return `<li class="${e.status === 'upcoming' ? 'upcoming-e' : ''}">
        <span class="t-date">${esc(formatDate(e.date))}</span>${count}
        <div class="t-name">${esc(e.name)}</div>
        ${e.note ? `<div class="t-note">${esc(e.note)}</div>` : ''}</li>`;
    }).join('')}</ul>

    <h3>Synopsis</h3>
    <p class="synopsis">${esc(c.synopsis)}</p>

    <h3>Key policies</h3>
    <ul class="bullets">${c.policies.map(p => `<li>${esc(p)}</li>`).join('')}</ul>

    <h3>Main challenges</h3>
    <ul class="bullets">${c.challenges.map(p => `<li>${esc(p)}</li>`).join('')}</ul>

    ${c.reviewNote ? `<div class="review"><strong>Needs review:</strong> ${esc(c.reviewNote)}</div>` : ''}
    <p class="meta">Last verified ${esc(formatDate(c.lastVerified))}. Information changes quickly; check official sources for critical decisions.</p>`;

  document.getElementById('close').onclick = clearSelection;
  panel.scrollTop = 0;
  if (window.matchMedia('(max-width: 900px)').matches) panel.scrollIntoView({ behavior: 'smooth' });
}

function clearSelection() {
  state.selected = null;
  history.replaceState(null, '', location.pathname + location.search);
  g.selectAll('.selected').classed('selected', false);
  markTableRow();
  renderEmptyPanel();
}

function renderEmptyPanel() {
  const panel = document.getElementById('panel');
  panel.innerHTML = `<div class="panel-empty">
    <h2>Select a country</h2>
    <p>Click a coloured country on the map, a row in the table, or search above to see who holds power across the executive, legislature and judiciary, upcoming elections, and a summary of current policies and challenges.</p>
    <h3>Upcoming elections</h3><ol id="upcoming" class="upcoming"></ol></div>`;
  renderUpcoming();
}

function renderUpcoming() {
  const now = Date.now();
  const rows = [];
  for (const c of state.countries.values()) {
    if (!inRegion(c)) continue;
    for (const e of c.elections) {
      const dt = parseDate(e.date);
      if (e.status === 'upcoming' && dt && dt.getTime() >= now - DAY && dt.getTime() - now < 400 * DAY) rows.push({ c, e, dt });
    }
  }
  rows.sort((a, b) => a.dt - b.dt);
  const ol = document.getElementById('upcoming');
  ol.innerHTML = rows.slice(0, 25).map(({ c, e }) =>
    `<li data-iso="${c.iso3}" tabindex="0"><span class="u-date">${esc(formatDate(e.date))}</span>
      <span><span class="u-name">${esc(c.name)}</span><span class="u-kind">${esc(e.name)}</span></span></li>`).join('');
  ol.querySelectorAll('li').forEach(li => {
    li.onclick = () => select(li.dataset.iso);
    li.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(li.dataset.iso); } };
  });
}

/* ---------------------------------------------------------------- table view */
const COLUMNS = [
  ['name', 'Country', c => c.name],
  ['system', 'System', c => `${Object.keys(FAMILIES).indexOf(systemOf(c).family)} ${systemOf(c).label}`],
  ['hos', 'Head of state', c => c.executive.headOfState.name],
  ['hog', 'Head of government', c => c.executive.headOfGovernment.name],
  ['status', 'Stability', c => (c.status === 'in-flux' ? 0 : 1)],
  ['election', 'Next election', c => nextElection(c)?.dt.getTime() ?? Infinity]
];

function renderTable() {
  const table = document.getElementById('country-table');
  const { key, dir } = state.sort;
  const value = COLUMNS.find(col => col[0] === key)[2];
  const cmp = (x, y) => (typeof x === 'number' ? (x === y ? 0 : x < y ? -1 : 1) : String(x).localeCompare(String(y)));
  const rows = [...state.countries.values()].filter(inRegion).sort((a, b) => cmp(value(a), value(b)) * dir || a.name.localeCompare(b.name));
  table.tHead.innerHTML = `<tr>${COLUMNS.map(([k, label]) => `<th scope="col"${k === key ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>` +
    `<button type="button" class="sort" data-sort="${k}">${label}<span class="arrow" aria-hidden="true">${k === key ? (dir > 0 ? '↑' : '↓') : '↕'}</span></button></th>`).join('')}</tr>`;
  table.tBodies[0].innerHTML = rows.map(c => {
    const { headOfState: hos, headOfGovernment: hog, regent } = c.executive;
    const ne = nextElection(c);
    const soon = ne ? soonLabel(ne, daysUntil(ne.dt)) : '';
    return `<tr data-iso="${c.iso3}"${c.iso3 === state.selected ? ' class="selected"' : ''}>
      <td><span class="cell-name"><img src="https://flagcdn.com/w40/${esc(c.iso2)}.png" alt="" loading="lazy" onerror="this.remove()"><button type="button" class="row-link">${esc(c.name)}</button></span></td>
      <td><span class="cell-sys"><span class="swatch" style="background:${familyColor(c)}"></span>${esc(systemOf(c).label)}</span></td>
      <td>${esc(hos.name)}<span class="cell-sub">${esc(hos.title)}</span>${regent ? `<span class="cell-sub">Regent: ${esc(regent.name)}</span>` : ''}</td>
      <td>${esc(hog.name)}<span class="cell-sub">${esc(hog.party || hog.title)}</span></td>
      <td><span class="prp-status ${c.status === 'stable' ? 'good' : 'warn'}">${c.status === 'stable' ? 'Stable' : 'In flux'}</span></td>
      <td>${ne ? `<span class="cell-date">${esc(formatDate(ne.date))}${soon ? ` · ${soon}` : ''}</span><span class="cell-sub">${esc(ne.name)}</span>`
        : '<span class="cell-sub">None scheduled</span>'}</td></tr>`;
  }).join('');
}

function markTableRow() {
  const wrap = document.querySelector('.table-wrap');
  document.querySelectorAll('#country-table tbody tr').forEach(tr => {
    const on = tr.dataset.iso === state.selected;
    tr.classList.toggle('selected', on);
    // Bring the selected row into view (below the sticky header) if it is scrolled out of sight.
    if (on && state.view === 'table') {
      const r = tr.getBoundingClientRect(), w = wrap.getBoundingClientRect(), head = wrap.querySelector('thead').offsetHeight;
      if (r.top < w.top + head || r.bottom > w.bottom) wrap.scrollTop += r.top - w.top - head - w.height / 3;
    }
  });
}

function setupTable() {
  const table = document.getElementById('country-table');
  table.tHead.onclick = ev => {
    const b = ev.target.closest('[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    renderTable();
    table.querySelector(`[data-sort="${k}"]`).focus();
  };
  table.tBodies[0].onclick = ev => { const tr = ev.target.closest('tr[data-iso]'); if (tr) select(tr.dataset.iso); };
}

/* ---------------------------------------------------------------- views (tabs) */
// Map and Table are tabs; ?view=table links straight to the table and the #ISO3 hash still selects a country.
function setupTabs() {
  const tabs = [...document.querySelectorAll('.prp-tabs [role="tab"]')];
  const show = (view, focus = false) => {
    state.view = view;
    for (const t of tabs) {
      const on = t.dataset.view === view;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
    }
    document.querySelector('.mode').hidden = view !== 'map'; // colouring applies to the map only
    if (view === 'table') { renderTable(); markTableRow(); }
    const params = new URLSearchParams(location.search);
    if (view === 'map') params.delete('view'); else params.set('view', view);
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  };
  tabs.forEach((t, i) => {
    t.onclick = () => show(t.dataset.view);
    t.onkeydown = ev => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
      if (to === undefined) return;
      ev.preventDefault();
      show(tabs[(to + tabs.length) % tabs.length].dataset.view, true);
    };
  });
  show(new URLSearchParams(location.search).get('view') === 'table' ? 'table' : 'map');
}

function setupSearch() {
  const input = document.getElementById('search');
  const list = document.getElementById('search-results');
  let active = 0, results = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    // A country whose name or code matches comes first, then one where the person found is the leader the tooltip names,
    // then one where they hold the other office: "Macron" opens France before Andorra, where he is co-prince.
    const rank = c => (c.name.toLowerCase().includes(q) || c.iso3.toLowerCase() === q ? 0 : leaderOf(c).name.toLowerCase().includes(q) ? 1 : 2);
    results = q ? [...state.countries.values()]
      .filter(c => c.name.toLowerCase().includes(q) || c.iso3.toLowerCase() === q
        || c.executive.headOfGovernment.name.toLowerCase().includes(q) || c.executive.headOfState.name.toLowerCase().includes(q)
        || (c.executive.regent?.name || '').toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 10) : [];
    active = 0;
    list.hidden = !results.length;
    list.innerHTML = results.map((c, i) => `<li role="option" data-iso="${c.iso3}" aria-selected="${i === active}">
      <img src="https://flagcdn.com/w20/${esc(c.iso2)}.png" alt="" width="20" onerror="this.remove()">${esc(c.name)}</li>`).join('');
    list.querySelectorAll('li').forEach(li => li.onmousedown = () => choose(li.dataset.iso));
  };
  const choose = iso => { input.value = ''; list.hidden = true; select(iso); };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', i === active));
    } else if (e.key === 'Enter' && results[active]) choose(results[active].iso3);
    else if (e.key === 'Escape') list.hidden = true;
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
}

function setupModes() {
  document.querySelectorAll('.segmented button').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('.segmented button').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-checked', b === btn);
    });
    state.mode = btn.dataset.mode;
    try { localStorage.setItem('atlas-mode', state.mode); } catch { /* storage unavailable */ }
    recolor();
  });
  let saved = null;
  try { saved = localStorage.getItem('atlas-mode'); } catch { /* storage unavailable */ }
  if (saved) document.querySelector(`.segmented button[data-mode="${saved}"]`)?.click();
}

(async function init() {
  try {
    await loadData();
    setupRegions();
    renderUpcoming();
    setupSearch();
    setupTable();
    setupTabs();
    await drawMap();
    setupModes();
    const iso = location.hash.slice(1).toUpperCase();
    if (state.countries.has(iso)) select(iso);
    // Follow address-bar edits and back/forward navigation between countries.
    window.addEventListener('hashchange', () => {
      const code = location.hash.slice(1).toUpperCase();
      if (state.countries.has(code)) { if (code !== state.selected) select(code); }
      else if (state.selected) clearSelection();
    });
  } catch (err) {
    console.error(err);
    document.getElementById('updated').textContent = 'Failed to load data — serve this folder over HTTP (see README).';
  }
})();
