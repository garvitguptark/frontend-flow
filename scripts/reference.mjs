#!/usr/bin/env node
// reference.mjs - resolve a reference URL into design tokens.
// Fetches the page and its stylesheets, then runs the drift scanner over them.
// Zero deps. Run: node reference.mjs <url> [--animations] [--keep]

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, report, animationsReport, walk } from './drift.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' };
const MAX_SHEETS = 6;

async function grab(url, ms = 45000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: ac.signal });
    return { ok: r.ok, status: r.status, finalUrl: r.url, body: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, body: '', err: e.message };
  } finally { clearTimeout(t); }
}

// WebFetch-style markdown conversion drops <head>, which is where stylesheets live -
// so this reads the raw HTML instead. That difference is the whole reason this exists.
function stylesheetUrls(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
    const href = m[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) { try { out.add(new URL(href, base).href); } catch { } }
  }
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+\.css[^"']*)["']/gi)) {
    try { out.add(new URL(m[1], base).href); } catch { }
  }
  return [...out];
}

const argv = process.argv.slice(2);
const url = argv.find(a => !a.startsWith('--'));
if (!url) {
  console.error('usage: node reference.mjs <url> [--animations] [--keep]');
  process.exit(1);
}

const page = await grab(/^https?:\/\//i.test(url) ? url : `https://${url}`);
if (!page.ok && !page.body) {
  console.log(`FETCH FAILED: ${url}${page.err ? ` (${page.err})` : ` (HTTP ${page.status})`}`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'ref-'));
writeFileSync(join(dir, 'page.html'), page.body);

const sheets = stylesheetUrls(page.body, page.finalUrl);
let fetched = 0, cssBytes = 0;
for (const [i, u] of sheets.slice(0, MAX_SHEETS).entries()) {
  const c = await grab(u, 30000);
  if (c.ok && c.body.length) {
    writeFileSync(join(dir, `sheet${i}.css`), c.body);
    fetched++; cssBytes += c.body.length;
  }
}

const files = walk(dir);
const data = scan(files);

console.log(`REFERENCE: ${page.finalUrl}`);
console.log(`SOURCE: ${(page.body.length / 1024).toFixed(0)}KB html, ` +
  `${fetched}/${sheets.length} stylesheets (${(cssBytes / 1024).toFixed(0)}KB)`);
if (!fetched && sheets.length) console.log('NOTE: stylesheets found but none fetched - CDN may be blocking.');
if (!sheets.length) console.log('NOTE: no linked stylesheets; reading inline <style> only.');
if (!data.colors.size) {
  console.log('NOTE: no literal colors. The site likely defines everything as var(--x)');
  console.log('      with values loaded from JS. Say the reference is not statically');
  console.log('      extractable - do not guess values to fill the gap.');
}
console.log();
console.log(report(data, 50, files.length));
if (argv.includes('--animations')) console.log('\n' + animationsReport(data));

if (argv.includes('--keep')) console.log(`\n(files kept in ${dir})`);
else rmSync(dir, { recursive: true, force: true });
