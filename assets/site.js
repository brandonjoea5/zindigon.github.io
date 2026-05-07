/* Zindigon — site.js (2026 rebrand)
   Shared: year, mobile nav, live clock, parallax dot grid,
   leaderboard fetch, latest version pull. */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* Year ─────────────────────────────────────── */
  $$('[data-year]').forEach(el => el.textContent = new Date().getFullYear());

  /* Mobile nav ───────────────────────────────── */
  const menuBtn = $('#menuBtn');
  const mobileNav = $('#mobileNav');
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', () => {
      const open = mobileNav.dataset.open === 'true';
      mobileNav.dataset.open = String(!open);
      menuBtn.setAttribute('aria-expanded', String(!open));
      menuBtn.textContent = !open ? 'Close' : 'Menu';
    });
  }

  /* Live clock (UTC offset shown locally) ────── */
  const clockEl = $('#navClock');
  if (clockEl) {
    const tick = () => {
      const d = new Date();
      const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      clockEl.textContent = t + ' LOCAL';
    };
    tick();
    setInterval(tick, 30 * 1000);
  }

  /* Parallax dot grid on scroll ──────────────── */
  const grid = $('.fx-grid');
  if (grid) {
    let raf = 0;
    const update = () => {
      const y = window.scrollY * 0.08;
      grid.style.transform = `translate3d(0, ${-y}px, 0)`;
      raf = 0;
    };
    window.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(update);
    }, { passive: true });
  }

  /* ───────── Leaderboard ───────── */
  const JSONBIN_API = 'https://api.jsonbin.io/v3/b';
  const BIN_ID = '69fb6fae6373f77b4253ba55';
  const JSONBIN_KEY = '$2a$10$E763Q2oUYh3m6gbIuFQ5TO77CzVFzMzQiSBFUIv7t9pztyovxXgIG';

  const fmt = n => Number(n).toLocaleString();

  function renderLb(data, opts = {}) {
    const body = $('#lb-body');
    const meta = $('#lb-meta');
    if (!body) return;
    if (!data || data.length === 0) {
      body.innerHTML = `<div class="lb-empty">No scores yet — be the first to set one</div>`;
      if (meta) meta.textContent = '0 entries';
      return;
    }
    const limit = opts.limit || 10;
    const rows = data.slice(0, limit).map((e, i) => {
      const cls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      const rank = String(i + 1).padStart(2, '0');
      return `<tr>
        <td class="lb-rank ${cls}">${rank}</td>
        <td class="lb-name">${(e.name || '—').replace(/[<>]/g, '')}</td>
        <td class="lb-score">${fmt(e.score)}</td>
        <td class="lb-wave">w.${e.wave || '—'}</td>
      </tr>`;
    }).join('');
    body.innerHTML = `<table class="lb-table">
      <thead><tr>
        <th>#</th><th>Player</th><th class="right">Score</th><th class="right">Wave</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    if (meta) {
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.textContent = `${data.length} player${data.length !== 1 ? 's' : ''} · updated ${t}`;
    }
  }

  async function loadLeaderboard(manual = false) {
    const body = $('#lb-body');
    const meta = $('#lb-meta');
    if (!body) return;
    if (manual) {
      body.innerHTML = `<div class="lb-loading">Refreshing<span class="dots"><i></i><i></i><i></i></span></div>`;
      if (meta) meta.textContent = 'refreshing…';
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`${JSONBIN_API}/${BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Meta': 'false' },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!r.ok) throw new Error('network');
      const data = await r.json();
      const limit = body.dataset.limit ? +body.dataset.limit : 10;
      renderLb(Array.isArray(data) ? data : [], { limit });
    } catch {
      try {
        const local = JSON.parse(localStorage.getItem('elementalRift_leaderboard') || '[]');
        renderLb(local);
        if (meta) meta.textContent = 'cached · play to update';
      } catch {
        body.innerHTML = `<div class="lb-empty">Could not load scores. Try again soon.</div>`;
        if (meta) meta.textContent = 'unavailable';
      }
    }
  }
  window.loadLeaderboard = loadLeaderboard;

  if ($('#lb-body')) {
    loadLeaderboard();
    const btn = $('#lb-refresh');
    if (btn) btn.addEventListener('click', () => loadLeaderboard(true));
  }

  /* ───────── Patch notes / version ───────── */
  // Static, hand-curated. Easy to update — surfaces on home and projects.
  window.ZIN_VERSIONS = [
    { ver: 'v1.74', when: 'Today',     desc: 'Trinity artifact rebalance; new boss telegraphs.' },
    { ver: 'v1.73', when: '3d ago',    desc: 'Cloud save migration; account-linked progression.' },
    { ver: 'v1.72', when: '1w ago',    desc: 'Class system pass — Pyromancer + Tideborn tuning.' },
    { ver: 'v1.71', when: '2w ago',    desc: 'New endless mode; leaderboards segmented by class.' },
  ];

  const versList = $('#versions-list');
  if (versList) {
    versList.innerHTML = window.ZIN_VERSIONS.map(v =>
      `<li>
        <span class="ver">${v.ver}</span>
        <span class="desc">${v.desc}</span>
        <span class="when">${v.when}</span>
      </li>`).join('');
  }

  const lastUpdate = $('#lastUpdate');
  if (lastUpdate && window.ZIN_VERSIONS[0]) {
    lastUpdate.textContent = `${window.ZIN_VERSIONS[0].ver} · ${window.ZIN_VERSIONS[0].when}`;
  }
})();
