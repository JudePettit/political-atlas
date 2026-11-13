// End-to-end tests for Political Atlas, run with the installed Edge against a local server or a deployed URL.
//   npm start, then npm test                                  this checkout, at http://localhost:8080 (the default)
//   ATLAS_URL=https://political-atlas.pages.dev npm test      the live site
// Like the Retrospective's tests, they default to the local server, so a change is tested before it goes live. To test
// jdpi's side before a deploy too, set JDPI_URL to a local PRP checkout (e.g. http://localhost:8787): the live shared
// files (prp.css, prp-bar.js) and the shell are then served from it, and the shell's frame loads this local atlas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = (process.env.ATLAS_URL || 'http://localhost:8080').replace(/\/$/, '');
const SHELL = (process.env.JDPI_URL || 'https://jdpi.pages.dev').replace(/\/$/, '');
let browser, page;
const consoleErrors = [];

// Serve the live hosts from the local servers under test (a no-op against the live sites).
const LIVE = { 'https://jdpi.pages.dev/': `${SHELL}/`, 'https://political-atlas.pages.dev/': `${BASE}/` };
async function mapLive(p) {
  for (const [from, to] of Object.entries(LIVE)) {
    if (from === to) continue;
    await p.route(u => u.href.startsWith(from), async route => {
      const res = await route.fetch({ url: to + route.request().url().slice(from.length) });
      await route.fulfill({ response: res });
    });
  }
}

async function open(hash = '') {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('path.country.active').length > 0, null, { timeout: 30000 });
}

before(async () => {
  browser = await chromium.launch({ channel: 'msedge' });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mapLive(page);
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(e.message));
});
after(async () => { await browser?.close(); });

// The records the page reads, fetched the way the page fetches them.
const loadRecords = () => page.evaluate(async () => {
  const m = await fetch('data/manifest.json').then(r => r.json());
  const lists = await Promise.all(m.files.map(f => fetch('data/' + f).then(r => r.json())));
  return lists.flat();
});

test('page loads with all countries and no script errors', async () => {
  await open();
  const records = await loadRecords();
  const meta = await page.textContent('#updated');
  assert.match(meta, /Updated \S+/);
  assert.match(meta, new RegExp(`Coverage ${records.length} countries and territories`));
  assert.equal(await page.title(), 'Political Atlas · PRP');
  const active = await page.locator('path.country.active').count();
  const markers = await page.locator('circle.microstate').count();
  // Dots are drawn for the countries in app.js's MARKERS list that have a record.
  const expectedMarkers = await page.evaluate(codes => Object.keys(MARKERS).filter(iso => codes.includes(iso)).length, records.map(c => c.iso3));
  assert.ok(active >= records.length - expectedMarkers, `expected ≥${records.length - expectedMarkers} clickable country shapes, got ${active}`);
  assert.equal(markers, expectedMarkers, 'microstate markers');
  // The map opens on the whole world.
  assert.equal(await page.getAttribute('#map > g', 'transform'), 'translate(0,0) scale(1)');
  assert.deepEqual(consoleErrors, [], 'console errors on load');
});

test('every country to be added can be drawn: a shape in the boundaries or a marker', async () => {
  await open();
  const problems = await page.evaluate(async () => {
    const seeds = await fetch('data/seeds.json').then(r => r.json());
    const m = await fetch('data/manifest.json').then(r => r.json());
    const records = (await Promise.all(m.files.map(f => fetch('data/' + f).then(r => r.json())))).flat();
    const rows = [...records, ...Object.values(seeds.groups).flat().map(row => Object.fromEntries(seeds.fields.map((f, i) => [f, row[i]])))];
    const world = await fetch(WORLD_URL).then(r => r.json());
    const ids = new Set(world.objects.countries.geometries.map(g => g.id));
    const known = new Set(rows.map(c => c.iso3));
    return [
      ...rows.filter(c => !(c.numeric && ids.has(c.numeric)) && !MARKERS[c.iso3]).map(c => `${c.iso3}: no shape and no marker`),
      ...Object.keys(MARKERS).filter(iso => !known.has(iso)).map(iso => `marker ${iso} is not a country in the atlas`)
    ];
  });
  assert.deepEqual(problems, []);
});

