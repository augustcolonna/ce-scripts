#!/usr/bin/env node
/**
 * setPullSsvicesBackfill deployments.setPullServices importer
 * Uses repository + pull_number and prints the full API call before sending.
 *
 * Usage:
 *   node /your-path/setPullSsvicesBackfill.js --file /your-path/your-csv.csv --concurrency 6 --dryRun true
 *   node /your-path/setPullSsvicesBackfill.js --file /your-path/your-csv.csv --concurrency 6 --dryRun false
 *
 * Flags:
 *   --file          CSV path. Default your-csv.csv
 *   --concurrency   Parallel workers. Default 6
 *   --dryRun        If true, no requests are sent. Default true
 *   --timeoutMs     Per request timeout. Default 30000
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const csv = require("csv-parser");
const minimist = require("minimist");
require('dotenv').config();

/** ========= CONFIG ========= */
const DX_BASE_URL = process.env.DX_BASE_URL || "";
const DX_TOKEN = process.env.DX_TOKEN || "";
/** ========================== */

function parseBool(v, fb = false) {
  if (v === undefined || v === null) return fb;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function unique(arr) {
  return Array.from(
    new Set(
      arr
        .filter((x) => x !== null && x !== undefined)
        .map((x) => String(x).replace(/\u0000/g, "").trim())
        .filter(Boolean)
    )
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function keyFrom(repo, num) {
  return `${repo}#${num}`;
}

function parseServices(primary, fallback) {
  const tryJson = (val) => {
    const s = String(val || "").trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr;
      } catch (_) {}
    }
    return null;
  };

  let out = [];
  const j1 = tryJson(primary);
  if (j1) out = j1;
  if (!out.length) {
    const j2 = tryJson(fallback);
    if (j2) out = j2;
  }
  if (!out.length) {
    const s = String(primary || fallback || "").trim();
    if (s.length) {
      out = s
        .split(/[\|,]/)
        .map((x) => x.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
    }
  }
  return unique(out);
}

function parseRow(row) {
  const repository = String(row.repository || "").trim();
  const pull_number = Number(String(row.pull_number || "").trim());
  const services = parseServices(row.services, row.service);
  if (!repository || !Number.isFinite(pull_number) || services.length === 0) return null;
  return { repository, pull_number, services };
}

async function readAndGroup(csvPath) {
  const groups = new Map();
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on("data", (row) => {
        const r = parseRow(row);
        if (!r) return;
        const key = keyFrom(r.repository, r.pull_number);
        if (!groups.has(key)) {
          groups.set(key, { repository: r.repository, pull_number: r.pull_number, services: [] });
        }
        groups.get(key).services.push(...r.services);
      })
      .on("end", resolve)
      .on("error", reject);
  });
  for (const g of groups.values()) g.services = unique(g.services);
  return Array.from(groups.values());
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

async function withRetry(fn, { max = 5, baseDelay = 500 }) {
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt + 1);
    } catch (err) {
      attempt += 1;
      const status = err.response && err.response.status;
      const retryable = !status || status >= 500 || status === 429 || status === 408;
      if (!retryable || attempt >= max) throw err;
      const jitter = Math.floor(Math.random() * 250);
      const backoff = Math.min(30000, baseDelay * Math.pow(2, attempt - 1)) + jitter;
      await sleep(backoff);
    }
  }
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    string: ["file", "baseUrl", "token"],
    boolean: ["dryRun"],
    default: { file: "benchling.csv", concurrency: 6, dryRun: true, timeoutMs: 30000 },
  });

  const inputPath = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(inputPath)) throw new Error(`CSV not found at ${inputPath}`);

  const baseUrl = String(args.baseUrl || DX_BASE_URL || "").trim();
  const token = String(args.token || DX_TOKEN || "").trim();
  if (!baseUrl) throw new Error("DX base URL missing. Provide --baseUrl or set DX_BASE_URL");
  if (!token && !parseBool(args.dryRun, true)) throw new Error("DX token missing. Provide --token or set DX_TOKEN, or use --dryRun true");

  const http = axios.create({
    baseURL: baseUrl,
    timeout: Number(args.timeoutMs) || 30000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    validateStatus: (s) => s >= 200 && s < 500,
  });

  const groups = await readAndGroup(inputPath);
  console.log(`Prepared ${groups.length} PR groups from CSV`);

  const successOut = fs.createWriteStream("benchling_success.csv", { flags: "a" });
  const errorOut = fs.createWriteStream("benchling_errors.csv", { flags: "a" });
  successOut.write("repository,pull_number,services_pretty,services_json,count,status\n");
  errorOut.write("repository,pull_number,services_pretty,services_json,error\n");

  const CONCURRENCY = parseInt(args.concurrency, 10) || 6;
  const DRY_RUN = parseBool(args.dryRun, true);

  async function worker(items) {
    for (const g of items) {
      const payload = { repository: g.repository, pull_number: g.pull_number, services: g.services };

      // Print the full API call preview before sending
      console.log("\n=== API CALL PREVIEW ===");
      console.log("POST", baseUrl + "/api/deployments.setPullServices");
      console.log("Headers:", {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      });
      console.log("Body:", JSON.stringify(payload, null, 2));
      console.log("========================\n");

      // Prepare CSV audit fields
      const pretty = g.services.join("|");
      const json = JSON.stringify(g.services);
      const jsonCsv = `"${json.replace(/"/g, '""')}"`;

      if (DRY_RUN) {
        successOut.write(`${g.repository},${g.pull_number},"${pretty}",${jsonCsv},${g.services.length},DRY\n`);
        continue;
      }

      try {
        const resp = await withRetry(async () => {
          const r = await http.post("/api/deployments.setPullServices", payload);
          if (r.status >= 400) {
            const e = new Error(`HTTP ${r.status}`);
            e.response = r;
            throw e;
          }
          return r;
        }, { max: 5, baseDelay: 500 });

        successOut.write(`${g.repository},${g.pull_number},"${pretty}",${jsonCsv},${g.services.length},${resp.status}\n`);
      } catch (err) {
        const status = err.response ? err.response.status : "NO_RESP";
        const body = err.response ? JSON.stringify(err.response.data || {}) : String(err.message || err);
        console.error(`Error for ${g.repository}#${g.pull_number}: status=${status} body=${body}`);
        const errCsv = `"${JSON.stringify({ status, body }).replace(/"/g, '""')}"`;
        errorOut.write(`${g.repository},${g.pull_number},"${pretty}",${jsonCsv},${errCsv}\n`);
      }
    }
  }

  const all = groups.slice();
  const shardSize = Math.ceil(all.length / CONCURRENCY) || 1;
  const shards = chunk(all, shardSize);
  await Promise.all(shards.map(worker));

  successOut.end();
  errorOut.end();

  console.log("Done");
  console.log("See benchling_success.csv and benchling_errors.csv");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
