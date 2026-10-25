/* Political Atlas — map + country detail panel. Data lives in data/*.json and is
   refreshed monthly by scripts/update-data.mjs. */

const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const DAY = 86400000;

// Countries too small to click at world scale get a marker dot (lon, lat).
const MARKERS = {
  VAT: [12.45, 41.9], MCO: [7.42, 43.74], SMR: [12.46, 43.94], LIE: [9.55, 47.16],
  AND: [1.52, 42.51], MLT: [14.44, 35.9], LUX: [6.13, 49.61], XKX: [20.9, 42.6],
  ATG: [-61.8, 17.08], KNA: [-62.75, 17.33], DMA: [-61.37, 15.42], LCA: [-60.98, 13.9],
  VCT: [-61.2, 13.25], GRD: [-61.68, 12.12], BRB: [-59.55, 13.17], TTO: [-61.25, 10.6]
};

const SYSTEM_TYPES = {
  'presidential': { label: 'Presidential republic', color: 'var(--c-presidential)' },
  'semi-presidential': { label: 'Semi-presidential', color: 'var(--c-semi)' },
  'parliamentary-republic': { label: 'Parliamentary republic', color: 'var(--c-parl-rep)' },
  'parliamentary-monarchy': { label: 'Constitutional monarchy', color: 'var(--c-parl-mon)' },
  'absolute-monarchy': { label: 'Absolute monarchy', color: 'var(--c-abs-mon)' },
  'one-party': { label: 'One-party state', color: 'var(--c-one-party)' },
  'directorial': { label: 'Directorial', color: 'var(--c-directorial)' },
  'theocratic': { label: 'Theocratic monarchy', color: 'var(--c-theocratic)' },
  'transitional': { label: 'Transitional', color: 'var(--c-transitional)' },
  'dependent-territory': { label: 'Autonomous territory', color: 'var(--c-territory)' }
};

const ELECTION_BUCKETS = [
  { max: 90, label: 'Within 3 months', color: 'var(--e-1)' },
  { max: 180, label: '3–6 months', color: 'var(--e-2)' },
  { max: 365, label: '6–12 months', color: 'var(--e-3)' },
  { max: 730, label: '1–2 years', color: 'var(--e-4)' },
  { max: Infinity, label: 'Later / none scheduled', color: 'var(--e-5)' }
];

const STATUS = {
  'stable': { label: 'Stable government', color: 'var(--c-parl-rep)' },
  'in-flux': { label: 'In flux (formation, caretaker, election under way)', color: 'var(--e-2)' }
};

const state = { countries: new Map(), byNumeric: new Map(), byName: new Map(), mode: 'system', selected: null, manifest: null };

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

function fillFor(c) {
  if (state.mode === 'system') return SYSTEM_TYPES[c.systemType]?.color || 'var(--c-transitional)';
  if (state.mode === 'status') return STATUS[c.status]?.color;
  const ne = nextElection(c);
  const days = ne ? daysUntil(ne.dt) : Infinity;
  return ELECTION_BUCKETS.find(b => days <= b.max).color;
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
  document.getElementById('updated').textContent =
    `${state.countries.size} countries · data updated ${formatDate(manifest.lastUpdated)}`;
}

function countryForFeature(f) {
  return state.byNumeric.get(f.id) || state.byName.get((f.properties?.name || '').toLowerCase()) || null;
}

let svg, g, path, projection, zoom;

async function drawMap() {
  const world = await fetch(WORLD_URL).then(r => r.json());
  const features = topojson.feature(world, world.objects.countries).features
    .filter(f => f.properties.name !== 'Antarctica');

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
    // Keep microstate markers a constant ~4px on screen at every zoom level.
    g.selectAll('circle.microstate').attr('r', 4 / Math.max(1, ev.transform.k));
  });
  svg.call(zoom);

  document.getElementById('zoom-in').onclick = () => svg.transition().call(zoom.scaleBy, 1.6);
  document.getElementById('zoom-out').onclick = () => svg.transition().call(zoom.scaleBy, 1 / 1.6);
  document.getElementById('zoom-reset').onclick = () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);

  // Open on the northern hemisphere band from North America to Japan.
  focusBounds([[-170, 5], [150, 72]], 0);
  recolor();
}

function focusBounds([[x0, y0], [x1, y1]], duration = 750) {
  const { width, height } = svg.node().viewBox.baseVal;
  const [[px0, py0], [px1, py1]] = [projection([x0, y1]), projection([x1, y0])];
  const k = Math.min(40, 0.9 / Math.max((px1 - px0) / width, (py1 - py0) / height));
  const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-(px0 + px1) / 2, -(py0 + py1) / 2);
  if (duration) svg.transition().duration(duration).call(zoom.transform, t);
  else svg.call(zoom.transform, t);
}

