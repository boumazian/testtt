#!/usr/bin/env node
/**
 * auto-qa-runner.mjs — Autonomous ReaLift SDK QA orchestrator
 */

import { chromium } from 'playwright';
import { writeFileSync, appendFileSync, existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--headed'].includes(argv[i - 1])));

const RAW_URL = positional[0];
if (!RAW_URL || has('--help') || has('-h')) {
  console.error(`\nUsage: node auto-qa-runner.mjs <shopify-preview-url> [options]\n` +
    `  --slug <name>  --concurrency <n>  --settle <ms>  --limit <n>  --path-prefix </xx>  --headed\n`);
  process.exit(2);
}
let parsed;
try { parsed = new URL(RAW_URL); } catch { console.error(`✗ not a valid URL: ${RAW_URL}`); process.exit(2); }
const BASE = `${parsed.protocol}//${parsed.host}`;
const PATH_PREFIX = (flag('--path-prefix', '') || '').replace(/\/$/, '');

// ─── preview-session passthrough ───────────────────────────────────────────────
const isPreviewParam = (k) => k === 'preview_theme_id' || k === 'pb' || k.startsWith('_');
const PREVIEW_PAIRS = [];
for (const [k, v] of parsed.searchParams) {
  if (isPreviewParam(k)) PREVIEW_PAIRS.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
}
const withPreview = (url) => PREVIEW_PAIRS.length
  ? url + (url.includes('?') ? '&' : '?') + PREVIEW_PAIRS.join('&')
  : url;

const SETTLE_MS = parseInt(flag('--settle', '14000'), 10);
const SETTLE_NEGATIVE_MS = parseInt(flag('--settle-negative', String(SETTLE_MS)), 10);
const PAGE_POLITE_MS = 250;
const CONCURRENCY = Math.min(parseInt(flag('--concurrency', '2'), 10), 6);
const LIMIT = flag('--limit') ? parseInt(flag('--limit'), 10) : Infinity;
const HEADED = has('--headed');
const REVERIFY_N = 3;

const SLUG = (flag('--slug') || parsed.host.replace(/^www\./, '').split('.')[0].replace(/-\w{8,}.*$/, '').replace(/[^a-z0-9]+/gi, '-') || 'store')
  .toLowerCase().replace(/^-+|-+$/g, '') || 'store';
const OUTDIR = `${SLUG}-autoqa`;
mkdirSync(OUTDIR, { recursive: true });
const out = (f) => `${OUTDIR}/${f}`;
const CATALOG_FILE = out(`${SLUG}-all-products.json`);

// ─── classifier ─────────────────────────────────────────────────────────────
const NONFOOT_TYPE_RX = /(accessor|donation|\bgift|protection|package|\breturn\b|orthotic|insole|\bsock|\bglove|\bhat\b|\bcap\b|beanie|apparel|\btee\b|shirt|\bshort|legging|hoodie|\bbag\b)/i;
const EXCLUDE_RX = /(\bbag\b|backpack|duffel|tote|purse|\bbelt\b|wallet|\bcard\b|gift ?card|donation|protection|package_protection|\breturn\b|repair|care ?kit|\bkit\b|cleaner|spray|gaiter|carabiner|bottle|\bclip\b|\bsock|insole|outsole|orthotic|charm|pillow|cover|\bhat\b|\bcap\b|beanie|glove|wristband|knee ?pad|kneepad|singlet|hoodie|\btee\b|shirt|\bshort|legging|lookbook)/i;
const FOOT_TYPE_RX = /(footwear|casual|sandal|\bshoe|boot|sneaker|slipper|moccasin|\bmule\b|slide|clog|hiker|cleat|spike|wrestling|trainer)/i;
const FOOT_TITLE_RX = /(boot|sneaker|sandal|slipper|moccasin|\bmule\b|slip-?on|loafer|\bshoe|clog|romeo|chelsea|oxford|hiker|cleat|trainer|runner)/i;

function classify(p) {
  const type = (p.product_type || '').trim();
  const title = p.title || '';
  if (NONFOOT_TYPE_RX.test(type)) return { footwear: false, why: `type:${type}` };
  if (EXCLUDE_RX.test(type)) return { footwear: false, why: `type-exclude:${(type.match(EXCLUDE_RX) || [''])[0].trim()}` };
  if (FOOT_TYPE_RX.test(type)) return { footwear: true, why: `type:${type}` };
  if (EXCLUDE_RX.test(title)) return { footwear: false, why: `title-exclude:${(title.match(EXCLUDE_RX) || [''])[0].trim()}` };
  if (FOOT_TITLE_RX.test(title)) return { footwear: true, why: `kw:${(title.match(FOOT_TITLE_RX) || [''])[0].trim()}` };
  return type
    ? { footwear: false, why: `type:${type}(default-non-foot)` }
    : { footwear: true, why: 'empty-type(brand-default-foot)' };
}

// ─── catalog discovery ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, { retries = 3, baseDelay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) return r;
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      if (r.status < 500) throw err;
      lastErr = err;
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      lastErr = e;
    }
    if (attempt < retries) {
      const delay = baseDelay * 2 ** (attempt - 1);
      console.warn(`   ⚠ attempt ${attempt}/${retries} failed (${lastErr.message}) — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function loadCatalog() {
  if (existsSync(CATALOG_FILE)) {
    const raw = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.products || []);
    return arr.map((p) => ({ handle: p.handle, product_type: p.product_type, title: p.title }));
  }
  const all = []; const skipped = []; let page = 1;
  while (page < 60) {
    const url = withPreview(`${BASE}${PATH_PREFIX}/products.json?limit=250&page=${page}`);
    let batch;
    try {
      const r = await fetchWithRetry(url);
      batch = (await r.json()).products || [];
    } catch (e) {
      console.warn(`   ⚠ SKIPPING page ${page} after retries (${e.message}) — continuing sweep.`);
      skipped.push(page);
      page++; await sleep(400);
      continue;
    }
    all.push(...batch.map((p) => ({ handle: p.handle, product_type: p.product_type, title: p.title })));
    if (batch.length < 250) break;
    page++; await sleep(400);
  }
  if (skipped.length) {
    console.warn(`   ⚠ catalog incomplete — skipped page(s): ${skipped.join(', ')}; NOT caching, next run will re-fetch.`);
  } else {
    writeFileSync(CATALOG_FILE, JSON.stringify(all, null, 2));
  }
  return all;
}

// ─── render probe ──────────────────────────────────────────────────────────────
async function readRenderState(page, settleMs = SETTLE_MS) {
  await page.waitForFunction(
    () => { const el = document.querySelector('#realift-config');
      if (!el) return false; try { JSON.parse(el.textContent || '{}'); return true; } catch (_) { return false; } },
    { timeout: settleMs }
  ).catch(() => {});

  await page.waitForFunction(
    () => !!document.querySelector('realift-button')?.shadowRoot?.querySelector('button'),
    { timeout: settleMs }
  ).catch(() => {});

  return page.evaluate(() => {
    const cfgEl = document.querySelector('#realift-config');
    let sizeChart = '';
    if (cfgEl) { try { sizeChart = String(JSON.parse(cfgEl.textContent || '{}').sizeChart ?? ''); } catch (_) {} }
    const btn = document.querySelector('realift-button');
    const inner = btn?.shadowRoot?.querySelector('button');
    let shadowVisible = false, box = '';
    if (inner) {
      const r = inner.getBoundingClientRect();
      const cs = getComputedStyle(inner);
      shadowVisible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      box = `${Math.round(r.width)}x${Math.round(r.height)}`;
    }
    let matched_keyword = '', match_field = '', matched_value = '', is_excluded = '',
        excluded_keyword = '', resolution_source = '', resolution_collection = '';
    const dbg = document.querySelector('#realift-debug-context');
    if (dbg) {
      try {
        const d = JSON.parse(dbg.textContent || '{}');
        matched_keyword = d.matched_keyword ?? '';
        match_field = d.matched_field ?? d.match_field ?? d.field ?? '';
        matched_value = d.matched_value ?? '';
        is_excluded = (d.is_excluded ?? '') === '' ? '' : String(d.is_excluded);
        excluded_keyword = d.excluded_keyword ?? '';
        resolution_source = d.resolution_source ?? '';
        resolution_collection = d.resolution_collection_title ?? d.resolution_collection_id ?? '';
      } catch (_) {}
    }
    return { sizeChart, shadowVisible, box, matched_keyword, match_field, matched_value, is_excluded, excluded_keyword, resolution_source, resolution_collection };
  });
}
const isRendered = (s) => s.sizeChart.length > 0 && s.shadowVisible;

async function probe(page, handle, settleMs = SETTLE_MS) {
  const url = withPreview(`${BASE}${PATH_PREFIX}/products/${handle}?realift-debug-console=show`);
  const resp = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
  if (resp && resp.status() === 404) throw new Error('HTTP 404 (unpublished / bad handle)');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return readRenderState(page, settleMs);
}

function verdict(expectRender, rendered, s) {
  if (expectRender) return rendered
    ? ['PASS', `footwear renders (box ${s.box})`]
    : ['FAIL', s.sizeChart ? 'COVERAGE GAP — chart set but no paint' : 'COVERAGE GAP — no chart/no paint'];
  return rendered
    ? ['FAIL', `LEAK — scanner on non-footwear (kw "${s.matched_keyword || '?'}")`]
    : ['PASS', 'suppressed'];
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────
const COLS = ['group','classify_why','product_type','handle','status','reason','sizeChart','shadowVisible','box','matched_keyword','match_field','matched_value','is_excluded','excluded_keyword','resolution_source','resolution_collection','reverify','certified','url'];
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = (r) => COLS.map((c) => csvCell(r[c])).join(',');
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function readCsvObjects(csvPath) {
  if (!existsSync(csvPath)) return [];
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).filter((r) => r.length >= COLS.length).slice(1)
    .map((r) => { const o = {}; COLS.forEach((k, i) => (o[k] = r[i])); return o; });
  // CSV is an append-only log — a handle may appear twice (e.g. Phase 1 row,
  // then a later Phase-2 re-verify update for the same handle). Last write wins.
  const byHandle = new Map();
  for (const o of rows) byHandle.set(o.handle, o);
  return [...byHandle.values()];
}

// ─── catalog/category grouping (non-footwear split) ──────────────────────────────
function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'uncategorized';
}

// Groups by product_type, case-insensitively (Shopify catalogs are often entered
// with inconsistent casing, e.g. "Singlets" vs "SINGLETS" — those are the same
// catalog and would otherwise fragment into duplicate near-empty reports).
function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const raw = (item.product_type || '').trim();
    const key = raw.toLowerCase() || '(uncategorized)';
    if (!groups.has(key)) groups.set(key, { label: raw || 'Uncategorized', items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

// ─── ETA estimate ───────────────────────────────────────────────────────────────
// Calibrated from this tool's own observed throughput (page nav + networkidle
// wait + fixed settle checks) — the dominant cost per item is one full settle
// timeout, since the common case (a correctly-suppressed non-footwear PDP, or a
// footwear PDP that genuinely renders) waits out `settleMs` on the render probe.
const PROBE_OVERHEAD_MS = 29000;
const estimateGroupSeconds = (itemCount, settleMs, concurrency) =>
  Math.ceil((itemCount / concurrency) * (PROBE_OVERHEAD_MS + settleMs) / 1000);
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── run group ─────────────────────────────────────────────────────────────────
async function runGroup({ browser, group, items, stamp, expectRender }) {
  const SUFFIX = `-${group}`;
  const CSV_PATH = out(`${SLUG}-realift-sweep${SUFFIX}.csv`);
  const PROGRESS_PATH = out(`${SLUG}-realift-sweep${SUFFIX}.progress`);
  const settleMs = expectRender ? SETTLE_MS : SETTLE_NEGATIVE_MS;

  const done = new Set();
  const pendingReverify = [];
  if (existsSync(CSV_PATH)) {
    for (const o of readCsvObjects(CSV_PATH)) {
      if (o.status !== 'ERROR') done.add(o.handle);
      // FAIL rows from a run that got interrupted before Phase 2 never got a
      // `certified` verdict — re-verify them now instead of silently dropping
      // them from the report (they won't be in `queue` since they're `done`).
      if (o.status === 'FAIL' && !o.certified) pendingReverify.push({ item: { handle: o.handle, product_type: o.product_type, why: o.classify_why }, row: o });
    }
  } else writeFileSync(CSV_PATH, COLS.join(',') + '\n');

  let queue = items.filter((p) => !done.has(p.handle));
  if (Number.isFinite(LIMIT)) queue = queue.slice(0, LIMIT);

  const resumeNote = pendingReverify.length ? `, ${pendingReverify.length} pending re-verify from prior run` : '';
  console.log(`\n━━━ ${group.toUpperCase()} pass — ${queue.length} to audit (already done ${done.size}${resumeNote}) · concurrency ${CONCURRENCY} · settle ${settleMs}ms ━━━`);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.clearCookies();

  let idx = 0, completed = 0, pass = 0, fail = 0, error = 0;
  const total = queue.length;
  const flagged = [...pendingReverify];

  async function worker(wid) {
    let page = await ctx.newPage();
    while (true) {
      const my = idx++;
      if (my >= queue.length) break;
      const item = queue[my];
      if (page.isClosed()) { try { page = await ctx.newPage(); } catch (_) { page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); } }
      let row;
      try {
        const s = await probe(page, item.handle, settleMs);
        const [status, reason] = verdict(expectRender, isRendered(s), s);
        row = { group, classify_why: item.why, product_type: item.product_type, handle: item.handle, status, reason, sizeChart: s.sizeChart ? s.sizeChart.slice(0, 12) : '', shadowVisible: s.shadowVisible, box: s.box, matched_keyword: s.matched_keyword, match_field: s.match_field, matched_value: s.matched_value, is_excluded: s.is_excluded, excluded_keyword: s.excluded_keyword, resolution_source: s.resolution_source, resolution_collection: s.resolution_collection, reverify: '', certified: '', url: withPreview(`${BASE}${PATH_PREFIX}/products/${item.handle}`) };
        if (status === 'FAIL') flagged.push({ item, row });
      } catch (err) {
        const msg = String(err.message || err).replace(/\s+/g, ' ').slice(0, 140);
        row = { group, classify_why: item.why, product_type: item.product_type, handle: item.handle, status: 'ERROR', reason: msg, sizeChart: '', shadowVisible: '', box: '', matched_keyword: '', match_field: '', matched_value: '', is_excluded: '', excluded_keyword: '', resolution_source: '', resolution_collection: '', reverify: '', certified: '', url: withPreview(`${BASE}${PATH_PREFIX}/products/${item.handle}`) };
      }
      appendFileSync(CSV_PATH, csvRow(row) + '\n');
      completed++;
      if (row.status === 'PASS') pass++; else if (row.status === 'FAIL') fail++; else error++;
      const icon = row.status === 'PASS' ? '🟢' : row.status === 'FAIL' ? '🔴' : '⚪';
      console.log(`${icon} [${String(completed).padStart(3)}/${total}] w${wid} ${group.padEnd(12)} ${item.handle.slice(0, 46).padEnd(46)} ${row.status === 'PASS' ? row.reason : row.status === 'FAIL' ? '‼ ' + row.reason : '404/err'}`);
      if (completed % 25 === 0 || completed === total) { const m = `progress ${completed}/${total}   🟢${pass} 🔴${fail} ⚪${error}`; writeFileSync(PROGRESS_PATH, m + '\n'); }
      try { if (!page.isClosed()) await page.waitForTimeout(PAGE_POLITE_MS); } catch (_) {}
    }
    try { if (!page.isClosed()) await page.close(); } catch (_) {}
  }

  if (queue.length) await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) => worker(i + 1)));

  // Phase 2: 3x re-verify
  const certified = [];
  if (flagged.length) {
    console.log(`\n🔁 Re-verifying ${flagged.length} flagged ${group} failures (${REVERIFY_N}× each, fresh context)...`);
    const rvCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await rvCtx.clearCookies();
    const rp = await rvCtx.newPage();
    await rp.goto(withPreview(`${BASE}${PATH_PREFIX}/`), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (const { item, row } of flagged) {
      const passes = [];
      for (let i = 0; i < REVERIFY_N; i++) { try { const s = await probe(rp, item.handle, settleMs); passes.push(isRendered(s) ? 'RENDER' : 'suppress'); } catch (_) { passes.push('ERROR'); } await rp.waitForTimeout(PAGE_POLITE_MS); }
      const badState = expectRender ? 'suppress' : 'RENDER';
      const reproduced = passes.every((p) => p === badState);
      const flaky = !reproduced && passes.some((p) => p === badState);
      const cert = reproduced ? 'CONFIRMED' : flaky ? 'FLAKY' : 'CLEARED';
      const certRow = { ...row, reverify: passes.join('|'), certified: cert };
      // Persist this re-verified result immediately — it must not depend on
      // reaching the end of the flagged list (a dropped connection mid-sweep
      // used to lose every result that hadn't been batch-written yet).
      appendFileSync(CSV_PATH, csvRow(certRow) + '\n');
      certified.push(certRow);
      console.log(`  ${cert === 'CONFIRMED' ? '🔴' : cert === 'FLAKY' ? '🟠' : '🟢'} ${cert.padEnd(9)} ${row.handle} [${passes.join(', ')}]`);
    }
    await rvCtx.close();
  }
  await ctx.close();

  const allRows = readCsvObjects(CSV_PATH);
  const summary = {
    group, audited: allRows.length,
    pass: allRows.filter((r) => r.status === 'PASS').length,
    fail: allRows.filter((r) => r.status === 'FAIL').length,
    error: allRows.filter((r) => r.status === 'ERROR').length,
    csv: CSV_PATH,
  };
  copyFileSync(CSV_PATH, out(`${SLUG}-realift-sweep${SUFFIX}-${stamp}.csv`));
  return { summary, certified, rows: allRows };
}

// ─── reports ──────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);

function buildMarkdown({ catalog, footCount, traps, foot, nonfoot, footChart }) {
  const leaks = nonfoot.certified.filter((c) => c.certified === 'CONFIRMED');
  const gaps = foot.certified.filter((c) => c.certified === 'CONFIRMED');
  const flaky = [...foot.certified, ...nonfoot.certified].filter((c) => c.certified === 'FLAKY');
  const fV = foot.summary.fail === 0 ? '✅ PASS — full coverage' : `❌ FAIL — ${gaps.length} confirmed gap(s)`;
  const nV = leaks.length === 0 ? '✅ PASS — zero leaks' : `❌ FAIL — ${leaks.length} confirmed leak(s)`;
  const overall = (leaks.length + gaps.length) === 0 ? '✅ PASS' : '❌ FAIL';

  return `# ReaLift SDK — QA Sweep Report: ${SLUG} (preview)

**Date:** ${today()}
**Target:** \`${BASE}${PATH_PREFIX}\`
**Tool:** \`auto-qa-runner.mjs\` (Playwright)
**Overall verdict:** ${overall}

## Executive Summary
| Test Pass | PDPs Audited | Pass | Fail (Phase 1) | Confirmed (3x) | Verdict |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Footwear (Positive)** | ${foot.summary.audited} | ${foot.summary.pass} | ${foot.summary.fail} | ${gaps.length} | ${fV} |
| **Non-Footwear (Negative)** | ${nonfoot.summary.audited} | ${nonfoot.summary.pass} | ${nonfoot.summary.fail} | ${leaks.length} | ${nV} |

---
## Confirmed Leaks
${leaks.length === 0 ? '_No confirmed leaks observed._' : leaks.map((r) => `- \`${r.handle}\`: [Link](${r.url})`).join('\n')}

