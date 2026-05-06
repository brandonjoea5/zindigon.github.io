/* Zindigon site.js — 2026 */

/* ── Year ─────────────────────────────────────── */
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

/* ── Mobile nav ───────────────────────────────── */
const menuBtn = document.getElementById('menuBtn');
const mobileNav = document.getElementById('mobileNav');
if (menuBtn && mobileNav) {
  menuBtn.addEventListener('click', () => {
    const open = mobileNav.dataset.open === 'true';
    mobileNav.dataset.open = String(!open);
    menuBtn.setAttribute('aria-expanded', String(!open));
  });
}

/* ── Starfield + Nebula Background ───────────────
   Layers:
   1. Nebula blobs   — soft drifting color (canvas radial gradients)
   2. Falling stars  — 3 speed layers, DPR-aware (your original approach)
   3. Mouse parallax — subtle offset per layer
   4. Shooting stars — random streaks every 4–8s
   5. Vignette       — your original radial darkening
─────────────────────────────────────────────── */
(() => {
  const c = document.getElementById('starfield');
  if (!c) return;
  const ctx = c.getContext('2d');

  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let w = 0, h = 0;
  let stars = [], nebulae = [], shooters = [];
  let lastShooter = 0;
  let mouse = { x: 0.5, y: 0.5 };
  let rafId;

  const C = {
    accent: 'rgba(0,245,196,',
    blue:   'rgba(91,158,255,',
    pink:   'rgba(255,79,191,',
    white:  'rgba(232,238,255,',
  };

  function rand(a, b) { return Math.random() * (b - a) + a; }
  function pick(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }

  function makeStar() {
    const layer = Math.floor(Math.random() * 3); // 0=deep 1=mid 2=near
    const ck = pick(['white','white','white','white','blue','accent','pink']);
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r:     layer === 0 ? rand(.3,.7) : layer === 1 ? rand(.5,1.1) : rand(.8,1.7),
      a:     rand(.2, layer === 2 ? .95 : .65),
      v:     layer === 0 ? rand(.04,.12) : layer === 1 ? rand(.12,.28) : rand(.28,.55),
      para:  layer === 0 ? .003 : layer === 1 ? .008 : .016,
      color: C[ck],
      twOff: Math.random() * Math.PI * 2,
      twSpd: rand(.3, .9),
    };
  }

  function makeNebula() {
    const ck = pick(['accent','blue','pink','blue','accent','blue']);
    return {
      x: rand(.05, .95), y: rand(.05, .90),
      r: rand(140, 300),
      a: rand(.04, .09),
      color: C[ck],
      dx: rand(-.00006, .00006),
      dy: rand(-.00005, .00005),
    };
  }

  function makeShooting() {
    const angle = rand(-28, -12) * Math.PI / 180;
    return {
      x: rand(.1, .85) * w,
      y: rand(0, .35) * h,
      len: rand(90, 210),
      spd: rand(9, 20),
      dx: Math.cos(angle), dy: Math.sin(angle),
      life: 0, maxLife: rand(28, 52),
      color: pick([C.white, C.accent, C.blue]),
    };
  }

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    c.width  = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    c.style.width  = w + 'px';
    c.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.min(Math.floor(w * h / 3800), 280);
    stars = Array.from({ length: count }, makeStar);
    nebulae = Array.from({ length: 6 }, makeNebula);
    shooters = [];
  }

  function tick(ts) {
    rafId = requestAnimationFrame(tick);
    ctx.clearRect(0, 0, w, h);

    /* Vignette (your original) */
    const vg = ctx.createRadialGradient(
      w * .5, h * .5, Math.min(w, h) * .15,
      w * .5, h * .5, Math.max(w, h) * .65
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.40)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    /* Nebula blobs */
    for (const n of nebulae) {
      n.x = ((n.x + n.dx) + 1.2) % 1.2 - .1;
      n.y = ((n.y + n.dy) + 1.2) % 1.2 - .1;
      const grd = ctx.createRadialGradient(n.x*w, n.y*h, 0, n.x*w, n.y*h, n.r);
      grd.addColorStop(0, n.color + n.a + ')');
      grd.addColorStop(1, n.color + '0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(n.x * w, n.y * h, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    /* Stars — fall downward + gentle mouse parallax */
    const t = ts * .001;
    const mx = mouse.x - .5, my = mouse.y - .5;
    for (const s of stars) {
      s.y += s.v;
      if (s.y > h + 10) { s.y = -10; s.x = Math.random() * w; }

      const px = s.x + mx * s.para * w;
      const py = s.y + my * s.para * h;
      const twinkle = .55 + .45 * Math.sin(t * s.twSpd + s.twOff);
      const alpha = s.a * twinkle;

      ctx.beginPath();
      ctx.arc(px, py, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.color + alpha + ')';
      ctx.fill();
    }

    /* Shooting stars */
    if (ts - lastShooter > rand(4000, 8500)) {
      shooters.push(makeShooting());
      lastShooter = ts;
    }
    for (let i = shooters.length - 1; i >= 0; i--) {
      const sh = shooters[i];
      sh.x += sh.dx * sh.spd;
      sh.y += sh.dy * sh.spd;
      sh.life++;
      const a = 1 - sh.life / sh.maxLife;
      const grd = ctx.createLinearGradient(
        sh.x - sh.dx * sh.len, sh.y - sh.dy * sh.len, sh.x, sh.y
      );
      grd.addColorStop(0, sh.color + '0)');
      grd.addColorStop(1, sh.color + a + ')');
      ctx.strokeStyle = grd;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(sh.x - sh.dx * sh.len, sh.y - sh.dy * sh.len);
      ctx.lineTo(sh.x, sh.y);
      ctx.stroke();
      if (sh.life >= sh.maxLife) shooters.splice(i, 1);
    }
  }

  window.addEventListener('mousemove', e => {
    mouse.x = e.clientX / window.innerWidth;
    mouse.y = e.clientY / window.innerHeight;
  }, { passive: true });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { cancelAnimationFrame(rafId); resize(); tick(0); }, 150);
  }, { passive: true });

  resize();
  tick(0);
})();