function showTip(ev, c, fallbackName) {
  const tooltip = document.getElementById('tooltip');
  const box = document.querySelector('.map-wrap').getBoundingClientRect();
  if (c) {
    const hog = c.executive.headOfGovernment;
    tooltip.innerHTML = `<strong>${esc(c.name)}</strong>${esc(hog.name)} · ${esc(hog.party || hog.title)}`;
  } else {
    tooltip.innerHTML = `<strong>${esc(fallbackName)}</strong>Not covered`;
  }
  tooltip.hidden = false;
  const x = Math.min(ev.clientX - box.left + 14, box.width - tooltip.offsetWidth - 8);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${ev.clientY - box.top + 14}px`;
}

function recolor() {
  g.selectAll('path.country.active').attr('fill', f => fillFor(countryForFeature(f)));
  g.selectAll('circle.microstate').attr('fill', d => fillFor(state.countries.get(d[0])));
  renderLegend();
}

function renderLegend() {
  const el = document.getElementById('legend');
  let title, items;
  if (state.mode === 'system') {
    const used = new Set([...state.countries.values()].map(c => c.systemType));
    title = 'System of government';
    items = Object.entries(SYSTEM_TYPES).filter(([k]) => used.has(k)).map(([, v]) => v);
  } else if (state.mode === 'status') {
    title = 'Government stability';
    items = Object.values(STATUS);
  } else {
    title = 'Next national election';
    items = ELECTION_BUCKETS;
  }
  el.innerHTML = `<h4>${title}</h4><ul>${items.map(i =>
    `<li><span class="swatch" style="background:${i.color}"></span>${esc(i.label)}</li>`).join('')}
    <li><span class="swatch" style="background:var(--land-inactive)"></span>Not covered</li></ul>`;
}

function select(iso3, fromMap = false) {
  const c = state.countries.get(iso3);
  if (!c) return;
  state.selected = iso3;
  g.selectAll('.country, .microstate').classed('selected', function () { return this.dataset.iso === iso3; });
  if (location.hash !== `#${iso3}`) history.replaceState(null, '', `#${iso3}`);
  renderCountry(c);
  if (!fromMap) zoomTo(iso3);
}

function zoomTo(iso3) {
  const node = g.select(`path.country[data-iso="${iso3}"]`);
  if (!node.empty()) {
    // Use the largest polygon so overseas territories don't zoom out to the whole globe.
    const f = node.datum();
    const geom = f.geometry.type === 'MultiPolygon'
      ? { type: 'Polygon', coordinates: f.geometry.coordinates.reduce((a, b) => (d3.geoArea({ type: 'Polygon', coordinates: b }) > d3.geoArea({ type: 'Polygon', coordinates: a }) ? b : a)) }
      : f.geometry;
    const [[x0, y0], [x1, y1]] = d3.geoBounds(geom);
    const pad = Math.max(8, (x1 - x0) * 1.2);
    return focusBounds([[x0 - pad, y0 - pad / 2], [x1 + pad, y1 + pad / 2]]);
  }
  if (MARKERS[iso3]) {
    const [lon, lat] = MARKERS[iso3];
    focusBounds([[lon - 4, lat - 3], [lon + 4, lat + 3]]);
  }
}

function personCard(role, p, extraClass = '') {
  return `<div class="card ${extraClass}"><div class="role">${esc(role)}</div>
    <div class="who">${esc(p.name)}</div>
    <div class="party">${esc(p.title)}${p.party ? ` · ${esc(p.party)}` : ''}${p.since ? ` · since ${esc(p.since)}` : ''}</div></div>`;
}

function renderCountry(c) {
  const panel = document.getElementById('panel');
  const { headOfState: hos, headOfGovernment: hog, governingParties } = c.executive;
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
        ? `<span class="t-count">${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}</span>` : '';
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
  history.replaceState(null, '', location.pathname);
  g.selectAll('.selected').classed('selected', false);
  renderEmptyPanel();
}

function renderEmptyPanel() {
  const panel = document.getElementById('panel');
  panel.innerHTML = `<div class="panel-empty">
    <h2>Select a country</h2>
    <p>Click a highlighted country on the map, or search above, to see who holds power across the executive, legislature and judiciary, upcoming elections, and a summary of current policies and challenges.</p>
    <h3>Upcoming elections</h3><ol id="upcoming" class="upcoming"></ol></div>`;
  renderUpcoming();
}

function renderUpcoming() {
  const now = Date.now();
  const rows = [];
  for (const c of state.countries.values()) {
    for (const e of c.elections) {
      const dt = parseDate(e.date);
      if (e.status === 'upcoming' && dt && dt.getTime() >= now - DAY && dt.getTime() - now < 400 * DAY) rows.push({ c, e, dt });
    }
  }
  rows.sort((a, b) => a.dt - b.dt);
  const ol = document.getElementById('upcoming');
  ol.innerHTML = rows.slice(0, 25).map(({ c, e }) =>
    `<li data-iso="${c.iso3}"><span class="u-date">${esc(formatDate(e.date))}</span>
      <span><span class="u-name">${esc(c.name)}</span><span class="u-kind">${esc(e.name)}</span></span></li>`).join('');
  ol.querySelectorAll('li').forEach(li => li.onclick = () => select(li.dataset.iso));
}

function setupSearch() {
  const input = document.getElementById('search');
  const list = document.getElementById('search-results');
  let active = 0, results = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    results = q ? [...state.countries.values()]
      .filter(c => c.name.toLowerCase().includes(q) || c.iso3.toLowerCase() === q
        || c.executive.headOfGovernment.name.toLowerCase().includes(q) || c.executive.headOfState.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 10) : [];
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
    renderUpcoming();
    setupSearch();
    await drawMap();
    setupModes();
    const iso = location.hash.slice(1).toUpperCase();
    if (state.countries.has(iso)) select(iso);
  } catch (err) {
    console.error(err);
    document.getElementById('updated').textContent = 'Failed to load data — serve this folder over HTTP (see README).';
  }
})();
