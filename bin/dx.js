#!/usr/bin/env node

// Unified CLI wrapper for CE scripts
// Provides consistent subcommands and CSV flag mapping

import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const program = new Command();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Load .env from repo root if present
dotenv.config({ path: path.resolve(repoRoot, '.env') });

function runNodeScript(scriptRelativePath, args) {
  const scriptPath = path.resolve(repoRoot, scriptRelativePath);
  const node = process.execPath;
  const child = spawn(node, [scriptPath, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// Default CSV directory resolution
const defaultCsvDir = process.env.DX_CSV_DIR || path.resolve(repoRoot, 'csv');
function resolveCsvLike(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  if (p.includes('/') || p.includes('\\')) return path.resolve(process.cwd(), p);
  return path.resolve(defaultCsvDir, p);
}

// Auto-resolve CSV if not provided
function getDefaultCsv(commandName) {
  const csvMap = {
    'deployments': 'deployments.csv',
    'set-pull-services': 'prs.csv',
    'split-deployments': 'deployments.csv',
    'incidents': 'incidents.csv'
  };
  return csvMap[commandName] || null;
}

program
  .name('dx')
  .description('DX CE scripts unified CLI')
  .showHelpAfterError();

// deployments: wraps backfill-scripts/deployments/deploymentsBackfill.js
program
  .command('deployments')
  .description('Upload deployments from a CSV')
  .option('--csv <path>', 'CSV file path (defaults to csv/deployments.csv)')
  .option('--base-url <url>', 'DX base URL')
  .option('--token <token>', 'DX API token')
  .option('--timeout <ms>', 'HTTP timeout in ms')
  .option('--dry-run', 'Do not POST, just log payloads')
  .action((opts) => {
    const csvPath = opts.csv || getDefaultCsv('deployments');
    if (!csvPath) {
      console.error('Error: No CSV file specified and no default found. Use --csv to specify a file.');
      process.exit(1);
    }
    const args = ['--csv', resolveCsvLike(csvPath)];
    if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
    if (opts.token) args.push('--token', opts.token);
    if (opts.timeout) args.push('--timeout', String(opts.timeout));
    if (opts.dryRun) args.push('--dry-run');
    runNodeScript('backfill-scripts/deployments/deploymentsBackfill.js', args);
  });

// set-pull-services: wraps backfill-scripts/deployments/setPullServicesBackfill.js
program
  .command('set-pull-services')
  .description('Call deployments.setPullServices from a CSV with repository/pull/services')
  .option('--csv <path>', 'CSV file path (defaults to csv/prs.csv)')
  .option('--base-url <url>', 'DX base URL')
  .option('--token <token>', 'DX API token')
  .option('--concurrency <n>', 'Parallel workers', '6')
  .option('--timeout <ms>', 'Per-request timeout in ms (maps to --timeoutMs)')
  .option('--dry-run', 'Preview without sending requests')
  .action((opts) => {
    const csvPath = opts.csv || getDefaultCsv('set-pull-services');
    if (!csvPath) {
      console.error('Error: No CSV file specified and no default found. Use --csv to specify a file.');
      process.exit(1);
    }
    const args = ['--file', resolveCsvLike(csvPath), '--concurrency', String(opts.concurrency ?? '6')];
    if (opts.baseUrl) args.push('--baseUrl', opts.baseUrl);
    if (opts.token) args.push('--token', opts.token);
    if (opts.timeout) args.push('--timeoutMs', String(opts.timeout));
    // underlying expects --dryRun true|false
    args.push('--dryRun', opts.dryRun ? 'true' : 'false');
    runNodeScript('backfill-scripts/deployments/setPullServicesBackfill.js', args);
  });

// split-deployments: wraps backfill-scripts/deployments/splitLargeDeploymentBackfill.js
program
  .command('split-deployments')
  .description('Split a large deployments CSV by a column (default environment)')
  .option('--csv <path>', 'Input CSV file path (defaults to csv/deployments.csv)')
  .option('--out <dir>', 'Output directory for split CSVs')
  .option('--column <name>', 'Column to split on')
  .option('--delimiter <char>', 'CSV delimiter, default ","')
  .option('--safe-names', 'Sanitize filenames')
  .option('--overwrite', 'Overwrite existing output files')
  .option('--dry-run', 'Preview output without writing files')
  .action((opts) => {
    const csvPath = opts.csv || getDefaultCsv('split-deployments');
    if (!csvPath) {
      console.error('Error: No CSV file specified and no default found. Use --csv to specify a file.');
      process.exit(1);
    }
    const args = ['--input', resolveCsvLike(csvPath)];
    if (opts.out) args.push('--out', opts.out);
    if (opts.column) args.push('--column', opts.column);
    if (opts.delimiter) args.push('--delimiter', opts.delimiter);
    if (opts.safeNames) args.push('--safe-names');
    if (opts.overwrite) args.push('--overwrite');
    if (opts.dryRun) args.push('--dry-run');
    runNodeScript('backfill-scripts/deployments/splitLargeDeploymentBackfill.js', args);
  });

// incidents: wraps backfill-scripts/incidents/incidentsBackfill.js
program
  .command('incidents')
  .description('Sync incidents from a CSV to DX')
  .option('--csv <path>', 'CSV file path (defaults to csv/incidents.csv)')
  .option('--base-url <url>', 'DX base URL')
  .option('--api-url <url>', 'DX incidents endpoint (overrides base-url)')
  .option('--token <token>', 'DX API token')
  .option('--rps <n>', 'Requests per second throttle')
  .option('--dry-run', 'Preview without sending')
  .action((opts) => {
    const csvPath = opts.csv || getDefaultCsv('incidents');
    if (!csvPath) {
      console.error('Error: No CSV file specified and no default found. Use --csv to specify a file.');
      process.exit(1);
    }
    const args = ['--input', resolveCsvLike(csvPath)];
    
    // Handle API URL - if api-url is provided, use it; otherwise construct from base-url
    if (opts.apiUrl) {
      args.push('--api-url', opts.apiUrl);
    } else if (opts.baseUrl) {
      const baseUrl = opts.baseUrl.replace(/\/$/, ''); // Remove trailing slash
      args.push('--api-url', `${baseUrl}/api/incidents.sync`);
    }
    
    if (opts.token) args.push('--token', opts.token);
    if (opts.rps) args.push('--rps', String(opts.rps));
    if (opts.dryRun) args.push('--dry-run');
    runNodeScript('backfill-scripts/incidents/incidentsBackfill.js', args);
  });

// pipelines: wraps backfill-scripts/pipelines/pipelinesBackfill.js
program
  .command('pipelines')
  .description('Sync pipeline runs from CSV chunk directory')
  .requiredOption('--dir <path>', 'Directory containing CSV chunks')
  .option('--api-url <url>', 'DX pipelines endpoint')
  .option('--token <token>', 'DX API token')
  .option('--rps <n>', 'Requests per second throttle')
  .option('--failures <path>', 'Failure log CSV path')
  .option('--dry-run', 'Preview without sending')
  .action((opts) => {
    const args = ['--dir', opts.dir];
    if (opts.apiUrl) args.push('--api-url', opts.apiUrl);
    if (opts.token) args.push('--token', opts.token);
    if (opts.rps) args.push('--rps', String(opts.rps));
    if (opts.failures) args.push('--failures', opts.failures);
    if (opts.dryRun) args.push('--dry-run');
    runNodeScript('backfill-scripts/pipelines/pipelinesBackfill.js', args);
  });




// user-tags: wraps dx-users/getUserTags.js
program
  .command('user-tags')
  .description('Export DX user data with tags and AI tools usage to CSV')
  .option('--output <path>', 'Output CSV file path', './user_tags.csv')
  .option('--database-url <url>', 'PostgreSQL connection string')
  .option('--dry-run', 'Preview export without writing file')
  .action((opts) => {
    const args = ['--output', opts.output];
    if (opts.databaseUrl) args.push('--database-url', opts.databaseUrl);
    if (opts.dryRun) args.push('--dry-run');
    runNodeScript('dx-users/getUserTags.js', args);
  });

program.parseAsync(process.argv);
