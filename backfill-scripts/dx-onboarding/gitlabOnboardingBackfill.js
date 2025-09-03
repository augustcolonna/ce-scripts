#!/usr/bin/env node
/**
 * DX GitLab Backfill (JavaScript / ESM)
 *
 * Generates DX onboarding backfill data for GitLab (SaaS or self-managed).
 * For each GitLab Group and Username, fetches the user's earliest merged MRs
 * and forwards minimal metadata to a DX webhook.
 *
 * Usage:
 *   node gitlabOnboardingBackfill.js \
 *     --gitlab-url https://gitlab.com \
 *     --gitlab-token <GL_TOKEN> \
 *     --dx-webhook <DX_WEBHOOK_URL> \
 *     --groups 123,456 \
 *     --users alice,bob \
 *     [--per-page 10] [--resume] [--state-file ./dx_backfill_logs.txt] [--dry-run]
 *
 * Environment variables (preferred; CLI flags override when provided):
 *   GITLAB_INSTANCE_URL   Base URL for GitLab (e.g., https://gitlab.com)
 *   GITLAB_API_TOKEN      Personal access token with API scope
 *   DX_WEBHOOK_URL        DX webhook endpoint
 *   GITLAB_GROUPS         Comma-separated GitLab group IDs (e.g., 123,456)
 *   GITLAB_USERS          Comma-separated GitLab usernames (e.g., alice,bob)
 *
 * Behavior:
 *   - Calls: GET /api/v4/groups/:group/merge_requests?author_username=:u&state=merged&order_by=created_at&sort=asc&per_page=N
 *   - On 429 rate limit: waits Retry-After (or 60s) and retries (up to 5 attempts).
 *   - Posts to DX webhook one record per MR: {source, id, username, merged_at, url, title}.
 *   - Writes a simple resume file ("group|||username"). Use --resume to auto-continue; otherwise starts fresh.
 *   - If --dry-run: prints what would be posted, without calling DX.
 */

import fs from 'fs';
import readline from 'readline';

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