## Confirmed Coverage Gaps
${gaps.length === 0 ? '_No confirmed coverage gaps observed._' : gaps.map((r) => `- \`${r.handle}\`: [Link](${r.url})`).join('\n')}
`;
}

function buildJiraWiki({ catalog, footCount, traps, foot, nonfoot, footChart }) {
  const leaks = nonfoot.certified.filter((c) => c.certified === 'CONFIRMED');
  const gaps = foot.certified.filter((c) => c.certified === 'CONFIRMED');
  return `h1. ReaLift QA Audit Results
*Date:* ${today()}
*Leaks:* ${leaks.length}
*Gaps:* ${gaps.length}
`;
}

// ─── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`\n🚀 Starting ReaLift SDK QA Orchestrator [${SLUG}]`);
  console.log(` 🌐 Target URL: ${BASE}${PATH_PREFIX}`);

  const catalog = await loadCatalog();
  console.log(`📦 Catalog loaded: ${catalog.length} total products.`);

  const footwearItems = [];
  const nonFootwearItems = [];
  const traps = [];

  for (const p of catalog) {
    const cls = classify(p);
    const item = { ...p, why: cls.why };
    if (cls.footwear) footwearItems.push(item);
    else {
      nonFootwearItems.push(item);
      if (FOOT_TITLE_RX.test(p.title || '')) traps.push({ item, cls });
    }
  }

  console.log(`👟 Footwear: ${footwearItems.length} | 🚫 Non-Footwear: ${nonFootwearItems.length}`);

  const categories = groupByCategory(nonFootwearItems).map((c) => ({
    ...c,
    slug: slugify(c.label),
    etaSeconds: estimateGroupSeconds(c.items.length, SETTLE_NEGATIVE_MS, CONCURRENCY),
  }));
  const totalEtaSeconds = categories.reduce((s, c) => s + c.etaSeconds, 0);
  console.log(`\n📋 Non-footwear split into ${categories.length} catalog/category group(s):`);
  for (const c of categories) {
    console.log(`   • ${c.label.padEnd(30)} ${String(c.items.length).padStart(5)} items  ~${formatDuration(c.etaSeconds).padStart(8)}  → ${SLUG}-realift-sweep-${c.slug}.csv`);
  }
  console.log(`   TOTAL estimated Phase-1 time: ~${formatDuration(totalEtaSeconds)} (settle-negative=${SETTLE_NEGATIVE_MS}ms, concurrency=${CONCURRENCY}; excludes the re-verify pass, whose size isn't known until Phase 1 flags failures)\n`);

  const browser = await chromium.launch({ headless: !HEADED });

  let footRes;
  const nonfootResults = [];
  try {
    footRes = await runGroup({ browser, group: 'footwear', items: footwearItems, stamp, expectRender: true });
    for (const c of categories) {
      console.log(`\n▶ Starting catalog "${c.label}" — ${c.items.length} items — ETA ~${formatDuration(c.etaSeconds)}`);
      nonfootResults.push(await runGroup({ browser, group: c.slug, items: c.items, stamp, expectRender: false }));
    }
  } finally {
    await browser.close();
  }
  const nonfootRes = {
    summary: {
      group: 'non-footwear (all catalogs)',
      audited: nonfootResults.reduce((s, r) => s + r.summary.audited, 0),
      pass: nonfootResults.reduce((s, r) => s + r.summary.pass, 0),
      fail: nonfootResults.reduce((s, r) => s + r.summary.fail, 0),
      error: nonfootResults.reduce((s, r) => s + r.summary.error, 0),
      csv: nonfootResults.map((r) => r.summary.csv),
    },
    certified: nonfootResults.flatMap((r) => r.certified),
    rows: nonfootResults.flatMap((r) => r.rows),
  };

  const footChart = footRes.rows.find((r) => r.sizeChart)?.sizeChart || '';
  const reportData = { catalog, footCount: footwearItems.length, traps, foot: footRes, nonfoot: nonfootRes, footChart };

  writeFileSync(out(`realift-qa-report-${SLUG}.md`), buildMarkdown(reportData));
  writeFileSync(out(`jira-description-${SLUG}.md`), buildJiraWiki(reportData));

  const totalIssues = nonfootRes.certified.filter((c) => c.certified === 'CONFIRMED').length + footRes.certified.filter((c) => c.certified === 'CONFIRMED').length;

  if (totalIssues === 0) {
    console.log(`\n✨ AUDIT PASSED: Zero confirmed leaks or coverage gaps!`);
    process.exit(0);
  } else {
    console.error(`\n💥 AUDIT FAILED: Issues found.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n💥 Fatal orchestrator crash:', err);
  process.exit(2);
});