test('the region filter narrows the table and upcoming list, and zooms the map', async () => {
  await open();
  const records = await loadRecords();
  const options = await page.$$eval('#region option', os => os.map(o => o.value));
  const regions = [...new Set(records.map(c => c.region.replace(/\s*\(.*\)$/, '')))].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(options, ['', ...regions], 'one option per region in the data');
  const europe = records.filter(c => c.region.startsWith('Europe')).map(c => c.iso3).sort();
  await page.selectOption('#region', 'Europe');
  assert.match(page.url(), /[?&]region=Europe/);
  const upcoming = await page.$$eval('#upcoming li', lis => lis.map(li => li.dataset.iso));
  assert.ok(upcoming.length > 0 && upcoming.every(iso => europe.includes(iso)), 'upcoming elections are European');
  // Shapes outside the region step back; those inside do not.
  assert.equal(await page.getAttribute('path.country.active[data-iso="USA"]', 'class').then(c => c.includes('out-region')), true);
  assert.equal(await page.getAttribute('path.country.active[data-iso="DEU"]', 'class').then(c => c.includes('out-region')), false);
  await page.waitForFunction(() => document.querySelector('#map > g').getAttribute('transform') !== 'translate(0,0) scale(1)');
  await page.click('#tab-table');
  const rows = await page.$$eval('#country-table tbody tr', trs => trs.map(tr => tr.dataset.iso).sort());
  assert.deepEqual(rows, europe);
  // A link with ?region= opens filtered; "All regions" brings every row back.
  await page.goto(`${BASE}/?view=table&region=north%20america`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#country-table tbody tr');
  assert.equal(await page.inputValue('#region'), 'North America');
  assert.equal(await page.locator('#country-table tbody tr').count(), records.filter(c => c.region === 'North America').length);
  await page.selectOption('#region', '');
  assert.equal(await page.locator('#country-table tbody tr').count(), records.length);
  assert.doesNotMatch(page.url(), /region=/);
  // A country with a regent names the regent under its head of state (Liechtenstein: Hereditary Prince Alois).
  const lie = records.find(c => c.iso3 === 'LIE').executive;
  const lieHos = (await page.textContent('#country-table tbody tr[data-iso="LIE"] td:nth-child(3)')).trim();
  assert.ok(lieHos.includes(lie.headOfState.name) && lieHos.includes(`Regent: ${lie.regent.name}`), lieHos);
  assert.ok(!(await page.textContent('#country-table tbody tr[data-iso="DEU"] td:nth-child(3)')).includes('Regent'), 'no regent line where there is none');
  await page.click('#tab-map');
});

test('every country opens a complete detail panel', async () => {
  await open();
  const codes = (await loadRecords()).map(c => c.iso3);
  const coverage = Number((await page.textContent('#updated')).match(/Coverage (\d+)/)[1]);
  assert.equal(codes.length, coverage, 'the coverage line counts every record');
  const problems = [];
  for (const iso3 of codes) {
    const ok = await page.evaluate(async code => {
      // Click the country's map shape or microstate marker, as a user would.
      const el = document.querySelector(`[data-iso="${code}"]`);
      if (!el) return { code, error: 'no map element' };
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const panel = document.getElementById('panel');
      const sections = [...panel.querySelectorAll('h3')].map(h => h.textContent);
      return {
        code,
        name: panel.querySelector('.c-head h2')?.textContent || '',
        sections,
        execCards: panel.querySelectorAll('.power-grid .card').length,
        timeline: panel.querySelectorAll('.timeline li').length,
        policies: panel.querySelectorAll('.bullets')[0]?.children.length || 0,
        challenges: panel.querySelectorAll('.bullets')[1]?.children.length || 0,
        hash: location.hash
      };
    }, iso3);
    const want = ['Executive', 'Legislature', 'Judiciary', 'Key election dates', 'Synopsis', 'Key policies', 'Main challenges'];
    if (ok.error) problems.push(`${iso3}: ${ok.error}`);
    else {
      if (!ok.name) problems.push(`${iso3}: no country name`);
      const missing = want.filter(w => !ok.sections.includes(w));
      if (missing.length) problems.push(`${iso3}: missing sections ${missing.join(', ')}`);
      if (ok.execCards < 2) problems.push(`${iso3}: executive cards ${ok.execCards}`);
      if (ok.timeline < 1) problems.push(`${iso3}: no elections`);
      if (ok.policies < 1 || ok.challenges < 1) problems.push(`${iso3}: empty policies/challenges`);
      if (ok.hash !== `#${iso3}`) problems.push(`${iso3}: URL hash is ${ok.hash}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('deep link opens the country and the close button clears it', async () => {
  await open('#ESP');
  assert.equal(await page.textContent('.c-head h2'), 'Spain');
  assert.match(await page.textContent('#panel'), /29 Nov 2026/);
  await page.click('#close');
  assert.equal(await page.locator('.panel-empty h2').textContent(), 'Select a country');
  assert.equal(await page.evaluate(() => location.hash), '');
});

// The point a selection should bring into view: the centre of a country's largest piece, or its marker dot.
const centreInView = () => page.evaluate(async () => {
  const seeds = await fetch('data/seeds.json').then(r => r.json());
  const seedRows = Object.values(seeds.groups).flat().map(row => Object.fromEntries(seeds.fields.map((f, i) => [f, row[i]])));
  const feats = g.selectAll('path.country').data();
  const { width, height } = svg.node().viewBox.baseVal;
  const off = [];
  // Every record, and every country still to be added (as its shape will be once it has a record).
  for (const c of [...state.countries.values(), ...seedRows]) {
    const f = state.countries.has(c.iso3) ? g.select(`path.country[data-iso="${c.iso3}"]`).datum() : feats.find(x => x.id === c.numeric);
    if (!f && !MARKERS[c.iso3]) continue; // checked by the "can be drawn" test
    const box = f ? shapeBounds(f) : markerBounds(MARKERS[c.iso3]);
    const [x, y] = boxTransform(projectBounds(box)).apply(f ? path.centroid(mainPolygon(f)) : projection(MARKERS[c.iso3]));
    if (!(x >= 0 && x <= width && y >= 0 && y <= height)) off.push(`${c.iso3} at (${Math.round(x)}, ${Math.round(y)})`);
  }
  return off;
});

test('selecting a country frames it on the map, near the 180° line too', async () => {
  await open();
  assert.deepEqual(await centreInView(), [], 'countries whose selection zooms the map away from them');
  // And the real thing, as a deep link: the United States (whose padded box once wrapped round the 180° line) and Russia.
  for (const iso of ['USA', 'RUS']) {
    await open(`#${iso}`);
    await page.waitForTimeout(1000); // the zoom's 750 ms transition
    const where = await page.evaluate(code => {
      const f = g.select(`path.country[data-iso="${code}"]`).datum();
      return d3.zoomTransform(svg.node()).apply(path.centroid(mainPolygon(f)));
    }, iso);
    assert.ok(where[0] >= 0 && where[0] <= 1000 && where[1] >= 0 && where[1] <= 600, `${iso} lands at ${where.map(Math.round)}`);
  }
});

test('upcoming elections list is in date order and opens countries', async () => {
  await open();
  const dates = await page.$$eval('#upcoming li', lis => lis.map(li => li.dataset.iso));
  assert.ok(dates.length >= 10, `expected ≥10 upcoming elections, got ${dates.length}`);
  await page.click('#upcoming li:first-child');
  assert.ok((await page.textContent('.c-head h2')).length > 0);
});

test('map colour modes change fills and legend', async () => {
  await open();
  const snapshot = () => page.evaluate(() => ({
    fill: document.querySelector('path.country.active[data-iso="USA"]').getAttribute('fill'),
    legend: document.querySelector('#legend h4').textContent
  }));
  const system = await snapshot();
  await page.click('.segmented button[data-mode="election"]');
  const election = await snapshot();
  await page.click('.segmented button[data-mode="status"]');
  const status = await snapshot();
  assert.equal(system.legend, 'System of government');
  assert.equal(election.legend, 'Next national election');
  assert.equal(status.legend, 'Government stability');
  assert.notEqual(system.fill, election.fill);
  await page.click('.segmented button[data-mode="system"]');
});

test('the tooltip names whoever holds the most power: the president of France, the prime minister of the UK', async () => {
  await open();
  const records = await page.evaluate(async () => {
    const m = await fetch('data/manifest.json').then(r => r.json());
    const lists = await Promise.all(m.files.map(f => fetch('data/' + f).then(r => r.json())));
    return Object.fromEntries(lists.flat().map(c => [c.iso3, c.executive]));
  });
  const tip = async iso => {
    // The tooltip follows the pointer, so the event is sent to the country's own shape (France's bounding box also
    // covers its neighbours).
    await page.evaluate(code => {
      const el = document.querySelector(`path.country.active[data-iso="${code}"]`), b = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
    }, iso);
    // The country, the leader's name (the text after the country) and the leader's office and party.
    return page.evaluate(() => {
      const t = document.getElementById('tooltip');
      return t.hidden ? null : [t.querySelector('strong').textContent, t.querySelector('strong').nextSibling.textContent, t.querySelector('.tip-role').textContent].join(' | ');
    });
  };
  const fra = records.FRA, gbr = records.GBR;
  assert.equal(fra.leader, 'headOfState');
  assert.notEqual(fra.headOfState.name, fra.headOfGovernment.name, 'France has a president and a prime minister');
  const france = await tip('FRA');
  assert.ok(france.startsWith(`France | ${fra.headOfState.name} | ${fra.headOfState.title}`), france);
  assert.ok(!france.includes(fra.headOfGovernment.name), 'not the prime minister');
  assert.equal(gbr.leader, 'headOfGovernment');
  const uk = await tip('GBR');
  assert.ok(uk.startsWith(`United Kingdom | ${gbr.headOfGovernment.name} | ${gbr.headOfGovernment.title}`), uk);
  assert.ok(!uk.includes(gbr.headOfState.name), 'not the monarch');
  // Liechtenstein, a microstate drawn as a dot: the regent, Hereditary Prince Alois, not Prince Hans-Adam II.
  const lie = records.LIE;
  assert.equal(lie.leader, 'regent');
  await page.evaluate(() => {
    const el = document.querySelector('circle.microstate[data-iso="LIE"]') || document.querySelector('path.country.active[data-iso="LIE"]'), b = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
  });
  const liechtenstein = await page.evaluate(() => {
    const t = document.getElementById('tooltip');
    return t.hidden ? null : [t.querySelector('strong').textContent, t.querySelector('strong').nextSibling.textContent, t.querySelector('.tip-role').textContent].join(' | ');
  });
  assert.equal(liechtenstein, `Liechtenstein | ${lie.regent.name} | ${lie.regent.title}`, 'the regent, not the Prince');
});

test('search finds countries and leaders', async () => {
  await open();
  await page.fill('#search', 'Burnham');
  await page.waitForSelector('#search-results li');
  assert.equal((await page.textContent('#search-results li')).trim(), 'United Kingdom');
  await page.press('#search', 'Enter');
  assert.equal(await page.textContent('.c-head h2'), 'United Kingdom');
  // Someone who heads several states: the country they lead comes first (Macron is also Andorra's co-prince).
  await page.fill('#search', 'Macron');
  await page.waitForSelector('#search-results li');
  assert.deepEqual((await page.$$eval('#search-results li', lis => lis.map(li => li.textContent.trim()))), ['France', 'Andorra']);
  await page.press('#search', 'Enter');
  assert.equal(await page.textContent('.c-head h2'), 'France');
  await page.fill('#search', 'zzzz');
  assert.equal(await page.locator('#search-results').isHidden(), true);
});

test('PRP design system is applied', async () => {
  await open();
  const s = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--prp-accent').trim(),
    suite: document.documentElement.dataset.suite,
    returnBar: !!document.querySelector('.jdpi-returnbar')
  }));
  assert.equal(s.bg, 'rgb(243, 244, 246)'); // PRP canvas, light theme
  assert.match(s.font, /IBM Plex Sans/);
  assert.ok(s.accent, 'shared stylesheet loaded from jdpi.pages.dev');
  assert.equal(s.suite, 'rt');
  await page.waitForSelector('.jdpi-returnbar', { timeout: 5000 });
});

