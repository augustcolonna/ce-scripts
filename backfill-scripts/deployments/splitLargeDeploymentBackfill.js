#!/usr/bin/env node
/**
 * CSV Splitter by Environment (JavaScript / ESM)
 *
 * Reads an input CSV and writes one CSV per unique value in a chosen column
 * (defaults to `environment`). Files are saved into an output directory with
 * safe, sanitized filenames.
 *
 * Usage:
 *   node splitLargeDeploymentBackfill.js \
 *     --input ./Paddle.csv \
 *     --out ./split_envs \
 *     --column environment \
 *     [--delimiter ,] [--safe-names] [--overwrite] [--dry-run]
 *
 * Environment variables (optional; CLI flags override when provided):
 *   INPUT_FILE      Path to input CSV (default: ./Paddle.csv)
 *   OUTPUT_DIR      Directory to write split CSVs (default: ./split_envs)
 *   SPLIT_COLUMN    Column name to split on (default: environment)
 *   CSV_DELIMITER   CSV delimiter (default: ,)
 *   SAFE_NAMES      'true' to sanitize filenames (default: true)
 *   OVERWRITE       'true' to overwrite existing files (default: false)
 *   DRY_RUN         'true' to preview without writing files
 *
 * Dependencies:
 *   npm i csv-parse csv-stringify
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';

// --------------------------- Helpers ---------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    let val = 'true';
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
    out[key] = val;
  }
  return out;
}

function toBool(val, def = false) {
  if (val === undefined || val === null) return def;
  const s = String(val).trim().toLowerCase();
  return ['1','true','t','yes','y'].includes(s);
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitize(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'undefined';
  return s.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
}

// --------------------------- Config ----------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARGS = parseArgs(process.argv);
const INPUT_FILE = ARGS.input || process.env.INPUT_FILE || path.resolve(process.cwd(), 'Paddle.csv');
const OUTPUT_DIR = ARGS.out || process.env.OUTPUT_DIR || path.resolve(process.cwd(), 'split_envs');
const SPLIT_COLUMN = ARGS.column || process.env.SPLIT_COLUMN || 'environment';
const CSV_DELIMITER = (ARGS.delimiter || process.env.CSV_DELIMITER || ',');
const SAFE_NAMES = toBool(ARGS['safe-names'] ?? process.env.SAFE_NAMES, true);
const OVERWRITE = toBool(ARGS.overwrite ?? process.env.OVERWRITE, false);
const DRY_RUN = toBool(ARGS['dry-run'] ?? process.env.DRY_RUN, false);

if (!fs.existsSync(INPUT_FILE)) {
  log(`Input CSV not found: ${INPUT_FILE}`);
  process.exit(1);
}

ensureDir(OUTPUT_DIR);

// --------------------------- Main ------------------------------
const envBuckets = new Map(); // env -> rows
let headers = [];

const parser = parse({ columns: true, skip_empty_lines: true, delimiter: CSV_DELIMITER });

fs.createReadStream(INPUT_FILE)
  .pipe(parser)
  .on('data', (row) => {
    if (headers.length === 0) headers = Object.keys(row);
    const env = (row[SPLIT_COLUMN] ?? '').toString().trim() || 'undefined';
    const key = SAFE_NAMES ? sanitize(env) : env;
    if (!envBuckets.has(key)) envBuckets.set(key, []);
    envBuckets.get(key).push(row);
  })
  .on('end', () => {
    if (DRY_RUN) {
      for (const [env, rows] of envBuckets.entries()) {
        const fileName = `${env || 'undefined'}.csv`;
        const outputFilePath = path.join(OUTPUT_DIR, fileName);
        log(`[DRY_RUN] Would write ${rows.length} rows to ${outputFilePath}`);
      }
      log('DRY_RUN complete. No files written.');
      return;
    }

    for (const [env, rows] of envBuckets.entries()) {
      const fileName = `${env || 'undefined'}.csv`;
      const outputFilePath = path.join(OUTPUT_DIR, fileName);
      if (fs.existsSync(outputFilePath) && !OVERWRITE) {
        log(`Skip (exists): ${outputFilePath} (use --overwrite to replace)`);
        continue;
      }
      const csvContent = stringify(rows, { header: true, columns: headers, delimiter: CSV_DELIMITER });
      fs.writeFileSync(outputFilePath, csvContent);
      console.log(`✅ Wrote ${rows.length} rows to ${outputFilePath}`);
    }

    console.log('✅ All environments processed.');
  })
  .on('error', (err) => {
    console.error('Error while reading CSV:', err?.message || err);
    process.exit(1);
  });
