// Data checks for Political Atlas: schema, uniqueness, dates and internal consistency.
//   node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';

const read = p => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
const manifest = read('manifest.json');
const schema = read('schema.json');
const countries = manifest.files.flatMap(f => read(f));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const DATE = /^(\d{4})(-\d{2})?(-\d{2})?$|^TBD$/;

test('78 countries, each valid against the schema', () => {
  assert.equal(countries.length, 78);
  const errors = countries.filter(c => !validate(c)).map(c => `${c.iso3}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(errors, []);
});

test('ISO codes and names are unique', () => {
  for (const key of ['iso3', 'iso2', 'name']) {
    const seen = new Map();
    for (const c of countries) seen.set(c[key], (seen.get(c[key]) || 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepEqual(dupes, [], `duplicate ${key}`);
  }
  const numerics = countries.map(c => c.numeric).filter(Boolean);
  assert.equal(new Set(numerics).size, numerics.length, 'duplicate numeric codes');
});

test('election dates are well formed and statuses match the calendar', () => {
  const today = new Date().toISOString().slice(0, 10);
  const problems = [];
  for (const c of countries) {
    for (const e of c.elections) {
      if (!DATE.test(e.date)) problems.push(`${c.iso3} ${e.name}: bad date "${e.date}"`);
      const full = e.date.length === 10 ? e.date : null;
      if (full && e.status === 'upcoming' && full < today) problems.push(`${c.iso3} ${e.name}: "upcoming" but ${full} has passed`);
      if (full && e.status === 'held' && full > today) problems.push(`${c.iso3} ${e.name}: "held" but ${full} is in the future`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every country has an upcoming election or a stated reason', () => {
  const none = countries.filter(c => !c.elections.some(e => e.status === 'upcoming'))
    .map(c => c.iso3);
  // Absolute monarchies and the Holy See hold no national elections.
  assert.deepEqual(none.filter(c => !['SAU', 'VAT'].includes(c)), []);
});

test('in-flux countries explain why', () => {
  const missing = countries.filter(c => c.status === 'in-flux' && !c.reviewNote).map(c => c.iso3);
  assert.deepEqual(missing, []);
});

test('text fields are filled and links-free plain text', () => {
  const problems = [];
  for (const c of countries) {
    if (c.synopsis.length < 60) problems.push(`${c.iso3}: synopsis too short`);
    if (c.policies.length < 2 || c.challenges.length < 2) problems.push(`${c.iso3}: fewer than 2 policies/challenges`);
    if (/<[a-z]/i.test(JSON.stringify(c))) problems.push(`${c.iso3}: contains HTML`);
  }
  assert.deepEqual(problems, []);
});