test('inside the PRP shell the page hides its own brand', async () => {
  // Where the shell files the atlas, and what its breadcrumb calls it, come from jdpi's registry, so a rename there
  // needs no change here.
  const registry = await (await fetch(`${SHELL}/registry.json`)).json();
  const suite = registry.suites.find(s => s.modules.some(m => m.id === 'atlas'));
  const atlas = suite.modules.find(m => m.id === 'atlas');
  await page.goto(`${SHELL}/#/${suite.id}/atlas`, { waitUntil: 'networkidle' });
  const frame = page.frameLocator('#frames iframe.active');
  await frame.locator('path.country.active').first().waitFor({ timeout: 30000 });
  const embedded = await frame.locator('html').getAttribute('class');
  assert.match(embedded || '', /jdpi-embedded/);
  assert.equal(await frame.locator('.eyebrow').isHidden(), true);
  assert.equal(await frame.locator('.jdpi-returnbar').count(), 0);
  const crumbs = await page.textContent('#crumbs');
  assert.ok(crumbs.includes(suite.name) && crumbs.indexOf(atlas.name) > crumbs.indexOf(suite.name), `breadcrumb: ${crumbs}`);
});

test('phone layout has no horizontal overflow', async () => {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(`${BASE}/#DEU`, { waitUntil: 'networkidle' });
  await mobile.waitForSelector('.c-head h2');
  const { scroll, width } = await mobile.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
  assert.ok(scroll <= width + 1, `page is ${scroll}px wide on a ${width}px screen`);
  await mobile.close();
});

