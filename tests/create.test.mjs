// Create mode, tested against a stub in place of the Anthropic client: no network and no API key. Covers the parsing,
// the checks, the repair turn, pause_turn continuations, and what a run writes (and does not write) to the data folder.
//   node --test tests/create.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL, SEARCHES, IDENTITY, MAX_CREATE, PRICES, extractJson, checkRecord, createCountry, createPrompt, compileSchema, pickSeeds, seedRows, runCreate,
  parseNotes, searchUrls, sourceLines, estimateCost, MONARCHY_RULE_EXCEPTIONS
} from '../scripts/research.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const schema = JSON.parse(await readFile(path.join(DATA, 'schema.json'), 'utf8'));
const seeds = seedRows(JSON.parse(await readFile(path.join(DATA, 'seeds.json'), 'utf8')));
const validate = compileSchema(schema);
const TODAY = '2026-11-06';
const seed = iso => seeds.find(s => s.iso3 === iso);
const quiet = { log() {}, error() {} };

// A complete record as Claude might write it, with deliberately wrong identity fields and date stamp: create mode must
// replace both from the seed and the run.
function draft(overrides = {}) {
  return {
    iso3: 'XXX', iso2: 'xx', numeric: '000', name: 'Wrong name', region: 'Europe',
    system: 'Presidential republic', systemType: 'presidential', status: 'stable',
    executive: {
      leader: 'headOfState',
      headOfState: { name: 'Test President', title: 'President', party: 'Test Party', since: '2021' },
      headOfGovernment: { name: 'Test Premier', title: 'Prime Minister' },
      governingParties: ['Test Party']
    },
    legislature: [{ name: 'National Assembly', control: 'Test Party majority', detail: '100 of 150 seats' }],
    judiciary: 'The Supreme Court is the highest court.',
    elections: [
      { name: 'Presidential election', date: '2021-03-01', status: 'held', note: 'Test President won.' },
      { name: 'Presidential election', date: '2031', status: 'upcoming' }
    ],
    synopsis: 'A test synopsis that is long enough to pass the sixty-character minimum for records.',
    policies: ['One', 'Two', 'Three'], challenges: ['One', 'Two', 'Three'],
    lastVerified: '2000-01-01',
    ...overrides
  };
}
const reply = (text, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } });
const json = record => reply('Here is the record.\n```json\n' + JSON.stringify(record, null, 2) + '\n```');

// The stub answers each request from `answer(params, n)`, n counting that country's requests from 0, and records a
// copy of every request it was sent.
function stubClient(answer) {
  const calls = [], perCountry = new Map();
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const iso = /\(([A-Z]{3})\)/.exec(params.messages[0].content)?.[1];
          const n = perCountry.get(iso) || 0;
          perCountry.set(iso, n + 1);
          const message = answer(params, n, iso);
          return { finalMessage: async () => message };
        }
      }
    }
  };
}

async function tempData() {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-create-'));
  await cp(DATA, dir, { recursive: true });
  // These tests expect the data as it was before any seed group was created, whatever has been generated since:
  // a record for a seed country is dropped from the copy, and a file left empty goes with its manifest line.
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const seeded = new Set(seeds.map(s => s.iso3));
  const files = [];
  for (const f of manifest.files) {
    const p = path.join(dir, f);
    const kept = JSON.parse(await readFile(p, 'utf8')).filter(r => !seeded.has(r.iso3));
    if (kept.length) { await writeFile(p, JSON.stringify(kept, null, 2) + '\n'); files.push(f); } else await rm(p);
  }
  manifest.files = files;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}
const readJson = async (dir, p) => JSON.parse(await readFile(path.join(dir, p), 'utf8'));
const exists = p => access(p).then(() => true, () => false);

