/**
 * Shared research code for Political Atlas: the Claude request loop, the prompts, the parsing and the checks used by
 * scripts/update-data.mjs in both of its modes.
 *
 *   update  verifies and refreshes records that already exist (the monthly job).
 *   create  researches a country that has no record yet, from its identity in data/seeds.json, and writes the
 *           complete record to data/countries/<group>.json.
 *
 * Nothing here creates an API client: the caller passes one in, so the tests can run every step against a stub with
 * no network.
 */
import Ajv from 'ajv/dist/2020.js';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export const MODEL = 'claude-opus-5-5';
export const CONCURRENCY = 4;
export const MAX_CONTINUATIONS = 6;
// Web searches allowed per request: a check of a known record needs fewer than a record written from nothing.
export const SEARCHES = { update: 8, create: 14 };
// How many times a create run may send a record's problems back to Claude for a corrected version.
export const MAX_REPAIRS = 1;
// A create run of more countries than this is refused unless asked for (--allow-large): every seeds group fits, and a
// larger run is slower than the job's time limit allows and too long for one review.
export const MAX_CREATE = 20;
// List prices used for the cost estimate printed after each run (US dollars; claude-opus-5-5 and the web search tool,
// as published in October 2026). Check the current price list before relying on the figure.
export const PRICES = { inputPerMTok: 4, outputPerMTok: 20, perSearch: 0.01 };
export const IDENTITY = ['iso3', 'iso2', 'numeric', 'name', 'region'];
// Systems with no national vote to schedule: these may have no upcoming election (Saudi Arabia, the Holy See, juntas).
export const NO_ELECTION_TYPES = ['absolute-monarchy', 'theocratic', 'military', 'transitional'];
export const DATE = /^(\d{4})(-\d{2})?(-\d{2})?$|^TBD$/;

export const todayISO = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ data files */

