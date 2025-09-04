#!/usr/bin/env node
/**
 * DX Incidents Importer (JavaScript / ESM)
 *
 * Reads an input CSV and POSTs each row to the DX incidents sync endpoint.
 * Normalizes timestamps to ISO-8601 (with trailing 'Z' when appropriate)
 * and parses the `services` column from JSON or delimited text.
 *
 * Usage:
 *   node incidents_import.mjs \
 *     --input "./1 - Critical.csv" \
 *     --api-url https://yourinstance.getdx.net/api/incidents.sync \
 *     --token <DX_TOKEN> \
 *     [--rps 10] [--dry-run]
 *
 * Environment variables (CLI flags override):
 *   INPUT_FILE      Path to CSV (default: ./1 - Critical.csv)
 *   API_URL         DX endpoint (default: https://yourinstance.getdx.net/api/incidents.sync)
 *   DX_TOKEN        Bearer token for DX API
 *   RPS             Requests per second throttle (default: 10)
 *   DRY_RUN         'true' to print requests without calling the API
 *
 * CSV expectations (headers are case-insensitive):
 *   reference_id (required)
 *   source_name  (optional, default 'incident_io')
 *   priority, name (optional)
 *   started_at, resolved_at (optional; formats accepted: 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM:SS', 'YYYY-MM-DDTHH:MM:SS', '...Z', or with offset)
 *   source_url (optional)
 *   services (optional; JSON array string or delimited list by comma/semicolon/pipe)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARGS = parseArgs(process.argv);

const INPUT_FILE = path.resolve(process.cwd(), ARGS.input || process.env.INPUT_FILE || '1 - Critical.csv');
const API_URL = ARGS['api-url'] || process.env.API_URL || 'https://yourinstance.getdx.net/api/incidents.sync';
const DX_TOKEN = ARGS.token || process.env.DX_TOKEN || '';
const RPS = Number(ARGS.rps || process.env.RPS || 10);
const DRY_RUN = toBool(ARGS['dry-run'] ?? process.env.DRY_RUN, false);

if (!fs.existsSync(INPUT_FILE)) {
  console.error(`CSV not found: ${INPUT_FILE}`);
  process.exit(1);
}
if (!DX_TOKEN && !DRY_RUN) {
  console.error('Missing DX token. Provide --token or set DX_TOKEN, or use --dry-run.');
  process.exit(1);
}

// --------------------------- Utilities -----------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Use global fetch if available (Node >=18), else dynamic import
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function normalizeHeaders(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[String(k || '').trim().toLowerCase()] = v;
  return out;
}

function toIso8601Z(val) {
  if (val == null) return undefined;
  const v = String(val).trim();
  if (!v) return undefined;
  // Already has timezone (Z or offset) -> return as-is
  if (/t/i.test(v) && (/[zZ]$/.test(v) || /[+-]\d{2}:?\d{2}$/.test(v))) return v;
  // "YYYY-MM-DD HH:MM:SS(.sss)?" -> replace space with 'T' and append Z
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v)) return v.replace(' ', 'T') + 'Z';
  // "YYYY-MM-DD" -> pad seconds and Z
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00Z';
  // "YYYY-MM-DDTHH:MM:SS(.sss)?" without timezone -> append Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i.test(v)) return v + 'Z';
  // "YYYY-MM-DD HH:MM" -> pad seconds and Z
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return v.replace(' ', 'T') + ':00Z';
  // "YYYY-MM-DDTHH:MM" -> pad seconds and Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/i.test(v)) return v + ':00Z';
  return v; // last resort, send as provided
}

function parseServices(val) {
  if (!val) return [];
  const s = String(val).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { const j = JSON.parse(s); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  // split by comma / semicolon / pipe
  return s.split(/[;,|]/).map(x => x.trim()).filter(Boolean);
}

function buildPayload(row) {
  const r = normalizeHeaders(row);
  return {
    reference_id: r.reference_id,
    source_name: r.source_name || 'incident_io',
    priority: r.priority,
    name: r.name,
    started_at: toIso8601Z(r.started_at),
    resolved_at: toIso8601Z(r.resolved_at),
    source_url: r.source_url || '',
    services: parseServices(r.services),
  };
}

// ----------------------------- Main --------------------------------
(async function main() {
  log(`Reading CSV: ${INPUT_FILE}`);

  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(INPUT_FILE)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  log(`Total rows to process: ${rows.length}`);
  const delayMs = Math.max(0, Math.floor(1000 / Math.max(1, RPS)));

  for (const row of rows) {
    const payload = buildPayload(row);
    console.log('Request Body:', JSON.stringify(payload));

    try {
      if (DRY_RUN) {
        log('[DRY_RUN] Skipping POST');
      } else {
        const resp = await _fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DX_TOKEN}` },
          body: JSON.stringify(payload),
        });
        const text = await resp.text();
        if (resp.ok) console.log('✅ Success:', text.slice(0, 300));
        else console.error(`❌ Failed (${resp.status}):`, text.slice(0, 300));
      }
    } catch (err) {
      console.error('❌ Error:', err?.message || err);
    }

    await sleep(delayMs);
  }

  console.log('🎉 CSV file successfully processed');
})();