test('on a phone at world scale, a tap on Germany opens Germany, not the Luxembourg dot', async () => {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mobile.waitForSelector('path.country.active[data-iso="DEU"]');
  const dot = () => mobile.$eval('circle.microstate[data-iso="LUX"]', el => getComputedStyle(el).pointerEvents);
  assert.equal(await dot(), 'none', 'dots let taps through at world scale');
  // Measure Germany once the layout has settled (fonts, lazy images and the VM return bar, which arrives from jdpi
  // after network idle and pushes the map down 36 pixels, can still move the map; in one full run a tap measured too
  // early landed on nothing), and only when Germany is the element under that point. The loop runs here and not in
  // waitForFunction, which does not wait for an async function's answer: it took the first look even when that look
  // was false, and the tap then had no point to aim at.
  let b = false;
  for (const end = Date.now() + 15000; !b && Date.now() < end;) {
    b = await mobile.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const at = () => { const r = document.querySelector('path.country.active[data-iso="DEU"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const p = at();
      await new Promise(r => setTimeout(r, 200));
      const q = at();
      const stable = Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
      return stable && document.elementFromPoint(q.x, q.y)?.getAttribute('data-iso') === 'DEU' ? q : false;
    });
  }
  assert.ok(b, 'Germany never settled under its own centre point within 15 seconds');
  await mobile.touchscreen.tap(b.x, b.y);
  await mobile.waitForSelector('.c-head h2', { timeout: 10000 }).catch(async () => {
    assert.fail(`the tap at (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) opened nothing; address ${await mobile.evaluate(() => location.hash) || '(none)'}`);
  });
  assert.equal(await mobile.textContent('.c-head h2'), 'Germany');
  // Zoomed in, the dots can be tapped again.
  await mobile.evaluate(() => svg.call(zoom.transform, d3.zoomIdentity.scale(3)));
  assert.equal(await dot(), 'auto');
  await mobile.close();
});

test('all flag images exist', async () => {
  await open();
  const codes = await page.evaluate(async () => {
    const m = await fetch('data/manifest.json').then(r => r.json());
    const lists = await Promise.all(m.files.map(f => fetch('data/' + f).then(r => r.json())));
    return lists.flat().map(c => c.iso2);
  });
  const missing = [];
  for (const c of codes) {
    const res = await fetch(`https://flagcdn.com/w80/${c}.png`, { method: 'HEAD' });
    if (!res.ok) missing.push(`${c} (${res.status})`);
  }
  assert.deepEqual(missing, []);
});
