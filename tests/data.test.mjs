// Data checks for Political Atlas: schema, uniqueness, dates and internal consistency.
//   node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { seedRows, checkRecord, NO_ELECTION_TYPES, IDENTITY } from '../scripts/research.mjs';

const read = p => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
const manifest = read('manifest.json');
const schema = read('schema.json');
const countries = manifest.files.flatMap(f => read(f));
const seeds = seedRows(read('seeds.json'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const DATE = /^(\d{4})(-\d{2})?(-\d{2})?$|^TBD$/;

// The atlas's full set: the 193 UN member states, the two observer states (the Holy See and Palestine), Kosovo, Taiwan
// and Greenland. Each has a record, or a seed in data/seeds.json that create mode turns into one, so the test follows
// the data as regions are added while the target stays fixed.
const TARGET = 198;

test('every country has a record or a seed, and every record is valid against the schema', () => {
  assert.ok(countries.length > 0);
  assert.equal(new Set([...countries.map(c => c.iso3), ...seeds.map(s => s.iso3)]).size, TARGET);
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

test('each country names the office that holds the most power', () => {
  const leader = iso => countries.find(c => c.iso3 === iso).executive.leader;
  // Where the president, party leader or ruling monarch directs the government, it is the head of state…
  for (const iso of ['FRA', 'RUS', 'CHN', 'UKR', 'BLR', 'AZE', 'CUB', 'MCO', 'VAT', 'USA', 'MEX']) assert.equal(leader(iso), 'headOfState', iso);
  // …and in parliamentary systems the head of government (Saudi Arabia's crown prince governs as its prime minister).
  for (const iso of ['GBR', 'DEU', 'ITA', 'ESP', 'POL', 'CAN', 'JPN', 'ISR', 'SAU', 'IRL']) assert.equal(leader(iso), 'headOfGovernment', iso);
  // …and in Liechtenstein the regent, Hereditary Prince Alois, who has exercised the Prince's powers since 15 August
  // 2004, while Prince Hans-Adam II stays head of state (Jude, 12 November 2026).
  const lie = countries.find(c => c.iso3 === 'LIE').executive;
  assert.equal(lie.leader, 'regent');
  assert.deepEqual([lie.regent.name, lie.regent.since, lie.headOfState.name], ['Hereditary Prince Alois', '2004-08-15', 'Hans-Adam II']);
  // The note names its sources: the Princely House's pages about Alois and about Hans-Adam II.
  assert.match(countries.find(c => c.iso3 === 'LIE').reviewNote, /page about Alois.*page about Hans-Adam II/);
  // A regent is recorded only beside a head of state, and only Liechtenstein has one.
  assert.deepEqual(countries.filter(c => c.executive.regent || c.executive.leader === 'regent').map(c => c.iso3), ['LIE']);
  for (const c of countries) {
    const { leader: which, headOfState: hos, headOfGovernment: hog } = c.executive;
    assert.ok(c.executive[which]?.name, `${c.iso3}: the leader has a name`);
    // One person in both offices is named as head of state; a presidential system's president always is.
    if (hos.name === hog.name || c.systemType === 'presidential') assert.equal(which, 'headOfState', c.iso3);
    if (c.systemType === 'dependent-territory') assert.equal(which, 'headOfGovernment', c.iso3);
  }
});

test('monarchs who rule are classed together and shown as "Ruling monarchy"', () => {
  // Jude, 13 November 2026: the type absolute-monarchy holds every monarchy whose monarch rules as well as reigns,
  // with or without a constitution and an elected chamber, and the page calls it "Ruling monarchy" ("Absolute
  // monarchy" before, which Jordan, Kuwait, Bahrain and Morocco are not). Morocco joined the type that day: it had
  // been shown as "Constitutional monarchy" beside the other three.
  const record = iso => countries.find(c => c.iso3 === iso);
  for (const iso of ['SAU', 'OMN', 'QAT', 'ARE', 'BHR', 'JOR', 'KWT', 'MAR']) assert.equal(record(iso).systemType, 'absolute-monarchy', iso);
  // The map names the monarch in each, or in Saudi Arabia the crown prince, who governs as prime minister.
  for (const iso of ['OMN', 'QAT', 'ARE', 'BHR', 'JOR', 'KWT', 'MAR']) assert.equal(record(iso).executive.leader, 'headOfState', iso);
  // The label is the page's; the data keeps the type's id, and the schema tells the research runs what it means.
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /'absolute-monarchy': \{ label: 'Ruling monarchy', family: 'auto' \}/);
  assert.doesNotMatch(app, /label: '[^']*[Aa]bsolute/, 'no label on the page says "absolute"');
  assert.match(schema.properties.systemType.description, /shown on the page as "Ruling monarchy"/);
});

test('every country has an upcoming election or a stated reason', () => {
  const none = countries.filter(c => !c.elections.some(e => e.status === 'upcoming'))
    .map(c => c.iso3);
  // Ruling monarchies (some hold no national vote at all), the Holy See, military governments and civilian
  // transitions may have no national vote to schedule (the rule create mode applies too).
  const exempt = new Set(countries.filter(c => NO_ELECTION_TYPES.includes(c.systemType)).map(c => c.iso3));
  assert.deepEqual(none.filter(c => !exempt.has(c)), []);
  assert.ok(exempt.has('SAU') && exempt.has('VAT'), 'Saudi Arabia and the Holy See are exempt');
});

test('seeds are well formed and agree with the records made from them', () => {
  const regions = schema.properties.region.enum;
  const problems = [];
  for (const key of ['iso3', 'iso2', 'numeric', 'name']) {
    const values = seeds.map(s => s[key]).filter(Boolean);
    if (new Set(values).size !== values.length) problems.push(`duplicate seed ${key}`);
  }
  const byIso = new Map(countries.map(c => [c.iso3, c]));
  const fileOf = new Map(manifest.files.flatMap(f => read(f).map(c => [c.iso3, f])));
  for (const s of seeds) {
    if (!/^[A-Z]{3}$/.test(s.iso3) || !/^[a-z]{2}$/.test(s.iso2)) problems.push(`${s.iso3}: bad codes`);
    if (s.numeric !== null && !/^\d{3}$/.test(s.numeric)) problems.push(`${s.iso3}: numeric ${s.numeric}`);
    if (!regions.includes(s.region)) problems.push(`${s.iso3}: region ${s.region} is not in the schema`);
    if (!/^[a-z0-9-]+$/.test(s.group)) problems.push(`${s.iso3}: group ${s.group}`);
    // Once created, a record keeps its seed's identity and lives in its group's file.
    const r = byIso.get(s.iso3);
    if (r) {
      for (const k of IDENTITY) if (r[k] !== s[k]) problems.push(`${s.iso3}: record ${k} "${r[k]}" differs from seed "${s[k]}"`);
      const file = fileOf.get(s.iso3);
      if (file !==`countries/${s.group}.json`) problems.push(`${s.iso3}: in ${file}, not countries/${s.group}.json`);
    } else {
      // A seed still to be created must not clash with an existing record's codes or name.
      for (const k of ['iso2', 'numeric', 'name']) if (s[k] && countries.some(c => c[k] === s[k])) problems.push(`${s.iso3}: ${k} already used by a record`);
    }
  }
  assert.deepEqual(problems, []);
});

test("create mode's checks accept every existing record", () => {
  // Create mode refuses a record that fails these checks, so they must be no stricter than the data the atlas has.
  const today = new Date().toISOString().slice(0, 10);
  const problems = countries.map(c => [c.iso3, checkRecord(c, today)]).filter(([, p]) => p.length).map(([iso, p]) => `${iso}: ${p.join('; ')}`);
  assert.deepEqual(problems, []);
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