test('extractJson reads a fenced block or a bare object among prose', () => {
  assert.deepEqual(extractJson('Sure.\n```json\n{"a": 1}\n```\nDone.'), { a: 1 });
  assert.deepEqual(extractJson('The record is {"a": {"b": 2}} as requested.'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
});

test('a created record takes its identity from the seed and its date from the run, in one request', async () => {
  const client = stubClient(() => json(draft()));
  const { record, requests } = await createCountry(client, seed('GHA'), { schema, validate, today: TODAY });
  for (const k of IDENTITY) assert.equal(record[k], seed('GHA')[k], k);
  assert.equal(record.lastVerified, TODAY);
  assert.equal(requests, 1);
  assert.ok(validate(record));
  const [call] = client.calls;
  assert.equal(call.model, MODEL);
  assert.equal(call.tools[0].type, 'web_search_20260209');
  assert.equal(call.tools[0].max_uses, SEARCHES.create);
  assert.equal(call.system, createPrompt(schema, TODAY));
  assert.match(call.system, /Use exactly the iso3, iso2, numeric, name and region you are given/);
  assert.match(call.system, /Never guess a name/);
  // The request names the country and carries its identity.
  assert.match(call.messages[0].content, /Ghana \(GHA\)/);
  assert.match(call.messages[0].content, /"iso2": "gh"/);
  assert.match(call.messages[0].content, /"region": "Africa"/);
});

test('the create prompt carries the schema, so new regions and system types reach Claude', () => {
  const system = createPrompt(schema, TODAY);
  for (const word of ['"Africa"', '"South America"', '"Oceania"', '"military"']) assert.ok(system.includes(word), word);
  assert.match(system, /Today's date is 2026-11-06/);
});

test('pause_turn continues the same turn', async () => {
  const client = stubClient((params, n) => (n === 0
    ? { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Ghana' } }], usage: {} }
    : json(draft())));
  const { requests } = await createCountry(client, seed('GHA'), { schema, validate, today: TODAY });
  assert.equal(requests, 2);
  assert.equal(client.calls[1].messages.length, 2);
  assert.equal(client.calls[1].messages[1].role, 'assistant');
});

test('a record that fails a check goes back once for repair', async () => {
  const client = stubClient((params, n) => json(n === 0 ? draft({ systemType: 'junta' }) : draft()));
  const { record, requests } = await createCountry(client, seed('MLI'), { schema, validate, today: TODAY });
  assert.equal(requests, 2);
  assert.equal(record.systemType, 'presidential');
  const repair = client.calls[1].messages.at(-1);
  assert.equal(repair.role, 'user');
  assert.match(repair.content, /\/systemType must be equal to one of the allowed values \(.*military.*\)/);
});

test('a record that still fails, an unreadable reply or a refusal throws and returns nothing', async () => {
  const bad = stubClient(() => json(draft({ synopsis: 'Too short.' })));
  await assert.rejects(createCountry(bad, seed('MLI'), { schema, validate, today: TODAY }), err => {
    assert.match(err.message, /synopsis is too short/);
    assert.equal(err.requests, 2);
    return true;
  });
  const prose = stubClient(() => reply('I could not find enough information.'));
  await assert.rejects(createCountry(prose, seed('MLI'), { schema, validate, today: TODAY }), /could not be read as one JSON object/);
  const refusal = stubClient(() => ({ stop_reason: 'refusal', content: [], stop_details: { category: 'test' }, usage: {} }));
  await assert.rejects(createCountry(refusal, seed('MLI'), { schema, validate, today: TODAY }), /refused \(test\)/);
  assert.equal(refusal.calls.length, 1, 'a refusal is not retried');
});

test('checkRecord applies the data tests\' rules', () => {
  const ok = { ...draft(), ...Object.fromEntries(IDENTITY.map(k => [k, seed('GHA')[k]])) };
  assert.deepEqual(checkRecord(ok, TODAY), []);
  const problems = record => checkRecord({ ...ok, ...record }, TODAY).join(' | ');
  assert.match(problems({ elections: [{ name: 'Vote', date: '2026-01-01', status: 'upcoming' }] }), /has passed/);
  assert.match(problems({ elections: [{ name: 'Vote', date: '2027-01-01', status: 'held' }] }), /in the future/);
  assert.match(problems({ elections: [{ name: 'Vote', date: 'soon', status: 'upcoming' }] }), /is not YYYY-MM-DD/);
  assert.match(problems({ elections: [] }), /at least one entry/);
  assert.match(problems({ elections: [ok.elections[0]] }), /no upcoming national election/);
  // A military government need not have a vote scheduled.
  assert.deepEqual(checkRecord({ ...ok, systemType: 'military', elections: [ok.elections[0]] }, TODAY), []);
  // A one-party state must still give its next vote; only a country named in NO_ELECTION_COUNTRIES need not (Eritrea
  // has held no national election since independence, and three create runs refused its record for saying so).
  assert.match(problems({ systemType: 'one-party', elections: [ok.elections[0]] }), /no upcoming national election/);
  const eritrea = { ...ok, ...Object.fromEntries(IDENTITY.map(k => [k, seed('ERI')[k]])), systemType: 'one-party', elections: [ok.elections[0]] };
  assert.deepEqual(checkRecord(eritrea, TODAY), []);
  assert.match(problems({ status: 'in-flux' }), /needs a reviewNote/);
  assert.match(problems({ legislature: [] }), /legislature needs at least one entry/);
  assert.match(problems({ policies: ['Only one'] }), /at least 2 policies/);
  assert.match(problems({ synopsis: 'A synopsis with <b>markup</b> in it, long enough to pass the length check.' }), /contains HTML/);
  assert.match(problems({ executive: { ...ok.executive, leader: 'headOfGovernment' } }), /presidential/);
  const same = { name: 'One Ruler', title: 'King' };
  assert.match(problems({ systemType: 'absolute-monarchy', executive: { leader: 'headOfGovernment', headOfState: same, headOfGovernment: same, governingParties: [] } }), /both offices/);
  // A monarchy is a ruling monarchy where the map names its monarch or regent, and only there (Jude, 13 November 2026),
  // except for the countries named in MONARCHY_RULE_EXCEPTIONS.
  const monarchy = leader => ({ ...ok.executive, leader, headOfState: { name: 'A Monarch', title: 'King' }, headOfGovernment: { name: 'A Premier', title: 'Prime Minister' } });
  assert.match(problems({ systemType: 'parliamentary-monarchy', executive: monarchy('headOfState') }), /is a ruling monarchy/);
  assert.match(problems({ systemType: 'absolute-monarchy', executive: monarchy('headOfGovernment') }), /names its monarch or regent/);
  assert.deepEqual(checkRecord({ ...ok, systemType: 'parliamentary-monarchy', executive: monarchy('headOfGovernment') }, TODAY), []);
  assert.deepEqual(checkRecord({ ...ok, systemType: 'absolute-monarchy', executive: monarchy('headOfState') }, TODAY), []);
  assert.ok(MONARCHY_RULE_EXCEPTIONS.SAU, 'Saudi Arabia is a named exception');
  assert.deepEqual(checkRecord({ ...ok, iso3: 'SAU', systemType: 'absolute-monarchy', executive: monarchy('headOfGovernment') }, TODAY), []);
  // Create mode's writer is told the rule in one sentence.
  assert.match(createPrompt(schema, TODAY), /A monarchy is a ruling monarchy \("absolute-monarchy"\) where executive\.leader names its\s+monarch or regent, and a "parliamentary-monarchy" where it names the head of government\./);
});

test('pickSeeds chooses by group, by region name or by code, and skips countries that have records', () => {
  assert.deepEqual(pickSeeds(seeds, { region: 'africa-north' }).targets.map(s => s.iso3), ['DZA', 'EGY', 'LBY', 'MAR', 'SDN', 'TUN']);
  assert.equal(pickSeeds(seeds, { region: 'South America' }).targets.length, 12);
  assert.equal(pickSeeds(seeds, { region: 'africa' }).targets.length, 54);
  assert.deepEqual(pickSeeds(seeds, { only: ['BRA', 'ARG'] }).targets.map(s => s.iso3), ['ARG', 'BRA']);
  const { targets, skipped } = pickSeeds(seeds, { region: 'oceania', existing: new Set(['AUS', 'NZL']) });
  assert.deepEqual(skipped.map(s => s.iso3), ['AUS', 'NZL']);
  assert.equal(targets.length, 12);
  assert.deepEqual(pickSeeds(seeds, { region: 'oceania', only: ['FJI', 'FRA'] }).unknown, ['FRA']);
  assert.throws(() => pickSeeds(seeds, { region: 'atlantis' }), /no seeds for region "atlantis"/);
});

test('a create run writes only complete records, in seed order, and adds the new file to the manifest', async () => {
  const dir = await tempData();
  try {
    const before = await readJson(dir, 'manifest.json');
    // Libya's replies never parse and Sudan's is refused: neither may leave anything behind.
    const client = stubClient((params, n, iso) => (iso === 'LBY' ? reply('no record')
      : iso === 'SDN' ? { stop_reason: 'refusal', content: [], usage: {} } : json(draft())));
    const run = await runCreate({ client, dataDir: dir, region: 'africa-north', today: TODAY, log: quiet });
    assert.equal(run.attempted, 6);
    assert.equal(run.created, 4);
    assert.equal(run.failed, 2);
    assert.equal(run.requests, client.calls.length, 'every request is counted');
    assert.equal(run.requests, 4 + 2 + 1, 'one each, two for Libya (one repair), one for Sudan');
    const records = await readJson(dir, 'countries/africa-north.json');
    assert.deepEqual(records.map(r => r.iso3), ['DZA', 'EGY', 'MAR', 'TUN']);
    for (const r of records) {
      assert.ok(validate(r), r.iso3);
      assert.deepEqual(checkRecord(r, TODAY), []);
      for (const k of IDENTITY) assert.equal(r[k], seed(r.iso3)[k]);
    }
    const manifest = await readJson(dir, 'manifest.json');
    assert.deepEqual(manifest.files, [...before.files, 'countries/africa-north.json']);
    assert.equal(manifest.lastUpdated, before.lastUpdated, "the refresh date is the monthly run's, so a create pull request never conflicts with it");
    assert.equal(manifest.updateMethod, before.updateMethod);
    const report = run.report.join('\n');
    assert.match(report, /added: \*\*Algeria\*\*/);
    assert.match(report, /❌ Libya \(LBY\) not created/);
    assert.match(report, /6 attempted, 4 created, 2 failed\./);
    // The file is written in the refresh's two-space form, so the first monthly refresh makes no formatting churn.
    const text = await readFile(path.join(dir, 'countries/africa-north.json'), 'utf8');
    assert.equal(text, JSON.stringify(records, null, 2) + '\n');

    // Running the region again retries only the two that failed, and slots them into seed order.
    const retry = stubClient(() => json(draft()));
    const again = await runCreate({ client: retry, dataDir: dir, region: 'africa-north', today: TODAY, log: quiet });
    assert.deepEqual([again.attempted, again.created, again.failed, again.skipped], [2, 2, 0, 4]);
    assert.deepEqual((await readJson(dir, 'countries/africa-north.json')).map(r => r.iso3), ['DZA', 'EGY', 'LBY', 'MAR', 'SDN', 'TUN']);
    assert.equal((await readJson(dir, 'manifest.json')).files.filter(f => f === 'countries/africa-north.json').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run in which every country fails, or a dry run, writes nothing', async () => {
  const dir = await tempData();
  try {
    const manifest = await readFile(path.join(dir, 'manifest.json'), 'utf8');
    const failing = stubClient(() => reply('nothing'));
    const run = await runCreate({ client: failing, dataDir: dir, only: ['BRA', 'ARG'], today: TODAY, log: quiet });
    assert.deepEqual([run.attempted, run.created, run.failed], [2, 0, 2]);
    assert.equal(await exists(path.join(dir, 'countries/south-america.json')), false);
    const dry = await runCreate({ client: stubClient(() => json(draft())), dataDir: dir, region: 'south-america', dryRun: true, today: TODAY, log: quiet });
    assert.equal(dry.created, 12);
    assert.equal(await exists(path.join(dir, 'countries/south-america.json')), false);
    assert.equal(await readFile(path.join(dir, 'manifest.json'), 'utf8'), manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a create run refuses unknown regions and codes, codes that already have records, and a run with no region', async () => {
  const client = stubClient(() => { throw new Error('no request should be sent'); });
  await assert.rejects(runCreate({ client, dataDir: DATA, region: 'atlantis', log: quiet }), /no seeds for region/);
  await assert.rejects(runCreate({ client, dataDir: DATA, only: ['BRA', 'ZZZ'], log: quiet }), /not in data\/seeds\.json: ZZZ/);
  await assert.rejects(runCreate({ client, dataDir: DATA, log: quiet }), /needs --region/);
  // France already has a record and no seed: create mode never touches existing records.
  await assert.rejects(runCreate({ client, dataDir: DATA, only: ['FRA'], log: quiet }), /not in data\/seeds\.json: FRA/);
  // A whole continent is too large for one run (time limit, review), unless asked for. The copy holds no seed
  // country's record, so the count is the same however many groups have been generated since.
  const dir = await tempData();
  await assert.rejects(runCreate({ client, dataDir: dir, region: 'Africa', log: quiet }), /54 countries is more than one run should create \(at most 20\)/);
  assert.equal(client.calls.length, 0);
  for (const g of new Set(seeds.map(s => s.group))) assert.ok(seeds.filter(s => s.group === g).length <= MAX_CREATE, `group ${g} fits in one run`);
  const big = await runCreate({ client: stubClient(() => json(draft())), dataDir: dir, region: 'Africa', allowLarge: true, dryRun: true, today: TODAY, log: quiet });
  assert.equal(big.created, 54, '--allow-large lets it through (a dry run here, so nothing is written)');
});

/* ------------------------------------------------------------------ sources, notes and cost */

// A reply as the API returns it: a search, its results, then the record and the reviewer's lines.
const searched = (record, after) => ({
  stop_reason: 'end_turn',
  content: [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Ghana president' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [
      { type: 'web_search_result', url: 'https://www.presidency.gov.gh/', title: 'Presidency' },
      { type: 'web_search_result', url: 'https://www.ec.gov.gh/results', title: 'Electoral Commission' }] },
    { type: 'text', text: 'The record.\n```json\n' + JSON.stringify(record, null, 2) + '\n```\n' + after,
      citations: [{ type: 'web_search_result_location', url: 'https://www.parliament.gh/', title: 'Parliament', cited_text: '...' }] }
  ],
  usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } }
});

test('the reviewer\'s lines after the JSON give the leader reason and the sources, kept out of the record', () => {
  const notes = parseNotes('```json\n{"a":1}\n```\nLeader: The president directs the government.\nSource executive: https://a.example/x, https://b.example/y.\nSource elections: none found\n- Source legislature: https://c.example/z');
  assert.equal(notes.leader, 'The president directs the government.');
  assert.deepEqual(notes.sources, { executive: ['https://a.example/x', 'https://b.example/y'], legislature: ['https://c.example/z'] });
  assert.deepEqual(parseNotes('```json\n{"Leader: inside": "https://x.example"}\n```'), { leader: null, sources: {} }, 'nothing is read from inside the JSON');
  const system = createPrompt(schema, TODAY);
  assert.match(system, /give the reason on the "Leader:" line after the code\s+block/);
  assert.match(system, /Source executive:/);
  assert.doesNotMatch(system, /give the reason in one sentence in "reviewNote"/);
});

test('a created country reports its sources, marking any URL the run was never shown, and the run reports its cost', async () => {
  const after = 'Leader: The president heads the executive.\nSource executive: https://www.presidency.gov.gh/ https://made-up.example/\nSource elections: https://www.ec.gov.gh/results';
  const client = stubClient(() => searched(draft(), after));
  const { record, notes, seen, usage } = await createCountry(client, seed('GHA'), { schema, validate, today: TODAY });
  assert.equal(record.reviewNote, undefined, 'the leader reason is not a review note');
  assert.deepEqual(seen, ['https://www.presidency.gov.gh/', 'https://www.ec.gov.gh/results', 'https://www.parliament.gh/']);
  assert.deepEqual(usage, { input_tokens: 1000, output_tokens: 200, searches: 1 });
  const lines = sourceLines(seed('GHA'), record, 'countries/africa-west.json', notes, seen).join('\n');
  assert.match(lines, /added: \*\*Ghana\*\* \(GHA, countries\/africa-west\.json\): Test President, President/);
  assert.match(lines, /Leader: The president heads the executive\./);
  assert.match(lines, /Sources \(executive\): https:\/\/www\.presidency\.gov\.gh\/, https:\/\/made-up\.example\/ \(not among this run's search results\)/);
  assert.match(lines, /Sources \(elections\): https:\/\/www\.ec\.gov\.gh\/results$/m);
  assert.match(sourceLines(seed('GHA'), record, 'f', { sources: {} }, seen).join('\n'), /No source given for the leader: check by hand; the run searched https:\/\/www\.presidency/);
  assert.equal(estimateCost({ input_tokens: 1e6, output_tokens: 1e6, searches: 1000 }), PRICES.inputPerMTok + PRICES.outputPerMTok + 1000 * PRICES.perSearch);
});

test('usage counts every paused segment, and a repair keeps the first reply\'s notes', async () => {
  const after = 'Source executive: https://www.presidency.gov.gh/';
  const client = stubClient((params, n) => (n === 0
    ? { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's0', name: 'web_search', input: { query: 'Ghana' } }], usage: { input_tokens: 500, output_tokens: 50, server_tool_use: { web_search_requests: 2 } } }
    : n === 1 ? searched(draft({ synopsis: 'Too short.' }), after) : json(draft())));
  const { requests, usage, notes } = await createCountry(client, seed('GHA'), { schema, validate, today: TODAY });
  assert.equal(requests, 3);
  assert.deepEqual(usage, { input_tokens: 500 + 1000 + 10, output_tokens: 50 + 200 + 5, searches: 3 });
  assert.deepEqual(notes.sources.executive, ['https://www.presidency.gov.gh/']);
});