export async function loadData(dataDir) {
  const read = async p => JSON.parse(await readFile(path.join(dataDir, p), 'utf8'));
  const schema = await read('schema.json');
  const manifest = await read('manifest.json');
  const files = [];
  for (const file of manifest.files) files.push({ file, records: await read(file) });
  let seeds = null;
  try { seeds = await read('seeds.json'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return { schema, manifest, files, seeds };
}

export const compileSchema = schema => new Ajv({ allErrors: true, strict: false }).compile(schema);

// One object per seed, in file order: { group, iso3, iso2, numeric, name, region, qid }.
export function seedRows(seeds) {
  if (!seeds) return [];
  return Object.entries(seeds.groups).flatMap(([group, rows]) =>
    rows.map(row => ({ group, ...Object.fromEntries(seeds.fields.map((f, i) => [f, row[i] ?? null])) })));
}

/**
 * Chooses the seeds a create run should research. `region` is a seeds group (e.g. "africa-east") or a region name
 * from the schema (e.g. "Africa", every group in it); `only` is a list of ISO3 codes. Seeds whose country already has
 * a record are skipped, so a re-run retries only the countries that failed.
 */
export function pickSeeds(rows, { region = null, only = null, existing = new Set() } = {}) {
  let pool = rows;
  if (region) {
    const want = region.trim().toLowerCase();
    pool = rows.filter(r => r.group === want || String(r.region).toLowerCase() === want);
    if (!pool.length) {
      const groups = [...new Set(rows.map(r => r.group))];
      const regions = [...new Set(rows.map(r => r.region))];
      throw new Error(`no seeds for region "${region}": use a group (${groups.join(', ')}) or a region (${regions.join(', ')})`);
    }
  }
  const unknown = [];
  if (only?.length) {
    const codes = new Set(pool.map(r => r.iso3));
    for (const code of only) if (!codes.has(code)) unknown.push(code);
    pool = pool.filter(r => only.includes(r.iso3));
  }
  const skipped = pool.filter(r => existing.has(r.iso3));
  const targets = pool.filter(r => !existing.has(r.iso3));
  return { targets, skipped, unknown };
}

/* ------------------------------------------------------------------ prompts */

// The monthly refresh's instructions, word for word as they were before create mode existed.
export function updatePrompt(schema, today) {
  return `You maintain a factual reference dataset on national political leadership.
You will be given one country's current JSON record. Use web search to verify every fact against reliable,
recent sources (official government and parliament sites, election commissions, Reuters, AP, BBC, major national media).

Update anything that has changed: heads of state and government, governing parties, legislative control and
seat counts, judiciary notes, election results and upcoming election dates, synopsis, policies and challenges.
Rules:
- Today's date is ${today}. Mark elections whose date has passed as "held" and add results in "note".
- Keep at least the most recent held national election and all known upcoming national elections.
- Be neutral and factual. Describe policies and challenges without editorialising or taking sides.
- Keep the synopsis to two or three sentences and policies/challenges to 3-5 short items each.
- Set executive.leader to the office that holds the most power in practice ("headOfGovernment" in parliamentary systems;
  "headOfState" where the president, monarch or party leader directs the government, as in France, Russia or China).
  Change it only when power has really moved, and say why in "reviewNote".
- Set "status" to "in-flux" when a government is being formed, is caretaker, or a national election/count is under way; otherwise "stable".
- Set "lastVerified" to "${today}".
- If you cannot confirm a fact, keep the existing value and explain in "reviewNote". Remove "reviewNote" when everything is confirmed.
- Do not change iso3, iso2, numeric, name or region.
Respond with ONLY the complete updated JSON object in a single \`\`\`json code block, conforming to this schema:
${JSON.stringify(schema)}`;
}

// Instructions for writing a record from nothing. The rules follow the refresh's; where the refresh keeps an existing
// value it cannot confirm, a new record leaves the optional field out and says so in reviewNote.
export function createPrompt(schema, today) {
  return `You research and write records for a factual reference dataset on national political leadership.
You will be given the identity of one country that has no record yet. Use web search to research it from reliable,
recent sources (official government, parliament and election-commission sites; Reuters, AP, AFP, BBC; major national
and regional media; the Inter-Parliamentary Union's Parline for legislatures) and write its complete record.
Rules:
- Today's date is ${today}. Describe the situation as it stands today, and search for changes in recent months
  (elections, coups, resignations, new governments, court rulings) before you rely on an older source.
- executive: the current head of state and head of government, each with name, title, party (left out where they have
  none) and "since" (YYYY-MM-DD, YYYY-MM or YYYY). Where one person holds both offices, give that person in both.
  governingParties lists the parties in government; leave it empty where no party governs (a ruling monarch's
  appointed cabinet, a military government).
- Set executive.leader to the office that holds the most power in practice ("headOfGovernment" in parliamentary systems;
  "headOfState" where the president, monarch, supreme leader, party leader or military ruler directs the government).
  Judge by practice, not by the constitution's wording alone. When the choice is not obvious from the system (a ruling
  monarch beside a prime minister, a supreme leader above a president, a military head of state beside a civilian
  premier, a dominant party leader who holds neither office), give the reason on the "Leader:" line after the code
  block (see the end of these rules), not in "reviewNote".
- legislature: each chamber with its name, who controls it ("control": the party or coalition with a majority, or how
  the members are chosen where there are no parties) and "detail" with seat counts from the latest result. Where there
  is no functioning legislature, give one entry for the body that was dissolved or suspended and say so in "control".
- judiciary: the top courts in one or two sentences, with any notable tension with the other branches.
- elections: the most recent national election held, with its result in "note", and every known upcoming national
  election. Where none is scheduled, give the next one due by law (the year alone is enough); where none is due (an
  absolute monarchy, a military government, the Holy See), give the most recent national vote of any kind (a
  referendum, a local vote, a conclave) with a note that no national election is scheduled. Always give at least one.
  Dates are YYYY-MM-DD, YYYY-MM or YYYY; a date before today is "held", a later one "upcoming".
- Set "systemType" by how power is held in practice (see its description in the schema), and describe the system in
  "system" in a short phrase.
- Set "status" to "in-flux" when a government is being formed, is caretaker, a national election or count is under way,
  or control of the state is contested; otherwise "stable". An in-flux record says why in "reviewNote".
- Be neutral and factual. Describe policies and challenges without editorialising or taking sides. Keep the synopsis
  to two or three sentences and policies and challenges to 3-5 short items each. Plain text only: no links or HTML.
- Disputed status: use the country name you are given. Attribute claims of sovereignty, recognition or territory to
  those who make them, and describe rival or de facto authorities factually (who administers what, who recognises
  whom) without judging their legitimacy. Call people and parties by the names they use, in a common English form.
- Nothing invented. Never guess a name, a date or a seat count. If you cannot confirm a fact, leave the optional field
  out (party, since, detail, note); where the field is required, give what the most reliable sources say and name the
  unconfirmed fact in "reviewNote". "reviewNote" is only for facts that could not be confirmed and for why a record is
  in flux; leave it out when everything is confirmed. The site shows it as "Needs review".
- Set "lastVerified" to "${today}".
- Use exactly the iso3, iso2, numeric, name and region you are given.
Respond with the complete JSON object in a single \`\`\`json code block, conforming to this schema:
${JSON.stringify(schema)}
After the code block, add these plain lines for the person who reviews the record (they are not part of it):
Leader: <when the choice of executive.leader is not obvious from the system, one sentence on why that office holds the
most power in practice; otherwise leave this line out>
Source executive: <the URLs, from your searches, that confirm the head of state and the head of government>
Source elections: <the URLs that confirm the latest result and the next election's date>
Source legislature: <the URLs for the chambers' control and seat counts>
Give only URLs you were shown in search results, separated by spaces.`;
}

/* ------------------------------------------------------------------ notes and sources */

// The URLs a turn was shown by web search, and the ones its text cites, in first-seen order.
export function searchUrls(blocks) {
  const urls = [];
  for (const b of blocks || []) {
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r?.url) urls.push(r.url);
    if (b?.type === 'text') for (const c of b.citations || []) if (c?.url) urls.push(c.url);
  }
  return [...new Set(urls)];
}

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/g;
const cleanUrl = u => u.replace(/[.,;:!?]+$/, '');
/**
 * Reads the reviewer's lines a create reply puts after its JSON block: the reason for the leader choice and the sources
 * for executive, elections and legislature. Returns { leader, sources: { executive: [...], ... } }; missing lines are
 * left out.
 */
export function parseNotes(text) {
  const after = String(text || '').replace(/```json[\s\S]*?```/, '');
  const notes = { leader: null, sources: {} };
  for (const line of after.split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*(Leader|Source (executive|elections|legislature))\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    if (!m[2]) { if (m[3].trim()) notes.leader = m[3].trim(); continue; }
    const urls = [...new Set((m[3].match(URL_RE) || []).map(cleanUrl))];
    if (urls.length) notes.sources[m[2].toLowerCase()] = urls;
  }
  return notes;
}

/** The cost of a run's usage at list prices (US dollars). */
export const estimateCost = (u, p = PRICES) => (u.input_tokens * p.inputPerMTok + u.output_tokens * p.outputPerMTok) / 1e6 + (u.searches || 0) * p.perSearch;
const addUsage = (a, m) => ({
  input_tokens: a.input_tokens + (m?.input_tokens || 0),
  output_tokens: a.output_tokens + (m?.output_tokens || 0),
  searches: a.searches + (m?.server_tool_use?.web_search_requests || m?.searches || 0)
});
export const NO_USAGE = Object.freeze({ input_tokens: 0, output_tokens: 0, searches: 0 });

export function createRequest(seed) {
  const identity = Object.fromEntries(IDENTITY.map(k => [k, seed[k]]));
  return `Research and write a complete record for ${seed.name} (${seed.iso3}), with these identity fields:\n\n` +
    `\`\`\`json\n${JSON.stringify(identity, null, 2)}\n\`\`\``;
}

/* ------------------------------------------------------------------ requests */

/**
 * Sends one turn and follows pause_turn continuations. Returns the final message, how many requests it took, the usage
 * of every request (a paused segment is billed too, so the final message's usage alone undercounts) and the content of
 * every segment (where the search results are). The request settings are the monthly refresh's; only the number of web
 * searches differs between modes.
 */
export async function converse(client, { system, messages, maxUses }) {
  let message, requests = 0, usage = { ...NO_USAGE };
  const blocks = [];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }],
      messages
    });
    message = await stream.finalMessage();
    requests++;
    usage = addUsage(usage, message.usage);
    blocks.push(...(message.content || []));
    // Long server-tool turns can pause; append the partial turn and resume.
    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }
  const fail = text => Object.assign(new Error(text), { requests, usage });
  if (message.stop_reason === 'refusal') throw fail(`refused (${message.stop_details?.category ?? 'unknown'})`);
  if (message.stop_reason === 'max_tokens') throw fail('response truncated (max_tokens)');
  if (message.stop_reason === 'pause_turn') throw fail('still paused after max continuations');
  return { message, requests, usage, blocks };
}

