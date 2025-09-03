#!/usr/bin/env node
/**
 * Tabnine Usage Importer (JavaScript / ESM)
 *
 * Fetches Tabnine Enterprise usage metrics and inserts them into a Postgres table.
 *
 * Usage:
 *   node DxTabnineAutomation.js [--dry-run] [--chunk-size 100] [--db <url>] [--api-key <key>]
 *
 * Environment variables (preferred; CLI flags override when provided):
 *   DX_DB_CONNECTION   (required) Postgres connection string
 *   TABNINE_API_KEY    (required) Tabnine Enterprise API key
 *   DRY_RUN            (optional) 'true' to build SQL but skip DB writes
 *   CHUNK_SIZE         (optional) batch size for inserts (default: 100)
 *
 * Behavior:
 *   - Pulls usage from https://api.tabnine.com/enterprise/usage (single request).
 *   - Normalizes date to 'yyyy-MM-dd'.
 *   - Inserts into custom.tabnine_daily_usages in CHUNK_SIZE batches.
 *   - If --dry-run (or DRY_RUN=true), logs what would be inserted and skips DB writes.
 */

import fs from 'fs';
import dotenv from 'dotenv';
import { Client } from 'pg';
import axios from 'axios';
import { parseISO, format } from 'date-fns';

dotenv.config();

// --------------------------- CLI & Config ---------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    let val = 'true';
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
    if (key === 'dry-run') out.dryRun = (val === 'true' || val === '');
    else if (key === 'chunk-size') out.chunkSize = Number(val);
    else if (key === 'db') out.db = val;
    else if (key === 'api-key') out.apiKey = val;
  }
  return out;
}

const ARGS = parseArgs(process.argv);

const DX_DB_CONNECTION = ARGS.db || process.env.DX_DB_CONNECTION;
const TABNINE_API_KEY = ARGS.apiKey || process.env.TABNINE_API_KEY;
const DRY_RUN = (ARGS.dryRun !== undefined) ? ARGS.dryRun : (process.env.DRY_RUN === 'true');
const CHUNK_SIZE = Number.isFinite(ARGS.chunkSize) ? ARGS.chunkSize : parseInt(process.env.CHUNK_SIZE || '100', 10);

function requireEnv(name) {
  if (!process.env[name] && !(name === 'DX_DB_CONNECTION' && DX_DB_CONNECTION) && !(name === 'TABNINE_API_KEY' && TABNINE_API_KEY)) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}
requireEnv('DX_DB_CONNECTION');
requireEnv('TABNINE_API_KEY');

// --------------------------- Constants -----------------------------
const REQUIRED_COLUMNS = [
  'date', 'email', 'user_identifier', 'user_name', 'current_team', 'user_role',
  'languages', 'ides', 'number_of_devices', 'num_of_keystrokes',
  'number_of_completions', 'num_of_characters_added', 'num_of_lines_completed',
  'chat_interactions', 'chat_consumption', 'copy_code_consumption',
  'chat_consumed_characters', 'chat_consumed_lines', 'copy_clicks',
  'insert_clicks', 'click_thumbs', 'copied_text', 'click_navs'
];

// --------------------------- Utilities -----------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

// --------------------------- Tabnine API ---------------------------
async function fetchTabnineUsage() {
  const url = 'https://api.tabnine.com/enterprise/usage';
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${TABNINE_API_KEY}` },
      timeout: 60_000,
    });
    return data;
  } catch (err) {
    console.error('Failed to fetch Tabnine usage data:', err?.message || err);
    process.exit(1);
  }
}

// --------------------------- Database ------------------------------
const client = new Client({
  connectionString: DX_DB_CONNECTION,
  ssl: { rejectUnauthorized: false },
});

async function insertChunk(rows) {
  if (!rows.length) return;

  const placeholders = rows
    .map((_, i) => `(${REQUIRED_COLUMNS.map((_, j) => `$${i * REQUIRED_COLUMNS.length + j + 1}`).join(', ')})`)
    .join(', ');

  const values = rows.flatMap(row => REQUIRED_COLUMNS.map(col => row[col] ?? null));

  const query = `
    INSERT INTO custom.tabnine_daily_usages (${REQUIRED_COLUMNS.join(', ')})
    VALUES ${placeholders}
    ON CONFLICT DO NOTHING;
  `;

  if (DRY_RUN) {
    log(`DRY_RUN: would insert ${rows.length} rows into custom.tabnine_daily_usages`);
  } else {
    await client.query(query, values);
    log(`Inserted ${rows.length} rows`);
  }
}

// ----------------------------- Main --------------------------------
(async function main() {
  try {
    if (!DRY_RUN) {
      await client.connect();
      log('Connected to Postgres');
    } else {
      log('DRY_RUN enabled — will not write to DB');
    }

    const usageData = await fetchTabnineUsage();

    const rows = (usageData || []).map(entry => ({
      ...entry,
      date: entry?.date ? format(parseISO(entry.date), 'yyyy-MM-dd') : null,
    }));

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await insertChunk(rows.slice(i, i + CHUNK_SIZE));
    }

    log('🎉 Tabnine usage data import complete.');
  } catch (err) {
    console.error('💥 Fatal error:', err?.message || err);
    process.exitCode = 1;
  } finally {
    try {
      if (!DRY_RUN) await client.end();
    } catch {}
  }
})();
