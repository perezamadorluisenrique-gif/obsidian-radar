/* Obsidian Radar: the only script. Every list page already works without it; this adds the theme and language
   toggles, list filtering, the search page and the plugin page (all from small precomputed JSON files). */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: the toggle still works for this page */ } },
  };
  var nf = new Intl.NumberFormat('en-US');
  var fmt = function (n) { return n === null || n === undefined ? '–' : nf.format(Math.round(n)); };

  // ---- language: English in the HTML, Spanish from window.RADAR_ES (assets/i18n.js) ---------------------------------
  var ES = window.RADAR_ES || {};
  var lang = store.get('radar-lang') === 'es' ? 'es' : 'en';
  var hooks = [];
  function t(key, en) { return lang === 'es' && ES[key] ? ES[key] : en; }
  function applyLang() {
    root.lang = lang;
    $$('[data-i18n]').forEach(function (el) {
      if (el.dataset.en === undefined) el.dataset.en = el.textContent;
      el.textContent = lang === 'es' && ES[el.dataset.i18n] ? ES[el.dataset.i18n] : el.dataset.en;
    });
    $$('[data-i18n-ph]').forEach(function (el) {
      if (el.dataset.enPh === undefined) el.dataset.enPh = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', lang === 'es' && ES[el.dataset.i18nPh] ? ES[el.dataset.i18nPh] : el.dataset.enPh);
    });
    $$('[data-i18n-label]').forEach(function (el) {
      if (el.dataset.enLabel === undefined) el.dataset.enLabel = el.getAttribute('aria-label') || '';
      el.setAttribute('aria-label', lang === 'es' && ES[el.dataset.i18nLabel] ? ES[el.dataset.i18nLabel] : el.dataset.enLabel);
    });
    var b = $('#lang');
    if (b) { b.textContent = lang === 'es' ? 'EN' : 'ES'; b.title = lang === 'es' ? 'English' : 'Español'; }
    hooks.forEach(function (h) { h(); });
  }
  var langBtn = $('#lang');
  if (langBtn) langBtn.addEventListener('click', function () { lang = lang === 'es' ? 'en' : 'es'; store.set('radar-lang', lang); applyLang(); });

  // ---- theme ---------------------------------------------------------------------------------------------------------
  var themeBtn = $('#theme');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var cur = root.getAttribute('data-theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store.set('radar-theme', next);
  });

  // ---- list filter (name/description text + category) ----------------------------------------------------------------
  var bar = $('.filterbar');
  if (bar) {
    var input = $('.filter', bar), sel = $('.catfilter', bar);
    var count = doc.createElement('span');
    count.className = 'count';
    count.setAttribute('aria-live', 'polite');
    bar.appendChild(count);
    var apply = function () {
      var q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean), c = sel.value, shown = 0, all = 0;
      $$('li.row[data-text]').forEach(function (li) {
        all++;
        var ok = q.every(function (w) { return li.dataset.text.indexOf(w) >= 0; }) && (!c || (' ' + li.dataset.cats + ' ').indexOf(' ' + c + ' ') >= 0);
        li.hidden = !ok;
        if (ok) shown++;
      });
      count.textContent = q.length || c ? shown + ' / ' + all : '';
    };
    input.addEventListener('input', apply);
    sel.addEventListener('change', apply);
  }

  // ---- shared: rows are built with DOM calls and textContent only, because plugin text is untrusted -----------------
  function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function link(href, text, cls) { var a = el('a', cls, text); a.href = href; return a; }
  function pluginHref(id) { return 'plugin.html?id=' + encodeURIComponent(id); }
  function numCell(label, key, value) {
    var d = el('div'); var dt = el('dt', '', t(key, label)); d.appendChild(dt); d.appendChild(el('dd', '', value)); return d;
  }

  // ---- search page ---------------------------------------------------------------------------------------------------
  var results = $('#results');
  if (results) (function () {
    var qEl = $('#q'), chips = $('#chips'), status = $('#status');
    var params = new URLSearchParams(location.search);
    var cat = params.get('cat') || '';
    var index = null, rows = [], failed = false;
    qEl.value = params.get('q') || '';
    var MAX = 100;

    function load() {
      status.textContent = t('search.loading', 'Loading the index…');
      fetch('search.json').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
        index = j;
        var labels = {}; j.cats.forEach(function (c) { labels[c[0]] = c[1]; });
        rows = j.plugins.map(function (r) {
          var cats = r[4] ? r[4].split(',').map(function (i) { return j.cats[+i][0]; }) : [];
          var catText = cats.map(function (c) { return labels[c]; }).join(' ');
          return { id: r[0], name: r[1], dl: r[2], d1: r[3], cats: cats, nameL: r[1].toLowerCase(), hay: (r[1] + ' ' + r[0] + ' ' + r[5] + ' ' + catText).toLowerCase() };
        });
        j.cats.forEach(function (c) {
          var b = el('button', 'chip', c[1]); b.type = 'button'; b.dataset.cat = c[0]; b.setAttribute('aria-pressed', String(cat === c[0]));
          b.addEventListener('click', function () { cat = cat === c[0] ? '' : c[0]; chips.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.cat === cat)); }); run(); });
          chips.appendChild(b);
        });
        run();
      }).catch(function () { failed = true; status.textContent = 'Could not load search.json.'; });
    }

    function run() {
      if (!index) return;
      var q = qEl.value.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
      var hits = rows.filter(function (r) { return (!cat || r.cats.indexOf(cat) >= 0) && words.every(function (w) { return r.hay.indexOf(w) >= 0; }); });
      hits.forEach(function (r) { r.score = !q ? 0 : r.nameL === q ? 3 : r.nameL.indexOf(q) === 0 ? 2 : r.nameL.indexOf(q) > 0 ? 1 : 0; });
      hits.sort(function (a, b) { return b.score - a.score || b.dl - a.dl || (a.id < b.id ? -1 : 1); });
      results.textContent = '';
      hits.slice(0, MAX).forEach(function (r) {
        var li = el('li', 'row'), main = el('div', 'main'), nums = el('dl', 'nums');
        main.appendChild(link(pluginHref(r.id), r.name, 'name'));
        main.appendChild(el('p', 'desc', r.id));
        nums.appendChild(numCell('downloads', 'download', fmt(r.dl)));
        if (r.d1 !== null && r.d1 !== undefined) nums.appendChild(numCell('per week', 'perweek', '+' + fmt(r.d1)));
        li.appendChild(main); li.appendChild(nums); results.appendChild(li);
      });
      status.textContent = hits.length ? (hits.length > MAX ? t('search.top', 'Showing the top') + ' ' + MAX + ' / ' + fmt(hits.length) : fmt(hits.length) + ' ' + t('search.found', 'plugins')) : t('search.none', 'Nothing matches.');
      var u = new URL(location.href);
      q ? u.searchParams.set('q', qEl.value.trim()) : u.searchParams.delete('q');
      cat ? u.searchParams.set('cat', cat) : u.searchParams.delete('cat');
      try { history.replaceState(null, '', u); } catch (e) { /* file:// or sandboxed frame */ }
    }
    qEl.addEventListener('input', run);
    qEl.closest('form').addEventListener('submit', function (e) { e.preventDefault(); run(); });
    hooks.push(function () { if (index) run(); else if (!failed) status.textContent = t('search.loading', 'Loading the index…'); });
    load();
    if (qEl.value === '') qEl.focus({ preventScroll: true });
  })();

  // ---- plugin page ---------------------------------------------------------------------------------------------------
  var host = $('#plugin');
  if (host) (function () {
    var id = new URLSearchParams(location.search).get('id');
    var data = null;
    if (!id) { host.textContent = ''; host.appendChild(el('h1', '', t('plugin.title', 'Plugin'))); var none = el('p', 'muted', 'No plugin id given. '); none.appendChild(link('search.html', t('search.title', 'Search'))); host.appendChild(none); return; }
    var file = 'p/' + id.replace(/[^a-z0-9._-]/gi, '_') + '.json';
    var lastW = 0;
    window.addEventListener('resize', function () { if (data && Math.abs(host.clientWidth - lastW) > 24) render(); });
    fetch(file).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) { data = j; doc.title = j.name + ' · ' + doc.title.replace(/^.*? · /, ''); render(); hooks.push(render); })
      .catch(function () { host.textContent = ''; host.appendChild(el('h1', '', id)); var p = el('p', 'muted', 'Plugin "' + id + '" is not in this week\'s snapshot. '); p.appendChild(link('search.html?q=' + encodeURIComponent(id), 'Search for it')); host.appendChild(p); });

    function fact(label, key, value, note) {
      var d = el('div', 'stat'), dt = el('dt', '', t(key, label)); d.appendChild(dt); d.appendChild(el('dd', '', value));
      if (note) d.appendChild(el('small', '', note)); return d;
    }
    function ago(iso) { return iso ? iso : '–'; }
    function render() {
      var p = data; host.textContent = ''; lastW = host.clientWidth;
      var crumb = el('p', 'crumb'); var back = link('index.html', '← ' + t('nav.week', 'This week')); crumb.appendChild(back); host.appendChild(crumb);
      var head = el('div', 'pl-head'); head.appendChild(el('h1', '', p.name)); host.appendChild(head);
      var meta = el('p', 'muted');
      meta.appendChild(doc.createTextNode(p.id));
      p.cats.forEach(function (c) { meta.appendChild(doc.createTextNode(' ')); meta.appendChild(el('span', 'badge gap', c)); });
      if (p.newcomer) { meta.appendChild(doc.createTextNode(' ')); meta.appendChild(el('span', 'badge ok', t('plugin.newcomer', 'newcomer'))); }
      if (p.arch) { meta.appendChild(doc.createTextNode(' ')); meta.appendChild(el('span', 'badge est', t('plugin.archived', 'archived'))); }
      if (p.gone) { meta.appendChild(doc.createTextNode(' ')); meta.appendChild(el('span', 'badge est', t('plugin.gone', 'repository unreachable'))); }
      host.appendChild(meta);
      if (p.desc) host.appendChild(el('p', 'lead', p.desc));
      var links = el('p');
      links.appendChild(link(p.urls.directory, t('plugin.directory', 'Obsidian directory')));
      if (p.urls.repository) { links.appendChild(doc.createTextNode(' · ')); links.appendChild(link(p.urls.repository, t('plugin.repo', 'Repository'))); links.appendChild(doc.createTextNode(' · ')); links.appendChild(link(p.urls.issues, t('plugin.issues', 'Issues'))); }
      host.appendChild(links);
      if (p.maint) {
        var n = el('aside', 'notice'); n.setAttribute('role', 'note');
        n.appendChild(el('strong', '', t('plugin.maint', 'Looking for a maintainer?') + ' '));
        n.appendChild(doc.createTextNode(t('plugin.maint.body', 'Loved (many downloads) but quiet for') + ' ' + Math.floor(p.maint.quietDays / 30.44) + ' ' + t('months', 'months') + '. '));
        n.appendChild(link('maintainers.html', t('nav.maint', 'Looking for maintainers')));
        host.appendChild(n);
      }
      var facts = el('dl', 'facts');
      facts.appendChild(fact('Downloads', 'download', fmt(p.dl), '#' + fmt(p.rank) + ' / ' + fmt(p.of)));
      facts.appendChild(fact('Per week', 'perweek', p.d1 === null ? '–' : '+' + fmt(p.d1), p.r1 === null || p.r1 === undefined ? '' : '+' + (p.r1 * 100).toFixed(p.r1 < 0.1 ? 1 : 0) + '%'));
      if (p.stars !== null) facts.appendChild(fact('Stars', 'plugin.stars', fmt(p.stars)));
      if (p.issues !== null) facts.appendChild(fact('Open issues', 'issues', fmt(p.issues)));
      if (p.push) facts.appendChild(fact('Last push', 'plugin.push', ago(p.push)));
      if (p.rel) facts.appendChild(fact('Last release', 'plugin.release', ago(p.rel)));
      facts.appendChild(fact('Listed since', 'plugin.listed', ago(p.listed), p.ageSrc === 'order' || p.ageSrc === 'repo' ? t('age.est', 'age estimated') : ''));
      host.appendChild(facts);
      host.appendChild(chart(p.series, p.name));
      if (p.similar.length) {
        var sec = el('section'); sec.appendChild(el('h2', '', t('plugin.similar', 'Similar plugins')));
        var ol = el('ol', 'rows');
        p.similar.forEach(function (s) {
          var li = el('li', 'row'), main = el('div', 'main'), nums = el('dl', 'nums');
          main.appendChild(link(pluginHref(s.id), s.name, 'name')); main.appendChild(el('p', 'desc', Math.round(s.sim * 100) + '% ' + t('plugin.match', 'match')));
          nums.appendChild(numCell('downloads', 'download', fmt(s.dl)));
          li.appendChild(main); li.appendChild(nums); ol.appendChild(li);
        });
        sec.appendChild(ol); host.appendChild(sec);
      }
    }

    // One series, one axis: downloads over time. 2px line, surface-ringed markers, crosshair + tooltip, and a table view.
    function weekDate(w) { // ISO week "2026-W43" -> Monday, UTC
      var m = /^(\d{4})-W(\d{2})$/.exec(w); if (!m) return 0;
      var jan4 = Date.UTC(+m[1], 0, 4), dow = (new Date(jan4).getUTCDay() + 6) % 7;
      return jan4 - dow * 864e5 + (+m[2] - 1) * 7 * 864e5;
    }
    function chart(series, name) {
      var box = el('section', 'chartbox'); box.appendChild(el('h2', '', t('plugin.history', 'Downloads over time')));
      if (!series.length) { box.appendChild(el('p', 'muted', '–')); return box; }
      if (series.length < 2) {
        box.appendChild(el('p', 'muted', t('plugin.nohist', 'History begins at our first snapshot; the line appears after the next weekly run.')));
        var one = el('p'); one.appendChild(el('strong', '', fmt(series[0][1]))); one.appendChild(doc.createTextNode(' · ' + series[0][0])); box.appendChild(one);
        return box;
      }
      // Drawn at its real pixel width (re-drawn on resize), so the 11px labels stay 11px on a phone.
      var W = Math.max(260, Math.min(720, host.clientWidth - 30)), H = 220, R = 14, T = 12, B = 26;
      var xs = series.map(function (s) { return weekDate(s[0]); }), ys = series.map(function (s) { return s[1]; });
      var x0 = xs[0], x1 = xs[xs.length - 1], lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
      if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
      var pad = (hi - lo) * 0.08; lo = Math.max(0, lo - pad); hi += pad;
      var ticks = [0, 1, 2, 3].map(function (i) { return lo + (hi - lo) * i / 3; });
      var L = Math.max.apply(null, ticks.map(function (v) { return fmt(v).length; })) * 6.4 + 14;
      var X = function (v) { return L + (x1 === x0 ? 0 : (v - x0) / (x1 - x0)) * (W - L - R); };
      var Y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); };
      var NS = 'http://www.w3.org/2000/svg';
      var svg = doc.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', name + ': ' + t('plugin.history', 'Downloads over time') + ', ' + series[0][0] + ' – ' + series[series.length - 1][0]);
      function s(tag, attrs, text) { var e = doc.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; svg.appendChild(e); return e; }
      ticks.forEach(function (v) { var y = Y(v); s('line', { x1: L, x2: W - R, y1: y, y2: y, 'class': 'grid' }); s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', 'class': 'axis' }, fmt(v)); });
      s('text', { x: L, y: H - 6, 'class': 'axis' }, series[0][0]); s('text', { x: W - R, y: H - 6, 'text-anchor': 'end', 'class': 'axis' }, series[series.length - 1][0]);
      s('path', { d: series.map(function (_, k) { return (k ? 'L' : 'M') + X(xs[k]).toFixed(1) + ' ' + Y(ys[k]).toFixed(1); }).join(''), 'class': 'line' });
      var cross = s('line', { y1: T, y2: H - B, 'class': 'cross', visibility: 'hidden' });
      var dot = s('circle', { r: 4, 'class': 'dot', visibility: 'hidden' });
      s('circle', { cx: X(xs[xs.length - 1]), cy: Y(ys[ys.length - 1]), r: 4, 'class': 'dot' });
      var tip = el('div', 'tip'); tip.hidden = true; tip.setAttribute('role', 'status');
      function show(evt) {
        var r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) / r.width * W, best = 0, bd = Infinity;
        xs.forEach(function (x, k) { var d = Math.abs(X(x) - px); if (d < bd) { bd = d; best = k; } });
        var cx = X(xs[best]), cy = Y(ys[best]);
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
        var gain = best ? ys[best] - ys[best - 1] : null;
        tip.textContent = series[best][0] + ' · ' + fmt(ys[best]) + (gain === null ? '' : ' (' + (gain >= 0 ? '+' : '') + fmt(gain) + ')');
        tip.hidden = false;
        var bw = box.getBoundingClientRect(), left = Math.min(Math.max(r.left - bw.left + cx / W * r.width, 60), bw.width - 60);
        tip.style.left = left + 'px'; tip.style.top = (r.top - bw.top + cy / H * r.height) + 'px';
      }
      function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
      svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show); svg.addEventListener('pointerleave', hide);
      box.appendChild(svg); box.appendChild(tip);
      var det = el('details'); det.appendChild(el('summary', '', t('plugin.table', 'View as table')));
      var wrap = el('div', 'tablewrap'), tb = el('table', 'datatable'), th = el('tr');
      th.appendChild(el('th', '', 'Week')); th.appendChild(el('th', '', t('download', 'downloads'))); tb.appendChild(th);
      series.slice().reverse().forEach(function (r) { var tr = el('tr'); tr.appendChild(el('td', '', r[0])); tr.appendChild(el('td', '', fmt(r[1]))); tb.appendChild(tr); });
      wrap.appendChild(tb); det.appendChild(wrap); box.appendChild(det);
      return box;
    }
  })();

  applyLang();
})();
