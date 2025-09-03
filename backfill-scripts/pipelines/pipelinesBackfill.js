#!/usr/bin/env node
/**
 * DX Pipeline Runs Importer (JavaScript / ESM)
 *
 * Reads one or more CSV files from a directory and POSTs each row to the
 * DX Pipeline Runs sync endpoint.
 *
 * Usage:
 *   node pipelinesBackfill.js \
 *     --dir ./Backfill \
 *     --api-url https://yourinstance.getdx.net/api/pipelineRuns.sync \
 *     --token <DX_TOKEN> \
 *     [--rps 7] [--dry-run] [--failures ./pipeline_import_failures.csv]
 *
 * Environment variables (CLI flags override):
 *   DIRECTORY           Path to directory containing CSV chunks (default: ./Backfill)
 *   API_URL             DX API endpoint (default: https://yourinstance.getdx.net/api/pipelineRuns.sync)
 *   DX_TOKEN            Bearer token for DX API
 *   RPS                 Requests per second throttle (default: 7)
 *   FAILURE_LOG_FILE    Path for CSV failure log (default: ./pipeline_import_failures.csv)
 *
 * File ordering:
 *   Files are sorted numerically by the first number in their filename (e.g. chunk_1.csv, chunk_2.csv ...).
 *
 * Failure logging:
 *   On any non-2xx, a row is appended to FAILURE_LOG_FILE with: file, reference_id, error_message, payload.
 *
 * Dependencies:
 *   npm i csv-parse csv-stringify
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';

// --------------------------- CLI & Config ---------------------------
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

function toBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return ['1','true','t','yes','y'].includes(s);
}

const ARGS = parseArgs(process.argv);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIRECTORY = path.resolve(process.cwd(), ARGS.dir || process.env.DIRECTORY || './Backfill');
const API_URL = ARGS['api-url'] || process.env.API_URL || 'https://yourinstance.getdx.net/api/pipelineRuns.sync';
const DX_TOKEN = ARGS.token || process.env.DX_TOKEN || '';
const RPS = Number(ARGS.rps || process.env.RPS || 7);
const FAILURE_LOG_FILE = path.resolve(process.cwd(), ARGS.failures || process.env.FAILURE_LOG_FILE || './pipeline_import_failures.csv');
const DRY_RUN = toBool(ARGS['dry-run'] ?? process.env.DRY_RUN, false);

if (!DX_TOKEN && !DRY_RUN) {
  console.error('Missing DX token. Provide --token or set DX_TOKEN, or use --dry-run.');
  process.exit(1);
}

if (!fs.existsSync(DIRECTORY)) {
  console.error(`Directory not found: ${DIRECTORY}`);
  process.exit(1);
}

// --------------------------- Helpers -------------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function numericSortFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(name => ({ name, number: Number((name.match(/\d+/) || ['0'])[0]) }))
    .sort((a, b) => a.number - b.number)
    .map(x => path.join(dir, x.name));
}

function ensureFailureLogHeader(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    const header = stringify([[ 'file', 'reference_id', 'error_message', 'payload' ]], { header: false });
    fs.appendFileSync(file, header, 'utf8');
  }
}

function appendFailure(file, row) {
  ensureFailureLogHeader(file);
  const line = stringify([[ row.file, row.reference_id, row.error_message, row.payload ]], { header: false });
  fs.appendFileSync(file, line, 'utf8');
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? undefined : n;
}

function buildPayload(row) {
  return {
    pipeline_name: row.pipeline_name,
    pipeline_source: row.pipeline_source,
    reference_id: row.reference_id,
    started_at: toIntOrNull(row.started_at),
    finished_at: toIntOrNull(row.finished_at),
    status: row.status || 'unknown',
    repository: row.repository || undefined,
    commit_sha: row.commit_sha || undefined,
    pr_number: row.pr_number || undefined,
    head_branch: row.head_branch || undefined,
    email: row.email || undefined,
  };
}

async function postDX(payload) {
  if (DRY_RUN) { log(`[DRY_RUN] POST ${API_URL} -> ${JSON.stringify(payload)}`); return { ok: true, status: 0, body: 'DRY_RUN' }; }
  const resp = await _fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DX_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, body: text };
}

async function readCsv(filePath) {
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });
  return rows;
}

// ----------------------------- Main --------------------------------
(async function main() {
  const files = numericSortFiles(DIRECTORY);
  if (files.length === 0) {
    console.log('⚠️  No CSV files found.');
    return;
  }

  log(`📄 Queue: ${files.length} CSV file(s) to process.`);
  const delayMs = Math.max(0, Math.floor(1000 / Math.max(1, RPS)));

  for (const file of files) {
    log(`📂 Processing file: ${file}`);
    const records = await readCsv(file);

    for (const record of records) {
      const payload = buildPayload(record);
      try {
        const { ok, status, body } = await postDX(payload);
        if (ok) {
          console.log(`✅ Success: ${payload.reference_id}`);
        } else {
          const msg = body?.slice ? body.slice(0, 300) : String(body);
          console.error(`❌ Failed: ${payload.reference_id} - ${msg}`);
          appendFailure(FAILURE_LOG_FILE, {
            file: path.basename(file),
            reference_id: payload.reference_id,
            error_message: msg,
            payload: JSON.stringify(payload),
          });
        }
      } catch (e) {
        const msg = e?.message || String(e);
        console.error(`❌ Failed: ${payload.reference_id} - ${msg}`);
        appendFailure(FAILURE_LOG_FILE, {
          file: path.basename(file),
          reference_id: payload.reference_id,
          error_message: msg,
          payload: JSON.stringify(payload),
        });
      }

      await sleep(delayMs); // throttle
    }
  }

  console.log('🎉 All chunks processed.');
})();
