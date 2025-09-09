## CE scripts
customer-agnostic scripts and specific use-case scripts

### Getting Started

1) Install Node.js
- Visit `https://nodejs.org` and install the LTS version.
- Verify in a terminal:
```bash
node -v
npm -v
```

2) Clone and open this repo
```bash
git clone <your repo url>
cd ce-scripts
npm install
```

3) Create a .env file
- In the `ce-scripts` folder, create a new file named `.env` and paste the template below.
- Ask your DX admin for your DX base URL and an API token.
- Set `DX_BASE_URL` and `DX_TOKEN` in the file.

4) Prepare your CSV(s)
- A CSV is a spreadsheet saved as "Comma-Separated Values".
- Make sure it has the columns required by the script you want to run (examples below).
- Add a csv to the  `ce-scripts/csv/`  and place files there with these names:
  - `deployments.csv` for deployments backfill
  - `prs.csv` for set-pull-services
  - `incidents.csv` for incidents import
- Optional: set `DX_CSV_DIR` in your `.env` to a different folder, or pass `--csv /path/to/file.csv` to override.

5) Do a dry run first
- All commands support a “dry-run” mode that shows what would be sent without making changes.

6) Run for real
- Remove the dry-run flag when you’re ready. Start with a small CSV to test.

### Environment variables

Create a `.env` file in the repo root to avoid repeating flags. The CLI auto-loads it.

Suggested template:

```env
# Global DX API config (used by multiple scripts)
DX_BASE_URL=https://yourinstance.getdx.net
DX_TOKEN=

# splitLargeDeploymentBackfill.js
INPUT_FILE=./your.csv
OUTPUT_DIR=./split_envs
SPLIT_COLUMN=environment
CSV_DELIMITER=,
SAFE_NAMES=true
OVERWRITE=false
DRY_RUN=false

# incidentsBackfill.js
# INPUT_FILE overrides per-script; otherwise use flags
API_URL=https://yourinstance.getdx.net/api/incidents.sync
# DX_TOKEN inherited from global
RPS=10

# pipelinesBackfill.js
DIRECTORY=./Backfill
API_URL=https://yourinstance.getdx.net/api/pipelineRuns.sync
# DX_TOKEN inherited from global
RPS=7
FAILURE_LOG_FILE=./pipeline_import_failures.csv
```

### What each script expects in your CSV

- Deployments (`dx deployments`)
  - Required columns: `deployed_at`, `service`
  - One of: `commit_sha` OR `merge_commit_shas`
  - Optional: `reference_id`, `repository`, `source_url`, `source_name`, `metadata`, `integration_branch`, `success`, `environment`
  - Tip: You can include `base_url` and `token` per row to override.

- Set Pull Services (`dx set-pull-services`)
  - Required columns: `repository`, `pull_number`, and `services` (JSON array or delimited like `svc1|svc2`)

- Split Deployments (`dx split-deployments`)
  - Any CSV with a column to split on (default `environment`).

- Incidents (`dx incidents`)
  - Required: `reference_id`
  - Optional: `source_name`, `priority`, `name`, `started_at`, `resolved_at`, `source_url`, `services`

- Pipelines (`dx pipelines`)
  - Directory of CSV files with common fields like `reference_id`, `pipeline_name`, `pipeline_source`, timestamps, etc.

### Unified CLI

After installing dependencies, you can run scripts via the unified CLI. Examples:

```bash
# Deployments (uses csv/deployments.csv by default)
npx dx --help
npx dx deployments --dry-run
npx dx deployments

# Set Pull Services (uses csv/prs.csv by default)
npx dx set-pull-services --concurrency 6 --dry-run
npx dx set-pull-services

# Split Deployments CSV by environment (uses csv/deployments.csv by default)
npx dx split-deployments --out ./split_envs --column environment --dry-run
npx dx split-deployments

# Incidents import (uses csv/incidents.csv by default)
npx dx incidents --dry-run
npx dx incidents

# Pipelines import from a directory of CSV chunks
npx dx pipelines --dir ./Backfill --dry-run
npx dx pipelines --dir ./Backfill

# User Tags Export (exports to CSV)
npx dx user-tags --dry-run
npx dx user-tags --output ./user_tags.csv

```

**Note**: If you don't pass `--csv`, the CLI automatically looks for the default CSV file in the `csv/` directory. You can still override with `--csv /path/to/other.csv` if needed.

You can also create a shell alias for convenience, e.g. add to `~/.zshrc`:

```bash
alias dx-scripts='node "/Users/guscolonna/Desktop/Projects/DX Projects/ce-scripts/bin/dx.js"'
```

Then use:

```bash
dx-scripts deployments --csv ./deployments.csv --base-url https://your.getdx.net --token $DX_TOKEN
```

Notes:
- Flags always override env values.
- `deploymentsBackfill.js` can also read `base_url`/`token` per-row from the CSV.
- `setPullServicesBackfill.js` now respects `DX_BASE_URL` and `DX_TOKEN`, plus `--baseUrl`/`--token` flags.

### Dry run vs. Live run
- Dry run: adds `--dry-run` (or `--dryRun true` for set-pull-services). No data is sent, useful to validate CSV format and payloads.
- Live run: remove the dry-run flag. Ensure `DX_TOKEN` is set and has the right permissions.

### Troubleshooting
- “CSV not found”: Double-check the path after `--csv` or `--dir`. Use absolute paths if unsure.
- “Missing DX token”: Set `DX_TOKEN` in `.env` or pass `--token`. For dry run, you can omit it.
- “Invalid timestamp”: Ensure timestamps are ISO-like, e.g. `2025-01-01T12:05:00` (deployments) or include `Z`/offset for incidents.
- “Services format”: For arrays, use JSON like `["svc1","svc2"]` or delimited `svc1|svc2`.
- Still stuck? Run with `--dry-run` and share the console output and the first 1-2 CSV rows (without secrets).

## When Updating
```
cd ce-scripts
git pull
git checkout -b feature/name-of-branch-goes-here
-- make changes --
git add .
git commit -m"your comments here"
git push OR if its your first time commiting git push --set-upstream origin master
PR gets reviewed and merged
```

## Repo structure
```
.
├─ ce-scripts/
│  ├─ backfill-scripts/
│  │  └─ deployments/
│  │     └─ deploymentsBackfill.js
│  └─ confluence/
│     └─ … (scripts)
├─ tool/
├─ .env
├─ .gitignore
├─ package-lock.json
├─ package.json
└─ README.md

```
