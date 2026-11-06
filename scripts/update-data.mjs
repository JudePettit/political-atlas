#!/usr/bin/env node
/**
 * Data runs for Political Atlas, using Claude with live web search. Run by .github/workflows/monthly-update.yml.
 *
 * Update mode (the default, and the monthly job): for each country profile in data/countries/*.json, asks Claude to
 * verify and update the record, validates the result against data/schema.json, and writes it back.
 *
 * Create mode: for countries listed in data/seeds.json that have no record yet, asks Claude to research and write the
 * complete record from the country's identity (iso3, iso2, numeric, name, region). Each record is checked against the
 * schema and the data tests' rules before it is written; a country that fails is reported and nothing of it is
 * written. Records go to data/countries/<group>.json, and a new file is added to data/manifest.json.
 *
 * Usage:
 *   node scripts/update-data.mjs                                  # update every country that has a record
 *   node scripts/update-data.mjs --only=FRA,SWE                   # update specific countries
 *   node scripts/update-data.mjs --mode=create --region=africa-north   # create one seeds group (or --region=Africa)
 *   node scripts/update-data.mjs --mode=create --only=BRA,ARG     # create specific countries
 *   node scripts/update-data.mjs ... --dry-run                    # don't write files
 *   node scripts/update-data.mjs --mode=create --region=Africa --allow-large   # more than 20 countries in one run
 *
 * --region is a data file's group (e.g. europe-north, africa-east) or a region name (e.g. "South America").
 * Both modes write update-report.md, which becomes the pull request's description.
 * Requires ANTHROPIC_API_KEY (or an `ant auth login` profile).
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL, SEARCHES, IDENTITY, NO_USAGE, compileSchema, updatePrompt, converse, textOf, extractJson, runPool, runCreate, estimateCost, todayISO
} from './research.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : 'true'];
}));
// Blank values (as the workflow passes when an input is left empty) mean "not set".
const listArg = v => (v && v.trim() ? v.toUpperCase().split(',').map(s => s.trim()).filter(Boolean) : null);
const only = listArg(args.only);
const region = args.region && args.region.trim() ? args.region.trim() : null;
const mode = (args.mode || 'update').trim().toLowerCase() || 'update';
const dryRun = args['dry-run'] === 'true';
const allowLarge = args['allow-large'] === 'true';
const today = todayISO();

if (!['update', 'create'].includes(mode)) {
  console.error(`Unknown --mode "${mode}": use update or create.`);
  process.exit(2);
}

const client = new Anthropic();

if (mode === 'create') {
  let result;
  try {
    result = await runCreate({ client, dataDir: DATA, region, only, dryRun, allowLarge, today });
  } catch (err) {
    console.error(err.message);
    await writeFile(path.join(ROOT, 'update-report.md'), `# New country records ${today}\n\nNot run: ${err.message}\n`);
    process.exit(1);
  }
  await writeFile(path.join(ROOT, 'update-report.md'), result.report.join('\n') + '\n');
  console.log(`\nDone: ${result.attempted} attempted, ${result.created} created, ${result.failed} failed, ${result.skipped} skipped; ${result.requests} API requests, about $${result.cost.toFixed(2)} at list prices.`);
  // Fail the job only if nothing could be created, so a partial run still opens its pull request.
  if (result.created === 0 && result.failed > 0) process.exit(1);
  process.exit(0);
}

/* ------------------------------------------------------------------ update mode (the monthly refresh) */

const schema = JSON.parse(await readFile(path.join(DATA, 'schema.json'), 'utf8'));
const validate = compileSchema(schema);
const SYSTEM = updatePrompt(schema, today);

async function refreshCountry(country) {
  const messages = [{
    role: 'user',
    content: `Verify and update this record for ${country.name}:\n\n\`\`\`json\n${JSON.stringify(country, null, 2)}\n\`\`\``
  }];
  const { message, usage } = await converse(client, { system: SYSTEM, messages, maxUses: SEARCHES.update });
  const updated = extractJson(textOf(message));

  // Identity fields are never allowed to change.
  for (const key of IDENTITY) updated[key] = country[key];

  if (!validate(updated)) {
    throw new Error(`schema validation failed: ${validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; ')}`);
  }
  // usage sums every request of the turn, paused segments included.
  return { updated, usage };
}