export const textOf = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

export function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ checks */

/**
 * The checks a record must pass beyond the schema, the same ones tests/data.test.mjs makes of the whole dataset, so a
 * created record can never turn the tests red. Returns a list of problems (empty when the record is fine).
 */
export function checkRecord(c, today = todayISO()) {
  const problems = [];
  const ex = c.executive || {};
  if (!ex[ex.leader]?.name) problems.push('executive.leader must name an office that has a person in it');
  if (ex.headOfState && ex.headOfGovernment) {
    const same = ex.headOfState.name === ex.headOfGovernment.name;
    if ((same || c.systemType === 'presidential') && ex.leader !== 'headOfState') {
      problems.push('executive.leader must be "headOfState" when one person holds both offices or the system is presidential');
    }
  }
  if (c.systemType === 'dependent-territory' && ex.leader !== 'headOfGovernment') {
    problems.push('executive.leader must be "headOfGovernment" for a dependent territory');
  }
  if (!c.legislature?.length) problems.push('legislature needs at least one entry (say so in "control" where none sits)');
  const elections = c.elections || [];
  if (!elections.length) problems.push('elections needs at least one entry');
  for (const e of elections) {
    if (!DATE.test(e.date)) { problems.push(`election "${e.name}": date "${e.date}" is not YYYY-MM-DD, YYYY-MM or YYYY`); continue; }
    const full = e.date.length === 10 ? e.date : null;
    if (full && e.status === 'upcoming' && full < today) problems.push(`election "${e.name}": "upcoming" but ${full} has passed`);
    if (full && e.status === 'held' && full > today) problems.push(`election "${e.name}": "held" but ${full} is in the future`);
  }
  if (elections.length && !elections.some(e => e.status === 'upcoming') && !NO_ELECTION_TYPES.includes(c.systemType)) {
    problems.push(`no upcoming national election: give the next one due (the year is enough), or a systemType of ${NO_ELECTION_TYPES.join(', ')} where none is due`);
  }
  if (c.status === 'in-flux' && !c.reviewNote) problems.push('an in-flux record needs a reviewNote saying why');
  if ((c.synopsis || '').length < 60) problems.push('synopsis is too short (two or three sentences)');
  if ((c.policies || []).length < 2 || (c.challenges || []).length < 2) problems.push('give at least 2 policies and 2 challenges (3-5 each)');
  if (/<[a-z]/i.test(JSON.stringify(c))) problems.push('contains HTML; use plain text');
  return problems;
}

