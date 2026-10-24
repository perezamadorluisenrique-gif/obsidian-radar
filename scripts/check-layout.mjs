#!/usr/bin/env node
// Browser check of the built site (dist/) with Playwright: serves dist/ on localhost and opens every page.
//
//   node scripts/check-layout.mjs [dist] [--shots <dir>]
//
//   - 375px (and 320px) wide: no horizontal scroll on any page, incl. a plugin page, search results, a maintainer card;
//   - no page error / console error / failed request on any page;
//   - dark mode: follows the OS setting, and the toggle overrides it both ways;
//   - search finds a plugin by name and by category keyword; the plugin page renders (chart when there is history);
//   - the language toggle switches the chrome to Spanish and back; the list filter hides rows.
// Playwright is not a dependency of the project (it is only needed here): it is resolved from node_modules, or from
// the global install, and CI installs it with `npm i --no-save playwright` and uses the runner's Chrome.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch { /* try the global install */ }
  try { return createRequire(`${execSync('npm root -g', { encoding: 'utf8' }).trim()}/`)('playwright'); } catch { /* fall through */ }
  throw new Error('playwright is not installed (npm i --no-save playwright)');
}

export function serve(dist) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/html' }); res.end(fs.existsSync(path.join(dist, '404.html')) ? fs.readFileSync(path.join(dist, '404.html')) : 'not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })));
}

