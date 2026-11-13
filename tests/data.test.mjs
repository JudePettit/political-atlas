// Data checks for Political Atlas: schema, uniqueness, dates and internal consistency.
//   node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { seedRows, checkRecord, NO_ELECTION_TYPES, NO_ELECTION_COUNTRIES, MONARCHY_RULE_EXCEPTIONS, IDENTITY } from '../scripts/research.mjs';

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
  // Monaco and Liechtenstein joined it the same day, by the rule below (Jude, 13 November 2026).
  for (const iso of ['SAU', 'OMN', 'QAT', 'ARE', 'BHR', 'JOR', 'KWT', 'MAR', 'MCO', 'LIE']) assert.equal(record(iso).systemType, 'absolute-monarchy', iso);
  // The map names the monarch in each, or in Liechtenstein the regent, or in Saudi Arabia the crown prince, who governs
  // as prime minister.
  for (const iso of ['OMN', 'QAT', 'ARE', 'BHR', 'JOR', 'KWT', 'MAR', 'MCO']) assert.equal(record(iso).executive.leader, 'headOfState', iso);
  // The label is the page's; the data keeps the type's id, and the schema tells the research runs what it means.
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /'absolute-monarchy': \{ label: 'Ruling monarchy', family: 'auto' \}/);
  assert.doesNotMatch(app, /label: '[^']*[Aa]bsolute/, 'no label on the page says "absolute"');
  assert.match(schema.properties.systemType.description, /shown on the page as "Ruling monarchy"/);
});

test('a monarchy is a ruling monarchy where the map names its monarch or regent, and only there', () => {
  // Jude, 13 November 2026, when Monaco and Liechtenstein became ruling monarchies: a parliamentary-monarchy must not
  // name the head of state or a regent as executive.leader, and an absolute-monarchy must. Create mode refuses a record
  // that breaks the rule (checkRecord), from the same list of named exceptions, each with its reason.
  const breaks = c => {
    const monarch = c.executive.leader === 'headOfState' || c.executive.leader === 'regent';
    return (c.systemType === 'parliamentary-monarchy' && monarch) || (c.systemType === 'absolute-monarchy' && !monarch);
  };
  const broken = countries.filter(breaks).map(c => c.iso3);
  assert.deepEqual(broken.filter(iso => !MONARCHY_RULE_EXCEPTIONS[iso]), [], 'records that break the rule');
  // Each exception is a record that still breaks it, with its reason, so the list cannot outlive the need for it.
  assert.deepEqual(Object.keys(MONARCHY_RULE_EXCEPTIONS).sort(), broken.filter(iso => MONARCHY_RULE_EXCEPTIONS[iso]).sort(), 'every named exception still breaks the rule');
  for (const [iso, why] of Object.entries(MONARCHY_RULE_EXCEPTIONS)) assert.ok(why.length > 20, `${iso}: a reason`);
  for (const iso of ['MCO', 'LIE']) assert.ok(!MONARCHY_RULE_EXCEPTIONS[iso] && !breaks(countries.find(c => c.iso3 === iso)), iso);
  // The new class is not a fact in doubt: Monaco's facts are confirmed, so its profile shows no "Needs review" box.
  assert.equal(countries.find(c => c.iso3 === 'MCO').reviewNote, undefined, 'Monaco has no reviewNote');
  // The schema states the rule for the research runs, and names both countries among the ruling monarchies.
  assert.match(schema.properties.systemType.description, /a monarchy is a ruling monarchy where executive\.leader names its monarch \(headOfState\) or regent/);
  assert.match(schema.properties.systemType.description, /\(Saudi Arabia, [^)]*Monaco, Liechtenstein\)/);
});

test('every country has an upcoming election or a stated reason', () => {
  const none = countries.filter(c => !c.elections.some(e => e.status === 'upcoming'))
    .map(c => c.iso3);
  // Ruling monarchies (some hold no national vote at all), the Holy See, military governments and civilian
  // transitions may have no national vote to schedule (the rule create mode applies too). So may the few countries
  // create mode names one by one (Eritrea, a one-party state that has held no national election since independence).
  const exempt = new Set(countries
    .filter(c => NO_ELECTION_TYPES.includes(c.systemType) || NO_ELECTION_COUNTRIES.includes(c.iso3)).map(c => c.iso3));
  assert.deepEqual(none.filter(c => !exempt.has(c)), []);
  assert.ok(exempt.has('SAU') && exempt.has('VAT'), 'Saudi Arabia and the Holy See are exempt');
  // The one-party type itself is not exempt: every one-party record other than the named countries lists a vote to come.
  const onePartyWithout = countries.filter(c => c.systemType === 'one-party' && none.includes(c.iso3)).map(c => c.iso3);
  assert.deepEqual(onePartyWithout.filter(c => !NO_ELECTION_COUNTRIES.includes(c)), []);
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

// The workflow's guard against a double start. On 13 November 2026 one group was started twice, twenty seconds apart,
// and both runs did the whole research. Create runs now share one concurrency group, so a second start waits for the
// first and then stops at the open-pull-request guard, which must therefore come before the research step.
test('create runs queue behind one another, and the open-pull-request guard comes before the research', () => {
  const yml = readFileSync(new URL('../.github/workflows/monthly-update.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const head = yml.slice(0, yml.indexOf('\njobs:'));
  const block = head.match(/\nconcurrency:\n  group: (.+)\n  cancel-in-progress: (\w+)\n/);
  assert.ok(block, 'a workflow-level concurrency block with a group and cancel-in-progress');
  assert.match(block[1], /== 'create' && 'atlas-create'/, 'every create run is in the one group atlas-create');
  assert.match(block[1], /github\.run_id/, 'update runs each get a group of their own, so they never queue');
  assert.equal(block[2], 'false', 'a create run that is under way is never cancelled by a second start');
  const guard = yml.indexOf('Refuse a create run while another create pull request is open');
  const research = yml.indexOf('Refresh or create country data');
  assert.ok(guard > 0 && research > guard, 'the guard runs before any request is sent');
});