const schemaProblems = validate => validate.errors.map(e => `${e.instancePath || '(record)'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);

/**
 * Researches one country from its seed and returns a complete, validated record. Identity fields are forced from the
 * seed and lastVerified is the run's date. If the reply cannot be parsed or fails a check, the problems go back to
 * Claude once for a corrected record; a record that still fails throws, so nothing partial is ever returned.
 */
export async function createCountry(client, seed, { schema, validate, today = todayISO(), system = createPrompt(schema, today) }) {
  const messages = [{ role: 'user', content: createRequest(seed) }];
  let requests = 0, usage = { ...NO_USAGE }, seen = [], notes = { leader: null, sources: {} };
  for (let attempt = 0; ; attempt++) {
    let turn;
    try {
      turn = await converse(client, { system, messages, maxUses: SEARCHES.create });
    } catch (err) {
      // Count the requests (and tokens) a failed turn used, for the run's totals (converse makes at least one).
      err.requests = requests + (err.requests || 1);
      err.usage = addUsage(usage, err.usage);
      throw err;
    }
    requests += turn.requests;
    usage = addUsage(usage, turn.usage);
    seen = [...new Set([...seen, ...searchUrls(turn.blocks)])];
    // A repair reply may carry only the JSON: keep the first reply's notes where the repair gives none.
    const n = parseNotes(textOf(turn.message));
    notes = { leader: n.leader || notes.leader, sources: { ...notes.sources, ...n.sources } };
    let record, problems;
    try {
      record = extractJson(textOf(turn.message));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('the reply is not a JSON object');
    } catch (err) {
      problems = [`the reply could not be read as one JSON object (${err.message})`];
    }
    if (record) {
      for (const key of IDENTITY) record[key] = seed[key];
      record.lastVerified = today;
      problems = validate(record) ? checkRecord(record, today) : schemaProblems(validate);
    }
    if (!problems.length) return { record, requests, usage, notes, seen };
    if (attempt >= MAX_REPAIRS) {
      const err = new Error(`${problems.join('; ')} (after ${requests} request${requests === 1 ? '' : 's'})`);
      err.requests = requests;
      err.usage = usage;
      throw err;
    }
    messages.push({ role: 'assistant', content: turn.message.content });
    messages.push({
      role: 'user',
      content: `The record failed these checks:\n${problems.map(p => `- ${p}`).join('\n')}\n\n` +
        'Fix them, searching again only if a fact needs it, and reply with ONLY the complete corrected JSON object in a single ```json code block.'
    });
  }
}

