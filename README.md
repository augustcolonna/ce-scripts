## CE scripts
- customer-agnostic scripts and specific use-case scripts

## usage
- usage instructions can be found in each script as well as their required variables.

- npm i --> install dependencies upfront.

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
