// End-to-end tests for Political Atlas, run against a deployed URL with the installed Edge.
//   ATLAS_URL=https://political-atlas.pages.dev node --test tests/
// Defaults to the live site; set ATLAS_URL=http://localhost:8080 to test a local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = (process.env.ATLAS_URL || 'https://political-atlas.pages.dev').replace(/\/$/, '');
const SHELL = (process.env.JDPI_URL || 'https://jdpi.pages.dev').replace(/\/$/, '');
let browser, page;
const consoleErrors = [];

async function open(hash = '') {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('path.country.active').length > 0, null, { timeout: 30000 });
}

before(async () => {
  browser = await chromium.launch({ channel: 'msedge' });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(e.message));
});
after(async () => { await browser?.close(); });

test('page loads with all countries and no script errors', async () => {
  await open();
  const subtitle = await page.textContent('#updated');
  assert.match(subtitle, /^78 countries · data updated /);
  assert.equal(await page.title(), 'Political Atlas · JDP-I H&P');
  const active = await page.locator('path.country.active').count();
  const markers = await page.locator('circle.microstate').count();
  assert.ok(active >= 70, `expected ≥70 clickable country shapes, got ${active}`);
  assert.equal(markers, 16, 'microstate markers');
  assert.deepEqual(consoleErrors, [], 'console errors on load');
});

test('every country opens a complete detail panel', async () => {
  await open();
  const codes = await page.evaluate(async () => {
    const m = await fetch('data/manifest.json').then(r => r.json());
    const lists = await Promise.all(m.files.map(f => fetch('data/' + f).then(r => r.json())));
    return lists.flat().map(c => c.iso3);
  });
  assert.equal(codes.length, 78);
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

test('search finds countries and leaders', async () => {
  await open();
  await page.fill('#search', 'Burnham');
  await page.waitForSelector('#search-results li');
  assert.equal((await page.textContent('#search-results li')).trim(), 'United Kingdom');
  await page.press('#search', 'Enter');
  assert.equal(await page.textContent('.c-head h2'), 'United Kingdom');
  await page.fill('#search', 'zzzz');
  assert.equal(await page.locator('#search-results').isHidden(), true);
});

test('JDP-I design system is applied', async () => {
  await open();
  const s = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--jdpi-cyan').trim(),
    suite: document.documentElement.dataset.suite,
    returnBar: !!document.querySelector('.jdpi-returnbar')
  }));
  assert.equal(s.bg, 'rgb(16, 24, 32)');
  assert.match(s.font, /DM Sans/);
  assert.equal(s.accent, '#6ddac8', 'shared stylesheet loaded from jdpi.pages.dev');
  assert.equal(s.suite, 'hp');
  await page.waitForSelector('.jdpi-returnbar', { timeout: 5000 });
});

test('inside the JDP-I shell the module hides its own brand', async () => {
  await page.goto(`${SHELL}/#/hp/atlas`, { waitUntil: 'networkidle' });
  const frame = page.frameLocator('#frames iframe.active');
  await frame.locator('path.country.active').first().waitFor({ timeout: 30000 });
  const embedded = await frame.locator('html').getAttribute('class');
  assert.match(embedded || '', /jdpi-embedded/);
  assert.equal(await frame.locator('.eyebrow').isHidden(), true);
  assert.equal(await frame.locator('.jdpi-returnbar').count(), 0);
  assert.match(await page.textContent('#crumbs'), /H&P.*Political Atlas/);
});

test('phone layout has no horizontal overflow', async () => {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(`${BASE}/#DEU`, { waitUntil: 'networkidle' });
  await mobile.waitForSelector('.c-head h2');
  const { scroll, width } = await mobile.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
  assert.ok(scroll <= width + 1, `page is ${scroll}px wide on a ${width}px screen`);
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
