 DX Deployments CSV uploader (JavaScript)
 
  Reads a CSV file and POSTs a deployment payload per row to your DX instance.
 
  Usage:
    node deplymentsBackfill.js --csv deployments.csv \
      --base-url https://yourinstance.getdx.net \
      --token xxxxxxxx --dry-run
 
  Environment fallbacks (if flags omitted):
    DX_BASE_URL, DX_TOKEN
 
  CSV column mapping (headers are case-insensitive):
    required: deployed_at, service
    one of: commit_sha OR merge_commit_shas
    optional: token, base_url, reference_id, repository, source_url, source_name,
              metadata, integration_branch, success, environment