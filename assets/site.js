// Zindigon Site JS — lightweight UI + starfield
(() => {
  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  // Mobile nav toggle
  const btn = document.getElementById("menuBtn");
  const mobile = document.getElementById("mobileNav");
  if (btn && mobile) {
    btn.addEventListener("click", () => {
      const open = mobile.getAttribute("data-open") === "true";
      mobile.setAttribute("data-open", String(!open));
      btn.setAttribute("aria-expanded", String(!open));
    });
  }

  // Simple starfield
  const c = document.getElementById("starfield");
  if (!c) return;

  const ctx = c.getContext("2d");
  let w = 0, h = 0, dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  const starCount = 140;
  const stars = [];

  function resize() {
    w = Math.floor(window.innerWidth);
    h = Math.floor(window.innerHeight);
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    c.style.width = w + "px";
    c.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    stars.length = 0;
    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.6 + 0.3,
        a: Math.random() * 0.8 + 0.15,
        v: Math.random() * 0.25 + 0.05
      });
    }
  }

  function tick() {
    ctx.clearRect(0, 0, w, h);
    // Subtle vignette
    const g = ctx.createRadialGradient(w*0.5, h*0.5, Math.min(w,h)*0.15, w*0.5, h*0.5, Math.max(w,h)*0.65);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g;
    ctx.fillRect(0,0,w,h);

    for (const s of stars) {
      s.y += s.v;
      if (s.y > h + 10) {
        s.y = -10;
        s.x = Math.random() * w;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(234,240,255,${s.a})`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();
  tick();
})();
