#!/usr/bin/env node
// Validates every country record against data/schema.json and checks for duplicates.
import Ajv from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const schema = JSON.parse(await readFile(path.join(DATA, 'schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const manifest = JSON.parse(await readFile(path.join(DATA, 'manifest.json'), 'utf8'));

const seen = new Set();
let errors = 0, total = 0;
for (const file of manifest.files) {
  for (const c of JSON.parse(await readFile(path.join(DATA, file), 'utf8'))) {
    total++;
    if (seen.has(c.iso3)) { console.error(`Duplicate ${c.iso3} in ${file}`); errors++; }
    seen.add(c.iso3);
    if (!validate(c)) {
      errors++;
      console.error(`${c.iso3 ?? '???'} (${file}): ${validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; ')}`);
    }
  }
}
console.log(`${total} countries checked, ${errors} error(s).`);
process.exit(errors ? 1 : 0);
