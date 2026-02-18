/* Zindigon site JS (no dependencies)
   - mobile nav toggle
   - active nav marker (aria-current)
   - subtle starfield canvas
*/
(function(){
  const byId = (id)=>document.getElementById(id);

  // Mobile menu
  const btn = byId('menuBtn');
  const mobile = byId('mobileNav');
  if(btn && mobile){
    btn.addEventListener('click', ()=>{
      const isOpen = mobile.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(isOpen));
    });
  }

  // Active nav (works even if you forget to set on a page)
  const path = (location.pathname || '/').replace(/\/+$/,'') || '/';
  const links = document.querySelectorAll('[data-nav] a');
  links.forEach(a=>{
    try{
      const href = a.getAttribute('href');
      if(!href) return;
      const u = new URL(href, location.origin);
      let p = (u.pathname || '/').replace(/\/+$/,'') || '/';
      // Make "/index.html" behave like "/"
      if(p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length) || '/';
      if(path === p || (p !== '/' && path.startsWith(p))){
        a.setAttribute('aria-current','page');
      } else {
        a.removeAttribute('aria-current');
      }
    }catch(_){}
  });

  // Footer year
  const year = byId('year');
  if(year) year.textContent = String(new Date().getFullYear());

  // Starfield
  const c = byId('starfield');
  if(!c) return;
  const ctx = c.getContext('2d');
  if(!ctx) return;

  let W=0,H=0,stars=[];
  const DPR = Math.min(2, window.devicePixelRatio || 1);

  function rand(min,max){ return Math.random()*(max-min)+min; }

  function resize(){
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    c.width = Math.floor(W * DPR);
    c.height = Math.floor(H * DPR);
    c.style.width = W+'px';
    c.style.height = H+'px';
    ctx.setTransform(DPR,0,0,DPR,0,0);

    const count = Math.floor((W*H) / 14000);
    stars = new Array(Math.max(90, Math.min(220, count))).fill(0).map(()=>({
      x: rand(0,W),
      y: rand(0,H),
      r: rand(.4, 1.6),
      a: rand(.15, .75),
      s: rand(.08, .35)
    }));
  }

  function tick(){
    ctx.clearRect(0,0,W,H);
    for(const st of stars){
      st.y += st.s;
      if(st.y > H + 8){ st.y = -8; st.x = rand(0,W); }
      ctx.globalAlpha = st.a;
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI*2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener('resize', resize, {passive:true});
  requestAnimationFrame(tick);
})();
