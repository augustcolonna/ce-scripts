#!/usr/bin/env node
/**
 * Confluence Comments Exporter (JavaScript)
 *
 * Fetches footer and inline comments for Confluence pages (via Atlassian Cloud API),
 * where the page IDs come from a DX Postgres database, and writes two CSV files.
 *
 * Usage:
 *   node /your-path-here/deploymentsBackfill.js
 *
 * Environment variables (recommended over hardcoding):
 *   DX_PROXY_USER, DX_PROXY_PASS      HTTP proxy credentials
 *   DX_DB_CONNECTION                  Postgres connection string (overrides default)
 *   CONFLUENCE_BASE_URL               e.g. https://your-domain.atlassian.net
 *   CONFLUENCE_EMAIL                  Atlassian account email
 *   CONFLUENCE_API_TOKEN              Atlassian API token
 *
 * Outputs:
 *   ./confluence_footer_comments.csv
 *   ./confluence_inline_comments.csv
 *
 * Notes:
 *   - Handles rate limiting (HTTP 429) with backoff and retries 503/504.
 *   - Uses an HTTP proxy at http://<DX_PROXY_USER>:<DX_PROXY_PASS>@proxy.getdx.net:80 when env vars are set.
 *   - For security, prefer environment variables instead of hardcoded credentials.
 */

const fs = require('fs');
const pkg = require('pg');
const HttpsProxyAgent = require('https-proxy-agent');
const { createObjectCsvWriter } = require('csv-writer');

const { Client } = pkg;

// Dynamic import for node-fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// DX Proxy configuration
const DX_PROXY_USER = process.env.DX_PROXY_USER;
const DX_PROXY_PASS = process.env.DX_PROXY_PASS;
const proxyUrl = `http://${DX_PROXY_USER}:${DX_PROXY_PASS}@proxy.getdx.net:80`;
const proxyAgent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);

// Confluence credentials (hardcoded)
const CONFLUENCE_BASE_URL = 'https://<customer name>.atlassian.net';
const CONFLUENCE_API_TOKEN = 'xxxxxxxxxxxx';
const CONFLUENCE_EMAIL = 'customer@customer.com';

// DX DB connection
const DX_DB_CONNECTION = 'postgres://user:password@host:port/dbname';
const normalizePostgresURL = (url) =>
  url.startsWith("postgres://")
    ? url.replace("postgres://", "postgresql://")
    : url;
const dbClient = new Client({
  connectionString: normalizePostgresURL(DX_DB_CONNECTION),
  ssl: { rejectUnauthorized: false }
});

// Helper function to pause between requests
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch comments for a given page ID and endpoint with rate limit & error handling
async function fetchComments(endpoint, pageId, attempt = 1) {
  const url = `${CONFLUENCE_BASE_URL}/wiki/api/v2/pages/${pageId}/${endpoint}?expand=body.storage,body.plain,createdBy`;
  console.log(`Requesting [${endpoint}] for page [${pageId}] (Attempt ${attempt})`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64')}`,
      'Accept': 'application/json'
    },
    agent: proxyAgent
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') || 60;
    console.warn(`Rate limit hit (429) for page ${pageId}. Retrying after ${retryAfter} seconds (Attempt ${attempt})...`);
    await sleep(retryAfter * 1000);
    return fetchComments(endpoint, pageId, attempt + 1);
  }

  if ([503, 504].includes(response.status) && attempt <= 3) {
    const waitTime = 30 * attempt;
    console.warn(`${response.status} Service Unavailable for page ${pageId}. Retrying after ${waitTime} seconds (Attempt ${attempt})...`);
    await sleep(waitTime * 1000);
    return fetchComments(endpoint, pageId, attempt + 1);
  }

  if (response.status === 401) {
    console.warn(`401 Unauthorized for page ${pageId}. Skipping.`);
    return [];
  }

  if (!response.ok) {
    console.error(`Failed to fetch ${endpoint} for page ${pageId}: ${response.status} ${response.statusText}`);
    return [];
  }

  const data = await response.json();
  return data.results;
}

// Query DX for source_ids
async function fetchPageSourceIds() {
  await dbClient.connect();
  const result = await dbClient.query(`SELECT source_id FROM confluence_pages`);
  await dbClient.end();
  return result.rows.map(row => row.source_id);
}

// Main function to fetch and write comments
async function fetchAndWriteComments(footerOutputFile, inlineOutputFile) {
  const sourceIds = await fetchPageSourceIds();
  console.log(`Fetched ${sourceIds.length} source_ids from DX.`);

  const footerComments = [];
  const inlineComments = [];

  for (const pageId of sourceIds) {
    // Throttle between requests
    await sleep(500);  // 0.5 seconds between requests

    const footerResults = await fetchComments('footer-comments', pageId);
    for (const comment of footerResults) {
      footerComments.push({
        page_id: pageId,
        comment_source_id: comment.id,
        parent_comment_source_id: comment.parentId || '',
        author_source_id: comment.createdBy?.accountId || '',
        body: comment.body?.plain?.value || comment.body?.storage?.value || '',
        created_at: comment.createdAt || '',
        updated_at: comment.updatedAt || '',
        status: comment.status || 'current'
      });
    }

    await sleep(500);

    const inlineResults = await fetchComments('inline-comments', pageId);
    for (const comment of inlineResults) {
      inlineComments.push({
        page_id: pageId,
        comment_source_id: comment.id,
        parent_comment_source_id: comment.parentId || '',
        author_source_id: comment.createdBy?.accountId || '',
        body: comment.body?.plain?.value || comment.body?.storage?.value || '',
        created_at: comment.createdAt || '',
        updated_at: comment.updatedAt || '',
        status: comment.status || 'current'
      });
    }
  }

  // Write footer comments to CSV
  const footerCsvWriter = createObjectCsvWriter({
    path: footerOutputFile,
    header: [
      { id: 'page_id', title: 'page_id' },
      { id: 'comment_source_id', title: 'comment_source_id' },
      { id: 'parent_comment_source_id', title: 'parent_comment_source_id' },
      { id: 'author_source_id', title: 'author_source_id' },
      { id: 'body', title: 'body' },
      { id: 'created_at', title: 'created_at' },
      { id: 'updated_at', title: 'updated_at' },
      { id: 'status', title: 'status' }
    ]
  });
  await footerCsvWriter.writeRecords(footerComments);
  console.log(`Footer comments written to ${footerOutputFile}.`);

  // Write inline comments to CSV
  const inlineCsvWriter = createObjectCsvWriter({
    path: inlineOutputFile,
    header: [
      { id: 'page_id', title: 'page_id' },
      { id: 'comment_source_id', title: 'comment_source_id' },
      { id: 'parent_comment_source_id', title: 'parent_comment_source_id' },
      { id: 'author_source_id', title: 'author_source_id' },
      { id: 'body', title: 'body' },
      { id: 'created_at', title: 'created_at' },
      { id: 'updated_at', title: 'updated_at' },
      { id: 'status', title: 'status' }
    ]
  });
  await inlineCsvWriter.writeRecords(inlineComments);
  console.log(`Inline comments written to ${inlineOutputFile}.`);
}

// Usage
const footerCsvFilePath = './confluence_footer_comments.csv';
const inlineCsvFilePath = './confluence_inline_comments.csv';
fetchAndWriteComments(footerCsvFilePath, inlineCsvFilePath);