export async function checkLayout(dist, { shots = null, log = () => {} } = {}) {
  const { chromium } = loadPlaywright();
  const problems = [];
  const bad = (m) => { problems.push(m); log(`  ✗ ${m}`); };
  const { server, base } = await serve(dist);
  let browser;
  try {
    try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
    const search = JSON.parse(fs.readFileSync(path.join(dist, 'search.json'), 'utf8'));
    const top = [...search.plugins].sort((a, b) => b[2] - a[2]);
    const longest = [...search.plugins].sort((a, b) => b[1].length - a[1].length)[0];
    const ideas = JSON.parse(fs.readFileSync(path.join(dist, 'ideas.json'), 'utf8'));
    const pluginIds = [...new Set([top[0][0], top[1][0], longest[0], ideas.maintainersWanted[0]?.id].filter(Boolean))];
    const pages = fs.readdirSync(dist).filter((f) => f.endsWith('.html')).map((f) => f);
    const urls = [...pages, ...pluginIds.map((id) => `plugin.html?id=${encodeURIComponent(id)}`), 'search.html?q=git', `search.html?q=${encodeURIComponent(top[0][1])}`];
    const checked = [];

    for (const width of [375, 320]) {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      for (const u of urls) {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
        page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
        page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/404.html') && !(u === '404.html')) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
        await page.goto(base + u, { waitUntil: 'networkidle' });
        if (u.startsWith('plugin.html?')) await page.waitForSelector('#plugin h1', { timeout: 5000 }).catch(() => bad(`${u}: plugin page never rendered`));
        if (u.startsWith('search.html?q=')) await page.waitForSelector('#results li', { timeout: 5000 }).catch(() => bad(`${u}: no search results`));
        const m = await page.evaluate(() => {
          const de = document.documentElement, vw = window.innerWidth;
          const wide = [];
          for (const e of document.body.querySelectorAll('*')) {
            const r = e.getBoundingClientRect();
            if (r.width > 0 && r.right > vw + 1) {
              let clipped = false;
              for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break; } }
              if (!clipped) wide.push(`${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? `.${e.className.split(' ')[0]}` : ''} → right ${Math.round(r.right)}`);
            }
          }
          return { scrollW: de.scrollWidth, clientW: de.clientWidth, bodyScrollW: document.body.scrollWidth, wide: wide.slice(0, 5), h1: document.querySelector('h1')?.textContent ?? null };
        });
        if (m.scrollW > m.clientW || m.bodyScrollW > m.clientW) bad(`${u} @${width}px: horizontal scroll (scrollWidth ${m.scrollW} > ${m.clientW}); wide elements: ${m.wide.join('; ') || 'none found'}`);
        else if (m.wide.length) bad(`${u} @${width}px: elements poke out of the viewport: ${m.wide.join('; ')}`);
        if (!m.h1 && u !== '404.html') bad(`${u}: no <h1>`);
        for (const e of errors) bad(`${u} @${width}px: ${e}`);
        if (shots && width === 375) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${u.replace(/[^a-z0-9]+/gi, '_')}.png`), fullPage: false }); }
        checked.push(`${u}@${width}`);
        await page.close();
      }
      await ctx.close();
    }

    // dark mode: OS setting, then the toggle both ways
    {
      const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const dctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: 'dark' });
      const page = await dctx.newPage();
      await page.goto(`${base}index.html`, { waitUntil: 'networkidle' });
      if (lum(await bg(page)) > 0.2) bad('dark mode: the OS dark setting does not darken the page');
      await page.click('#theme');
      if (lum(await bg(page)) < 0.5) bad('dark mode: the toggle does not switch a dark OS to light');
      await page.reload({ waitUntil: 'networkidle' });
      if (lum(await bg(page)) < 0.5) bad('dark mode: the chosen theme is not remembered after a reload');
      await page.click('#theme');
      if (lum(await bg(page)) > 0.2) bad('dark mode: the toggle does not switch back to dark');
      if (shots) await page.screenshot({ path: path.join(shots, 'dark_index.png') });
      await page.goto(`${base}plugin.html?id=${encodeURIComponent(pluginIds[0])}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#plugin h1');
      if (shots) await page.screenshot({ path: path.join(shots, 'dark_plugin.png') });
      await dctx.close();
      checked.push('dark mode');
    }

    // behaviour: search, plugin page, language, filter
    {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: 'light' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}search.html`, { waitUntil: 'networkidle' });
      await page.fill('#q', top[0][1]);
      await page.waitForSelector('#results li');
      const first = await page.$eval('#results li .name', (a) => a.getAttribute('href'));
      if (!first.includes('plugin.html?id=')) bad(`search: result link is "${first}"`);
      const n0 = await page.$$eval('#results li', (l) => l.length);
      await page.fill('#q', 'zzzqqqxxx');
      if ((await page.$$eval('#results li', (l) => l.length)) !== 0) bad('search: nonsense query still shows results');
      await page.fill('#q', '');
      const chip = await page.$('#chips button');
      if (!chip) bad('search: no category chips'); else {
        await chip.click();
        const n1 = await page.$$eval('#results li', (l) => l.length);
        if (!(n1 > 0 && n1 <= n0 + 100)) bad(`search: category chip gave ${n1} results`);
        if ((await chip.getAttribute('aria-pressed')) !== 'true') bad('search: chip is not marked pressed');
      }
      const cat = search.cats.find((c) => c[0] === 'calendar') ?? search.cats[0];
      await page.fill('#q', cat[1].split(/[ &]/)[0]);
      if ((await page.$$eval('#results li', (l) => l.length)) === 0) bad(`search: category keyword "${cat[1].split(/[ &]/)[0]}" finds nothing`);
      await page.goto(`${base}plugin.html?id=${encodeURIComponent(pluginIds[0])}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#plugin h1');
      if (!(await page.$('#plugin .facts'))) bad('plugin page: no facts');
      const series = JSON.parse(fs.readFileSync(path.join(dist, 'p', `${pluginIds[0].replace(/[^a-z0-9._-]/gi, '_')}.json`), 'utf8')).series;
      if (series.length >= 2) {
        if (!(await page.$('#plugin svg.chart'))) bad('plugin page: history exists but no chart is drawn');
        // Let layout settle (fonts, a resize-triggered redraw), approach from outside the chart so a pointermove really fires,
        // and re-query the chart after every step because a redraw replaces the <svg>.
        // On a phone the chart sits below the fold, and the mouse only reaches what is inside the viewport.
        await page.waitForTimeout(250);
        await page.mouse.move(2, 2);
        let tipShown = false;
        for (let attempt = 0; attempt < 4 && !tipShown; attempt++) {
          await (await page.$('#plugin svg.chart')).scrollIntoViewIfNeeded();
          const box = await (await page.$('#plugin svg.chart')).boundingBox();
          await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2, { steps: 5 });
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
          tipShown = !(await page.$eval('#plugin .tip', (t) => t.hidden));
          if (!tipShown) await page.waitForTimeout(250);
        }
        if (!tipShown) bad('plugin page: hovering the chart shows no tooltip');
      } else if (!(await page.$('#plugin .chartbox'))) bad('plugin page: no chart box for a plugin with a single data point');
      await page.goto(`${base}plugin.html?id=does-not-exist`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => /not in this week/.test(document.getElementById('plugin').textContent));
      await page.goto(`${base}index.html`, { waitUntil: 'networkidle' });
      const navEn = await page.$eval('nav a', (a) => a.textContent);
      await page.click('#lang');
      const navEs = await page.$eval('nav a', (a) => a.textContent);
      if (navEs === navEn) bad(`language: nav still "${navEs}" after switching to Spanish`);
      if ((await page.$eval('html', (h) => h.lang)) !== 'es') bad('language: <html lang> not updated');
      await page.goto(`${base}growing.html`, { waitUntil: 'networkidle' });
      if ((await page.$eval('h1', (h) => h.textContent)) === 'Growing') bad('language: Spanish choice not remembered on the next page');
      await page.click('#lang');
      if ((await page.$eval('h1', (h) => h.textContent)) !== 'Growing') bad('language: switching back to English failed');
      const rows = await page.$$eval('li.row[data-text]', (l) => l.length);
      if (rows > 1) {
        await page.fill('.filter', 'zzzqqqxxx');
        if ((await page.$$eval('li.row[data-text]:not([hidden])', (l) => l.length)) !== 0) bad('filter: nonsense text still shows rows');
        await page.fill('.filter', '');
        if ((await page.$$eval('li.row[data-text]:not([hidden])', (l) => l.length)) !== rows) bad('filter: clearing the text does not restore the rows');
      }
      for (const e of errors) bad(`behaviour: pageerror ${e}`);
      await ctx.close();
      checked.push('search', 'plugin page', 'language', 'filter');
    }
    return { problems, checked };
  } finally {
    await browser?.close();
    server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const si = args.indexOf('--shots');
  const shots = si >= 0 ? path.resolve(args.splice(si, 2)[1]) : null;
  const dist = path.resolve(args[0] ?? 'dist');
  if (!fs.existsSync(dist)) { console.error(`[layout] ${dist} does not exist; run \`npm run build\` first`); process.exit(2); }
  try {
    const r = await checkLayout(dist, { shots, log: (m) => console.error(m) });
    console.log(`[layout] ${r.checked.length} checks (${r.checked.filter((c) => c.endsWith('@375')).length} pages at 375px, same at 320px)`);
    if (r.problems.length) { console.error(`[layout] ${r.problems.length} problem(s)`); process.exit(1); }
    console.log('[layout] OK');
  } catch (e) {
    console.error(`[layout] FAILED: ${e.stack || e.message}`);
    process.exit(1);
  }
}