function summariseChange(before, after) {
  const changes = [];
  const pick = c => ({
    hos: c.executive?.headOfState?.name,
    hog: c.executive?.headOfGovernment?.name,
    leader: c.executive?.leader,
    parties: (c.executive?.governingParties || []).join(', '),
    status: c.status
  });
  const a = pick(before), b = pick(after);
  for (const k of Object.keys(a)) if (a[k] !== b[k]) changes.push(`${k}: "${a[k]}" → "${b[k]}"`);
  return changes;
}

// --region narrows an update to one data file's group (e.g. europe-north) or one region name (e.g. Europe).
const inRegion = (file, c) => !region || path.basename(file, '.json') === region.toLowerCase() || c.region.toLowerCase() === region.toLowerCase();

const manifest = JSON.parse(await readFile(path.join(DATA, 'manifest.json'), 'utf8'));
const report = [`# Data update ${today}`, ''];
let failures = 0, updatedCount = 0, usageTotal = { ...NO_USAGE };

for (const file of manifest.files) {
  const filePath = path.join(DATA, file);
  const countries = JSON.parse(await readFile(filePath, 'utf8'));
  const targets = countries.filter(c => (!only || only.includes(c.iso3)) && inRegion(file, c));
  if (!targets.length) continue;

  await runPool(targets, async country => {
    try {
      const { updated, usage } = await refreshCountry(country);
      countries[countries.findIndex(c => c.iso3 === country.iso3)] = updated;
      updatedCount++;
      for (const k of Object.keys(usageTotal)) usageTotal[k] += usage[k] || 0;
      const changes = summariseChange(country, updated);
      console.log(`✓ ${country.name} (${usage.input_tokens} in / ${usage.output_tokens} out)${changes.length ? ' — ' + changes.join('; ') : ''}`);
      if (changes.length) report.push(`- **${country.name}**: ${changes.join('; ')}`);
      if (updated.reviewNote) report.push(`- ⚠️ ${country.name} needs review: ${updated.reviewNote}`);
    } catch (err) {
      failures++;
      console.error(`✗ ${country.name}: ${err.message}`);
      report.push(`- ❌ ${country.name} not updated: ${err.message}`);
    }
  });

  if (!dryRun) await writeFile(filePath, JSON.stringify(countries, null, 2) + '\n');
}

if (!dryRun && updatedCount) {
  manifest.lastUpdated = today;
  manifest.updateMethod = `Automated refresh with ${MODEL} + web search`;
  await writeFile(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
// Update mode only refreshes records that exist; say so for any code asked for that has none.
const haveRecords = new Set();
for (const file of manifest.files) for (const c of JSON.parse(await readFile(path.join(DATA, file), 'utf8'))) haveRecords.add(c.iso3);
const noRecord = (only || []).filter(code => !haveRecords.has(code));
if (noRecord.length) {
  console.log(`No record to update for ${noRecord.join(', ')}: add new countries with --mode=create.`);
  report.push(`- No record to update for ${noRecord.join(', ')} (new countries are added with create mode).`);
}
report.push('', `${updatedCount} updated, ${failures} failed.`);
await writeFile(path.join(ROOT, 'update-report.md'), report.join('\n') + '\n');
console.log(`\nDone: ${updatedCount} updated, ${failures} failed; the updated countries used ${usageTotal.input_tokens} input and ${usageTotal.output_tokens} output tokens and ${usageTotal.searches} searches, about $${estimateCost(usageTotal).toFixed(2)} at list prices.`);
// Fail the job only if nothing could be updated, so partial refreshes still get committed.
if (updatedCount === 0 && failures > 0) process.exit(1);
