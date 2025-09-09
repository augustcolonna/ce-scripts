#!/usr/bin/env node
/**
 * DX User Tags Export Script
 *
 * Exports user data with tags and AI tools usage to a CSV file.
 * Connects to the DX Postgres database and streams results to avoid memory issues.
 *
 * Usage:
 *   node getUserTags.js --output ./user_tags.csv --dry-run
 *   node getUserTags.js --output ./user_tags.csv
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string (required)
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { Pool } from 'pg';
import QueryStream from 'pg-query-stream';
import { stringify } from 'csv-stringify';
import { program } from 'commander';
import dotenv from 'dotenv';

const pipe = promisify(pipeline);

// Load environment variables
dotenv.config();

// -------------------------- Utilities ---------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

// Normalize postgres:// → postgresql://
const normalizePostgresURL = (url) =>
  url.startsWith('postgres://') ? url.replace('postgres://', 'postgresql://') : url;

// --------------------------- Database Setup -------------------------------
function createPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL in environment');
  }
  
  const normalizedUrl = normalizePostgresURL(databaseUrl);
  
  return new Pool({
    connectionString: normalizedUrl,
    ssl: { rejectUnauthorized: false },
    application_name: 'dx-export-user-tags',
  });
}

// --------------------------- SQL Query -------------------------------
const QUERY = `
SELECT 
    du.name AS user_name,
    du.email,
    dt.name AS team_name,
    dt.flattened_parent AS team_hierarchy,
    to_char(du.start_date::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS start_date,
    string_agg(DISTINCT CONCAT(dtg.name, ': ', dt_tags.name), ', ') AS tags,
    string_agg(DISTINCT ai_tools.tool, ', ') AS ai_tools_used,
    COUNT(DISTINCT ai_tools.tool) AS total_ai_tools_count
FROM dx_users du
LEFT JOIN dx_teams dt ON du.team_id = dt.id
LEFT JOIN dx_user_tags dut ON du.id = dut.user_id
LEFT JOIN dx_tags dt_tags ON dut.tag_id = dt_tags.id
LEFT JOIN dx_tag_groups dtg ON dt_tags.tag_group_id = dtg.id
LEFT JOIN bespoke_ai_tool_daily_metrics ai_tools ON du.email = ai_tools.email AND ai_tools.is_active = true
WHERE du.team_id IS NOT NULL
  AND du.deleted_at IS NULL
GROUP BY 
    du.id,
    du.name, 
    du.email, 
    dt.name, 
    dt.flattened_parent,
    du.start_date
ORDER BY du.name;
`;

// CSV columns in order
const CSV_COLUMNS = [
  'user_name',
  'email',
  'team_name',
  'team_hierarchy',
  'start_date',
  'tags',
  'ai_tools_used',
  'total_ai_tools_count',
];

// --------------------------- Export Logic -------------------------------
async function exportToCsv(pool, outputPath, dryRun) {
  const client = await pool.connect();
  try {
    const queryStream = new QueryStream(QUERY, [], { batchSize: 1000 });
    const rowStream = client.query(queryStream);

    if (dryRun) {
      log('DRY RUN: Would export user tags data');
      log(`Query: ${QUERY}`);
      log(`Output columns: ${CSV_COLUMNS.join(', ')}`);
      log(`Output file: ${outputPath}`);
      
      // Count rows for dry run
      let rowCount = 0;
      rowStream.on('data', () => {
        rowCount += 1;
        if (rowCount % 1000 === 0) {
          log(`Would process ${rowCount} rows...`);
        }
      });
      
      await new Promise((resolve, reject) => {
        rowStream.on('end', resolve);
        rowStream.on('error', reject);
      });
      
      log(`DRY RUN: Would export ${rowCount} rows to ${outputPath}`);
      return;
    }

    const csvStream = stringify({ header: true, columns: CSV_COLUMNS });
    const fileStream = fs.createWriteStream(outputPath);

    let rowCount = 0;
    rowStream.on('data', () => {
      rowCount += 1;
      if (rowCount % 1000 === 0) {
        log(`Processed ${rowCount} rows...`);
      }
    });

    await pipe(rowStream, csvStream, fileStream);

    log(`✅ Export complete. Wrote ${rowCount} rows to ${outputPath}`);
  } finally {
    client.release();
  }
}

// ---------------------------- CLI Setup ------------------------------
program
  .name('getUserTags')
  .description('Export DX user data with tags and AI tools usage to CSV')
  .option('--output <path>', 'Output CSV file path', './user_tags.csv')
  .option('--database-url <url>', 'PostgreSQL connection string', process.env.DATABASE_URL)
  .option('--dry-run', 'Preview export without writing file')
  .parse(process.argv);

const opts = program.opts();

// ---------------------------- Main ------------------------------
(async () => {
  try {
    if (!opts.databaseUrl) {
      log('❌ Missing DATABASE_URL. Set it in environment or use --database-url');
      process.exit(1);
    }

    const pool = createPool(opts.databaseUrl);
    const outputPath = path.resolve(opts.output);

    log(`Starting user tags export...`);
    if (opts.dryRun) {
      log('Running in dry-run mode');
    } else {
      log(`Output file: ${outputPath}`);
    }

    await exportToCsv(pool, outputPath, opts.dryRun);
    
    log('✅ Export completed successfully');
  } catch (err) {
    log(`❌ Export failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (pool) {
      await pool.end();
    }
  }
})();