const ARGS = parseArgs(process.argv);
const GITLAB_INSTANCE_URL = ARGS['gitlab-url'] || process.env.GITLAB_INSTANCE_URL || 'https://gitlab.com';
const GITLAB_API_TOKEN = ARGS['gitlab-token'] || process.env.GITLAB_API_TOKEN || '';
const DX_WEBHOOK_URL = ARGS['dx-webhook'] || process.env.DX_WEBHOOK_URL || '';
const GROUPS = (ARGS['groups'] || process.env.GITLAB_GROUPS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(s => Number(s));
const USERS = (ARGS['users'] || process.env.GITLAB_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const PER_PAGE = Number(ARGS['per-page'] || 10);
const RESUME_FILE = ARGS['state-file'] || './dx_backfill_logs.txt';
const AUTO_RESUME = ARGS['resume'] === 'true' || ARGS['resume'] === '';
const DRY_RUN = ARGS['dry-run'] === 'true' || ARGS['dry-run'] === '';

function requireVal(ok, msg) { if (!ok) { console.error(msg); process.exit(1); } }
requireVal(!!GITLAB_API_TOKEN, 'Missing GitLab token. Set --gitlab-token or GITLAB_API_TOKEN');
requireVal(!!DX_WEBHOOK_URL, 'Missing DX webhook. Set --dx-webHOOK or DX_WEBHOOK_URL');
requireVal(Array.isArray(GROUPS) && GROUPS.length > 0, 'Missing groups. Set --groups or GITLAB_GROUPS');
requireVal(Array.isArray(USERS) && USERS.length > 0, 'Missing users. Set --users or GITLAB_USERS');

// --------------------------- Utilities -----------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// --------------------------- Resume state --------------------------
function writeResume(group, username) {
  try { fs.writeFileSync(RESUME_FILE, `${group}|||${username}`, 'utf8'); } catch {}
}
function readResume() {
  try {
    const s = fs.readFileSync(RESUME_FILE, 'utf8');
    const [g, u] = s.split('|||');
    if (!g || !u) return null;
    return { group: Number(g), username: u };
  } catch { return null; }
}
function clearResume() { try { fs.unlinkSync(RESUME_FILE); } catch {} }

async function maybePromptResume(found) {
  if (!found) return false;
  if (AUTO_RESUME) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(res => rl.question('[DX backfill] Previous run detected. Resume? [Y/n] ', a => { rl.close(); res(a); }));
  return String(ans || 'y').trim().toLowerCase().startsWith('y');
}

// --------------------------- GitLab API ----------------------------
async function getEarliestMergedMRs(groupId, username, attempt = 1) {
  const url = new URL(`${GITLAB_INSTANCE_URL.replace(/\/$/, '')}/api/v4/groups/${groupId}/merge_requests`);
  url.searchParams.set('author_username', username);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('state', 'merged');
  url.searchParams.set('order_by', 'created_at');
  url.searchParams.set('sort', 'asc');

  const resp = await _fetch(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': 'dx-gitlab-backfill/1.0',
      'PRIVATE-TOKEN': GITLAB_API_TOKEN,
      'Accept': 'application/json'
    },
  });

  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get('retry-after') || 60);
    log(`[DX backfill] Group ${groupId} user ${username}: RATE LIMITED, waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    if (attempt >= 5) throw new Error('Too many retries after 429');
    return getEarliestMergedMRs(groupId, username, attempt + 1);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitLab error ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

// --------------------------- DX Webhook ----------------------------
async function postDX(payload) {
  if (DRY_RUN) { log(`[DRY_RUN] POST ${DX_WEBHOOK_URL} -> ${JSON.stringify(payload)}`); return; }
  const resp = await _fetch(DX_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  if (resp.status !== 200) throw new Error(`DX webhook status ${resp.status}: ${text.slice(0, 300)}`);
  try {
    const j = JSON.parse(text);
    if (j && j.ok === false) throw new Error(`DX webhook ok=false: ${text.slice(0, 300)}`);
  } catch {
    // If not JSON, assume plain OK body from DX; Ruby script only checked for ok=false when JSON
  }
}

async function sendDataToDX(username, mrs) {
  if (!Array.isArray(mrs) || mrs.length === 0) return;
  for (const item of mrs) {
    const payload = {
      source: 'gitlab',
      id: item.id,
      username,
      merged_at: item.merged_at,
      url: item.web_url,
      title: item.title,
    };
    await postDX(payload);
  }
  await sleep(1000); // throttle like the Ruby script
}

// ----------------------------- Main --------------------------------
(async function main() {
  const resumeFrom = readResume();
  let startGroupIdx = 0;
  let startUserIdx = 0;

  if (resumeFrom) {
    const doResume = await maybePromptResume(true);
    if (doResume) {
      startGroupIdx = Math.max(0, GROUPS.indexOf(resumeFrom.group));
      startUserIdx = Math.max(0, USERS.indexOf(resumeFrom.username));
      log('[DX backfill] Resuming from saved state...');
    } else {
      clearResume();
      log('[DX backfill] Starting fresh...');
    }
  } else {
    log('[DX backfill] Starting...');
  }

  let success = true;
  try {
    for (let gi = startGroupIdx; gi < GROUPS.length; gi++) {
      const group = GROUPS[gi];
      for (let ui = gi === startGroupIdx ? startUserIdx : 0; ui < USERS.length; ui++) {
        const user = USERS[ui];
        writeResume(group, user);
        log(`[DX backfill] Getting Group ${group} data for ${user}...`);
        const mrs = await getEarliestMergedMRs(group, user);
        await sendDataToDX(user, mrs);
      }
    }
  } catch (e) {
    success = false;
    console.error('[DX backfill] Something went wrong:', e?.message || e);
  }

  if (success) {
    try { await postDX({ finished: true }); } catch (e) { log(`[DX backfill] Finished, but DX finish ping failed: ${e?.message || e}`); }
    clearResume();
    log('[DX backfill] Done! Your backfill was successful.');
  } else {
    log('[DX backfill] Exiting with errors — resume file retained.');
    process.exitCode = 1;
  }
})();
