#!/usr/bin/env node
/**
 * Monthly data refresh for Political Atlas.
 *
 * For each country profile in data/countries/*.json, asks Claude (with live web
 * search) to verify and update the record, validates the result against
 * data/schema.json, and writes it back. Run by .github/workflows/monthly-update.yml.
 *
 * Usage:
 *   node scripts/update-data.mjs                 # update every country
 *   node scripts/update-data.mjs --only=FRA,SWE  # update specific countries
 *   node scripts/update-data.mjs --dry-run       # don't write files
 *
 * Requires ANTHROPIC_API_KEY (or an `ant auth login` profile).
 */
import Anthropic from '@anthropic-ai/sdk';
import Ajv from 'ajv/dist/2020.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MODEL = 'claude-opus-5-5';
const CONCURRENCY = 4;
const MAX_CONTINUATIONS = 6;

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const only = args.only ? new Set(args.only.toUpperCase().split(',')) : null;
const dryRun = args['dry-run'] === 'true';

const client = new Anthropic();
const schema = JSON.parse(await readFile(path.join(DATA, 'schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const today = new Date().toISOString().slice(0, 10);

const SYSTEM = `You maintain a factual reference dataset on national political leadership.
You will be given one country's current JSON record. Use web search to verify every fact against reliable,
recent sources (official government and parliament sites, election commissions, Reuters, AP, BBC, major national media).

Update anything that has changed: heads of state and government, governing parties, legislative control and
seat counts, judiciary notes, election results and upcoming election dates, synopsis, policies and challenges.
Rules:
- Today's date is ${today}. Mark elections whose date has passed as "held" and add results in "note".
- Keep at least the most recent held national election and all known upcoming national elections.
- Be neutral and factual. Describe policies and challenges without editorialising or taking sides.
- Keep the synopsis to two or three sentences and policies/challenges to 3-5 short items each.
- Set "status" to "in-flux" when a government is being formed, is caretaker, or a national election/count is under way; otherwise "stable".
- Set "lastVerified" to "${today}".
- If you cannot confirm a fact, keep the existing value and explain in "reviewNote". Remove "reviewNote" when everything is confirmed.
- Do not change iso3, iso2, numeric, name or region.
Respond with ONLY the complete updated JSON object in a single \`\`\`json code block, conforming to this schema:
${JSON.stringify(schema)}`;

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

async function refreshCountry(country) {
  const messages = [{
    role: 'user',
    content: `Verify and update this record for ${country.name}:\n\n\`\`\`json\n${JSON.stringify(country, null, 2)}\n\`\`\``
  }];

  let message;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages
    });
    message = await stream.finalMessage();
    // Long server-tool turns can pause; append the partial turn and resume.
    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }

  if (message.stop_reason === 'refusal') throw new Error(`refused (${message.stop_details?.category ?? 'unknown'})`);
  if (message.stop_reason === 'max_tokens') throw new Error('response truncated (max_tokens)');
  if (message.stop_reason === 'pause_turn') throw new Error('still paused after max continuations');

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const updated = extractJson(text);

  // Identity fields are never allowed to change.
  for (const key of ['iso3', 'iso2', 'numeric', 'name', 'region']) updated[key] = country[key];

  if (!validate(updated)) {
    throw new Error(`schema validation failed: ${validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; ')}`);
  }
  return { updated, usage: message.usage };
}

function summariseChange(before, after) {
  const changes = [];
  const pick = c => ({
    hos: c.executive.headOfState.name,
    hog: c.executive.headOfGovernment.name,
    parties: c.executive.governingParties.join(', '),
    status: c.status
  });
  const a = pick(before), b = pick(after);
  for (const k of Object.keys(a)) if (a[k] !== b[k]) changes.push(`${k}: "${a[k]}" → "${b[k]}"`);
  return changes;
}

async function runPool(items, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

const manifest = JSON.parse(await readFile(path.join(DATA, 'manifest.json'), 'utf8'));
const report = [`# Data update ${today}`, ''];
let failures = 0, updatedCount = 0;

for (const file of manifest.files) {
  const filePath = path.join(DATA, file);
  const countries = JSON.parse(await readFile(filePath, 'utf8'));
  const targets = countries.filter(c => !only || only.has(c.iso3));
  if (!targets.length) continue;

  await runPool(targets, async country => {
    try {
      const { updated, usage } = await refreshCountry(country);
      countries[countries.findIndex(c => c.iso3 === country.iso3)] = updated;
      updatedCount++;
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
report.push('', `${updatedCount} updated, ${failures} failed.`);
await writeFile(path.join(ROOT, 'update-report.md'), report.join('\n') + '\n');
console.log(`\nDone: ${updatedCount} updated, ${failures} failed.`);
// Fail the job only if nothing could be updated, so partial refreshes still get committed.
if (updatedCount === 0 && failures > 0) process.exit(1);
