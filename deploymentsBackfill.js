import fs from 'fs';
import { parse } from 'csv-parse/sync';
import fetch from 'node-fetch';
import { program } from 'commander';

// -------------------------- Utilities ---------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

function parseBool(val) {
  if (val == null) return undefined;
  const s = String(val).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return undefined;
}

function parseMergeShas(val) {
  if (!val) return undefined;
  const parts = val.split(/[;,|]/).map(x => x.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function tryJson(val) {
  if (!val) return undefined;
  try { return JSON.parse(val); } catch { return undefined; }
}

function normalize(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[(k || '').trim().toLowerCase()] = v;
  }
  return out;
}

// --------------------------- HTTP -------------------------------
async function postJson(url, token, payload, timeout = 30000) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'dx-csv-uploader/1.0'
      },
      body: JSON.stringify(payload),
      timeout
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

// ----------------------- Worker logic ---------------------------
function buildPayload(row) {
  const r = normalize(row);
  const payload = {};

  if (!r.deployed_at) throw new Error('Missing deployed_at');
  if (!r.service) throw new Error('Missing service');

  payload.deployed_at = r.deployed_at.trim();
  payload.service = r.service.trim();

  if (r.commit_sha) payload.commit_sha = r.commit_sha.trim();
  if (r.repository) payload.repository = r.repository.trim();

  const mcs = parseMergeShas(r.merge_commit_shas);
  if (mcs) payload.merge_commit_shas = mcs;

  if (r.reference_id) payload.reference_id = r.reference_id.trim();
  if (r.source_url) payload.source_url = r.source_url.trim();
  if (r.source_name) payload.source_name = r.source_name.trim();

  const md = tryJson(r.metadata);
  if (md) payload.metadata = md;

  if (r.integration_branch) payload.integration_branch = r.integration_branch.trim();

  const b = parseBool(r.success);
  if (b !== undefined) payload.success = b;

  if (r.environment) payload.environment = r.environment.trim();

  return payload;
}

async function processRow(idx, row, baseUrl, defaultToken, dryRun, timeout) {
  const r = normalize(row);
  const token = (r.token || defaultToken || '').trim();
  const rowBaseUrl = (r.base_url || baseUrl || '').trim();
  if (!rowBaseUrl) throw new Error('Base URL not provided');
  if (!token) throw new Error('Token not provided');

  const payload = buildPayload(row);
  if (dryRun) return { ok: true, status: 0, body: 'DRY_RUN', payload };

  const { status, body } = await postJson(`${rowBaseUrl.replace(/\/$/, '')}/api/deployments.create`, token, payload, timeout);
  return { ok: status >= 200 && status < 300, status, body, payload };
}

// ---------------------------- Main ------------------------------
program
  .requiredOption('--csv <path>', 'CSV file path')
  .option('--base-url <url>', 'DX base URL', process.env.DX_BASE_URL)
  .option('--token <token>', 'DX API token', process.env.DX_TOKEN)
  .option('--timeout <ms>', 'HTTP timeout ms', parseInt, 30000)
  .option('--dry-run', 'Do not POST, just log payloads')
  .parse(process.argv);

const opts = program.opts();

(async () => {
  if (!fs.existsSync(opts.csv)) {
    log(`CSV not found: ${opts.csv}`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(opts.csv, 'utf-8');
  const records = parse(csvText, { columns: true, skip_empty_lines: true });
  if (records.length === 0) {
    log('CSV is empty');
    process.exit(1);
  }

  let failures = 0;
  for (let i = 0; i < records.length; i++) {
    try {
      const res = await processRow(i, records[i], opts.baseUrl, opts.token, opts.dryRun, opts.timeout);
      if (res.ok) {
        log(`Row ${i}: OK status=${res.status}`);
      } else {
        failures++;
        log(`Row ${i}: FAIL status=${res.status} body=${String(res.body).slice(0, 300)}`);
      }
    } catch (e) {
      failures++;
      log(`Row ${i}: ERROR ${e.message}`);
    }
  }

  log(`Done. successes=${records.length - failures} failures=${failures}`);
  process.exit(failures > 0 ? 1 : 0);
})();
