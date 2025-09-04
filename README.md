## CE scripts
- customer-agnostic scripts and specific use-case scripts

## Pre Reqs
```
usage instructions can be found in each script as well as their required variables.

npm install

```

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

### Unified CLI

After installing dependencies, you can run scripts via the unified CLI. Examples:

```bash
# Deployments
npx dx --help
npx dx deployments --csv ./deployments.csv --base-url https://your.getdx.net --token $DX_TOKEN --dry-run

# Set Pull Services
npx dx set-pull-services --csv ./prs.csv --concurrency 6 --dry-run

# Split Deployments CSV by environment
npx dx split-deployments --csv ./deployments.csv --out ./split_envs --column environment --dry-run

# Incidents import
npx dx incidents --csv "./1 - Critical.csv" --api-url https://your.getdx.net/api/incidents.sync --token $DX_TOKEN --rps 10

# Pipelines import from a directory of CSV chunks
npx dx pipelines --dir ./Backfill --api-url https://your.getdx.net/api/pipelineRuns.sync --token $DX_TOKEN --rps 7
```

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

## When Updating
- cd ce-scripts
- git pull
- git checkout -b feature/<your branch name>
- make changes
- git add .
- git commit -m"your comments here"
- git push OR if its your first time commiting git push --set-upstream origin master
PR gets reviewed and merged

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