export async function runPool(items, worker, size = CONCURRENCY) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

/* ------------------------------------------------------------------ create run */

const exists = p => access(p).then(() => true, () => false);

/**
 * Creates records for the seeds a run picks (see pickSeeds) and writes each one as soon as it is ready, so a run that
 * stops part-way keeps the countries it finished. Each record goes to data/countries/<group>.json, in seed order, in
 * the refresh's two-space form; a group's file is created, and added to manifest.json, only when its first record is
 * ready. With dryRun nothing is written. Returns the counts and the lines for update-report.md.
 */
export async function runCreate({ client, dataDir, region = null, only = null, dryRun = false, allowLarge = false, today = todayISO(), log = console }) {
  const { schema, manifest, files, seeds } = await loadData(dataDir);
  if (!seeds) throw new Error('data/seeds.json is missing');
  // One region (or a list of countries) per run keeps each pull request reviewable and each run inside its time limit.
  if (!region && !only?.length) throw new Error('create mode needs --region (a seeds group such as africa-east, or a region name) or --only');
  const validate = compileSchema(schema);
  const system = createPrompt(schema, today);
  const rows = seedRows(seeds);
  const existing = new Set(files.flatMap(f => f.records.map(r => r.iso3)));

  // A group file left on disk but not yet in the manifest still counts, so its records are neither lost nor duplicated.
  const groupFile = group => `countries/${group}.json`;
  const groups = new Map();
  for (const group of new Set(rows.map(r => r.group))) {
    const file = groupFile(group);
    const listed = files.find(f => f.file === file);
    let records = listed?.records;
    if (!records && await exists(path.join(dataDir, file))) records = JSON.parse(await readFile(path.join(dataDir, file), 'utf8'));
    for (const r of records || []) existing.add(r.iso3);
    groups.set(group, { file, records: records ? [...records] : [], listed: !!listed });
  }

  const { targets, skipped, unknown } = pickSeeds(rows, { region, only, existing });
  if (unknown.length) throw new Error(`not in data/seeds.json${region ? ` for "${region}"` : ''}: ${unknown.join(', ')}`);
  if (targets.length > MAX_CREATE && !allowLarge) {
    throw new Error(`${targets.length} countries is more than one run should create (at most ${MAX_CREATE}): use one seeds group (${[...new Set(targets.map(t => t.group))].join(', ')}), or pass --allow-large`);
  }

  const order = new Map(rows.map((r, i) => [r.iso3, i]));
  let saving = Promise.resolve();
  const save = group => {
    saving = saving.then(async () => {
      const g = groups.get(group);
      g.records.sort((a, b) => (order.get(a.iso3) ?? -1) - (order.get(b.iso3) ?? -1));
      await writeFile(path.join(dataDir, g.file), JSON.stringify(g.records, null, 2) + '\n');
      // Only the new file is added. lastUpdated and updateMethod belong to the monthly refresh: leaving them alone keeps
      // a create pull request and an open monthly one from conflicting on the same lines (each new record carries its
      // own lastVerified).
      if (!manifest.files.includes(g.file)) {
        manifest.files.push(g.file);
        await writeFile(path.join(dataDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      }
    });
    return saving;
  };

  const report = [`# New country records ${today}`, ''];
  const result = { attempted: targets.length, created: 0, failed: 0, skipped: skipped.length, requests: 0, usage: { ...NO_USAGE }, cost: 0, report };
  if (skipped.length) log.log(`Already have records, skipped: ${skipped.map(s => s.iso3).join(', ')}`);

  await runPool(targets, async seed => {
    try {
      const { record, requests, usage, notes, seen } = await createCountry(client, seed, { schema, validate, today, system });
      result.requests += requests;
      result.usage = addUsage(result.usage, usage);
      result.created++;
      groups.get(seed.group).records.push(record);
      if (!dryRun) await save(seed.group);
      log.log(`✓ ${seed.name} (${requests} request${requests === 1 ? '' : 's'}, ${usage.input_tokens} in / ${usage.output_tokens} out, ${usage.searches} searches)`);
      report.push(...sourceLines(seed, record, groups.get(seed.group).file, notes, seen));
    } catch (err) {
      result.failed++;
      result.requests += err.requests || 0;
      if (err.usage) result.usage = addUsage(result.usage, err.usage);
      log.error(`✗ ${seed.name}: ${err.message}`);
      report.push(`- ❌ ${seed.name} (${seed.iso3}) not created: ${err.message}`);
    }
  });
  await saving;

  result.cost = estimateCost(result.usage);
  if (skipped.length) report.push(`- Skipped, already in the atlas: ${skipped.map(s => s.name).join(', ')}`);
  report.push('', `${result.attempted} attempted, ${result.created} created, ${result.failed} failed${skipped.length ? `, ${skipped.length} skipped` : ''}.`);
  report.push(`Usage: ${result.requests} requests, ${result.usage.input_tokens} input and ${result.usage.output_tokens} output tokens, ${result.usage.searches} web searches; about $${result.cost.toFixed(2)} at list prices.`);
  if (result.failed) report.push('', 'To retry the failed countries, merge (or close) this pull request first, then run create mode again for the same region: countries that already have a record are skipped.');
  return result;
}

/**
 * The report lines for one added country: who leads it, why that office where it is not obvious, and the sources the
 * reviewer can check the names and dates against. A URL Claude gives that was not among the run's search results is
 * marked, and a country with no source for its leader says so.
 */
export function sourceLines(seed, record, file, notes = { sources: {} }, seen = []) {
  const who = record.executive[record.executive.leader];
  const lines = [`- added: **${seed.name}** (${seed.iso3}, ${file}): ${who.name}, ${who.title}`];
  if (notes.leader) lines.push(`  - Leader: ${notes.leader}`);
  const shown = new Set(seen);
  for (const part of ['executive', 'elections', 'legislature']) {
    const urls = notes.sources?.[part] || [];
    if (urls.length) lines.push(`  - Sources (${part}): ${urls.map(u => (shown.has(u) ? u : `${u} (not among this run's search results)`)).join(', ')}`);
    else if (part === 'executive') lines.push(`  - ⚠️ No source given for the leader: check by hand${seen.length ? `; the run searched ${seen.slice(0, 5).join(', ')}` : ''}`);
  }
  if (record.reviewNote) lines.push(`  - ⚠️ Needs review: ${record.reviewNote}`);
  return lines;
}
