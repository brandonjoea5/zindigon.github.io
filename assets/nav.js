/* Zindigon nav.js (site-wide shared header, footer, account widget)
   Include on every page with just two tags, nothing else required:
     <link rel="stylesheet" href="/assets/nav.css"/>
     <script src="/assets/nav.js" defer></script>
   This injects the header as the first element of <body> and the
   footer as the last, highlights the active nav group from the current
   path, wires click/tap-to-toggle dropdowns (desktop and mobile use the
   same logic, no hover dependency), and renders a Sign In / account
   menu backed by the shared window.ZindigonAuth (assets/auth-shared.js).
   It loads that script itself if a page hasn't already, so no page has
   to remember to include it separately. */

(function () {
  const SUPABASE_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
  const AUTH_SHARED_SRC = "/assets/auth-shared.js";

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ───────── Markup ───────────────────────────────────────────── */

  const HEADER_HTML = `
    <header class="zin-header" id="zinHeader">
      <nav class="zin-nav" aria-label="Primary">
        <a class="zin-brand" href="/">
          <span class="zin-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16"><path d="M2 3 L14 3 L2 13 L14 13"/></svg>
          </span>
          <span class="zin-brand-name">Zindigon</span>
        </a>

        <div class="zin-nav-links" id="zinNavLinks">
          <a href="/" data-group="home">Home</a>

          <div class="zin-drop" data-group="games">
            <button class="zin-drop-btn" type="button" aria-expanded="false" aria-haspopup="true">
              Games <span class="zin-caret" aria-hidden="true"></span>
            </button>
            <div class="zin-drop-menu" role="menu">
              <a href="/games/#play-now" role="menuitem">Play Now</a>
              <a href="/games/#in-development" role="menuitem">In Development</a>
              <a href="/games/#prototypes" role="menuitem">Prototypes</a>
              <a href="/games/#archive" role="menuitem">Paused / Archive</a>
            </div>
          </div>

          <div class="zin-drop" data-group="tools">
            <button class="zin-drop-btn" type="button" aria-expanded="false" aria-haspopup="true">
              Tools <span class="zin-caret" aria-hidden="true"></span>
            </button>
            <div class="zin-drop-menu" role="menu">
              <a href="/dcuo/" role="menuitem">DCUO</a>
              <a href="/lol/" role="menuitem">Zindigon League</a>
            </div>
          </div>

          <div class="zin-drop" data-group="stories">
            <button class="zin-drop-btn" type="button" aria-expanded="false" aria-haspopup="true">
              Stories <span class="zin-caret" aria-hidden="true"></span>
            </button>
            <div class="zin-drop-menu" role="menu">
              <a href="/stories/bloodline-zero/" role="menuitem">Bloodline Zero</a>
            </div>
          </div>

          <a href="/contact/" data-group="contact">Contact</a>
        </div>

        <div class="zin-account" id="zinAccountBar"></div>

        <button class="zin-menu-btn" id="zinMenuBtn" type="button" aria-expanded="false" aria-controls="zinMobileNav">Menu</button>
      </nav>

      <div class="zin-mobile-nav" id="zinMobileNav">
        <a href="/" data-group="home">Home</a>

        <div class="zin-mobile-group" data-group="games">
          <button class="zin-mobile-group-btn" type="button" aria-expanded="false">
            Games <span class="zin-caret" aria-hidden="true"></span>
          </button>
          <div class="zin-mobile-group-menu">
            <a href="/games/#play-now">Play Now</a>
            <a href="/games/#in-development">In Development</a>
            <a href="/games/#prototypes">Prototypes</a>
            <a href="/games/#archive">Paused / Archive</a>
          </div>
        </div>

        <div class="zin-mobile-group" data-group="tools">
          <button class="zin-mobile-group-btn" type="button" aria-expanded="false">
            Tools <span class="zin-caret" aria-hidden="true"></span>
          </button>
          <div class="zin-mobile-group-menu">
            <a href="/dcuo/">DCUO</a>
            <a href="/lol/">Zindigon League</a>
          </div>
        </div>

        <div class="zin-mobile-group" data-group="stories">
          <button class="zin-mobile-group-btn" type="button" aria-expanded="false">
            Stories <span class="zin-caret" aria-hidden="true"></span>
          </button>
          <div class="zin-mobile-group-menu">
            <a href="/stories/bloodline-zero/">Bloodline Zero</a>
          </div>
        </div>

        <a href="/contact/" data-group="contact">Contact</a>

        <div class="zin-mobile-account" id="zinMobileAccountBar"></div>
      </div>
    </header>`;

  const FOOTER_HTML = `
    <footer class="zin-footer">
      <div class="zin-footer-inner">
        <div class="zin-footer-col">
          <div class="zin-brand" style="margin-bottom:14px;">
            <span class="zin-brand-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 3 L14 3 L2 13 L14 13"/></svg></span>
            <span class="zin-brand-name">Zindigon</span>
          </div>
          <p style="font-size:13px; max-width:36ch; color:var(--fg-mute);">Independent studio. Games, tools, and original worlds.</p>
        </div>
        <div class="zin-footer-col">
          <h4>Studio</h4>
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/games/">Games</a></li>
            <li><a href="/contact/">Contact</a></li>
          </ul>
        </div>
        <div class="zin-footer-col">
          <h4>Games</h4>
          <ul>
            <li><a href="/elementalrift/">Elemental Rift</a></li>
            <li><a href="/aetherfall/">AetherFall</a></li>
            <li><a href="/hypercell/">HyperCell</a></li>
            <li><a href="/nexusdefense/">Nexus Defense</a></li>
          </ul>
        </div>
        <div class="zin-footer-col">
          <h4>Tools &amp; Stories</h4>
          <ul>
            <li><a href="/dcuo/">DCUO Tools</a></li>
            <li><a href="/lol/">Zindigon League</a></li>
            <li><a href="/stories/bloodline-zero/">Bloodline Zero</a></li>
          </ul>
        </div>
        <div class="zin-footer-col">
          <h4>Reach</h4>
          <ul>
            <li><a href="mailto:contact@zindigon.com">contact@zindigon.com</a></li>
            <li><a href="/contact/">Contact form</a></li>
          </ul>
        </div>
      </div>
      <div class="zin-footer-bottom">
        <span>&copy; <span data-year></span> Zindigon.</span>
        <span class="zin-footer-legal"><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></span>
      </div>
    </footer>`;

  const MODAL_HTML = `
    <div class="zin-modal-overlay" id="zinModalOverlay" hidden>
      <div class="zin-modal" role="dialog" aria-modal="true" aria-labelledby="zinModalTitle">
        <button class="zin-modal-close" id="zinModalClose" type="button" aria-label="Close">&times;</button>
        <h3 id="zinModalTitle">Sign in</h3>
        <form id="zinForm">
          <div class="zin-field">
            <label for="zinEmail">Email</label>
            <input class="zin-input" type="email" id="zinEmail" required autocomplete="email"/>
          </div>
          <div class="zin-field">
            <label for="zinPassword">Password</label>
            <input class="zin-input" type="password" id="zinPassword" required minlength="6" autocomplete="current-password"/>
          </div>
          <p class="zin-error" id="zinError" hidden></p>
          <p class="zin-info" id="zinInfo" hidden></p>
          <button type="submit" class="zin-btn zin-btn-primary" id="zinSubmitBtn" style="width:100%; justify-content:center;">Sign in</button>
        </form>
        <p class="zin-switch">
          <span id="zinSwitchToSignUp">New here? <a href="#" id="zinGoSignUp">Create an account</a></span>
          <span id="zinSwitchToSignIn" hidden>Already have an account? <a href="#" id="zinGoSignIn">Sign in</a></span>
        </p>
      </div>
    </div>`;

  /* ───────── Skeleton injection ──────────────────────────────── */

  function injectSkeleton() {
    document.body.insertAdjacentHTML("afterbegin", HEADER_HTML);
    /* Pages that keep their own product-specific footer (legal disclaimers,
       product sub-links) already have a .site-footer in their markup.
       Don't stack a second, generic footer under it. */
    if (!document.querySelector(".site-footer")) {
      document.body.insertAdjacentHTML("beforeend", FOOTER_HTML);
    }
    document.body.insertAdjacentHTML("beforeend", MODAL_HTML);
    document.querySelectorAll("[data-year]").forEach((el) => { el.textContent = String(new Date().getFullYear()); });
  }

  /* ───────── Active nav highlighting ─────────────────────────── */

  const GROUPS = {
    games: ["/games/", "/aetherfall/", "/elementalrift/", "/hypercell/", "/nexusdefense/", "/tinyjumper/", "/tornix/", "/stackforge/", "/pbjstreats/"],
    tools: ["/dcuo/", "/toondata/", "/builds/", "/lol/"],
    stories: ["/stories/", "/bloodline-zero/"],
    contact: ["/contact/", "/contact.html"],
  };

  function highlightActive() {
    const path = window.location.pathname;
    let activeGroup = null;
    if (path === "/" || path === "/index.html") {
      activeGroup = "home";
    } else {
      for (const key in GROUPS) {
        if (GROUPS[key].some((p) => path.indexOf(p) === 0)) { activeGroup = key; break; }
      }
    }
    if (!activeGroup) return;
    document.querySelectorAll('[data-group="' + activeGroup + '"]').forEach((el) => {
      if (el.tagName === "A") el.setAttribute("aria-current", "page");
      else el.classList.add("is-active");
    });
  }

  /* ───────── Dropdowns (click/tap-to-toggle, desktop + mobile) ── */

  function closeAllDropdowns(except) {
    document.querySelectorAll(".zin-drop-btn[aria-expanded='true'], .zin-mobile-group-btn[aria-expanded='true']").forEach((btn) => {
      if (btn !== except) {
        btn.setAttribute("aria-expanded", "false");
        btn.closest(".zin-drop, .zin-mobile-group").classList.remove("is-open");
      }
    });
  }

  function wireDropdowns() {
    document.querySelectorAll(".zin-drop-btn, .zin-mobile-group-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wrap = btn.closest(".zin-drop, .zin-mobile-group");
        const open = btn.getAttribute("aria-expanded") === "true";
        closeAllDropdowns(open ? null : btn);
        btn.setAttribute("aria-expanded", String(!open));
        wrap.classList.toggle("is-open", !open);
      });
    });
    document.addEventListener("click", () => closeAllDropdowns(null));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllDropdowns(null);
    });
  }

  /* ───────── Mobile menu toggle ───────────────────────────────── */

  function wireMobileMenu() {
    const menuBtn = document.getElementById("zinMenuBtn");
    const mobileNav = document.getElementById("zinMobileNav");
    if (!menuBtn || !mobileNav) return;
    menuBtn.addEventListener("click", () => {
      const open = mobileNav.dataset.open === "true";
      mobileNav.dataset.open = String(!open);
      menuBtn.setAttribute("aria-expanded", String(!open));
      menuBtn.textContent = !open ? "Close" : "Menu";
      if (open) closeAllDropdowns(null);
    });
  }

  /* ───────── Account widget ──────────────────────────────────── */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  function ensureAuthLoaded() {
    const needsSupabase = !window.supabase;
    const chain = needsSupabase ? loadScript(SUPABASE_CDN) : Promise.resolve();
    return chain.then(() => {
      if (window.ZindigonAuth) return;
      return loadScript(AUTH_SHARED_SRC);
    });
  }

  let zinAcctMode = "signin";

  function openModal(mode) {
    zinAcctMode = mode;
    document.getElementById("zinModalOverlay").hidden = false;
    document.getElementById("zinModalTitle").textContent = mode === "signup" ? "Create an account" : "Sign in";
    document.getElementById("zinSubmitBtn").textContent = mode === "signup" ? "Sign up" : "Sign in";
    document.getElementById("zinSwitchToSignUp").hidden = mode === "signup";
    document.getElementById("zinSwitchToSignIn").hidden = mode !== "signup";
    document.getElementById("zinError").hidden = true;
    document.getElementById("zinInfo").hidden = true;
    document.getElementById("zinForm").reset();
  }

  function closeModal() {
    document.getElementById("zinModalOverlay").hidden = true;
  }

  function wireModal() {
    document.getElementById("zinModalClose").addEventListener("click", closeModal);
    document.getElementById("zinModalOverlay").addEventListener("click", (e) => {
      if (e.target.id === "zinModalOverlay") closeModal();
    });
    document.getElementById("zinGoSignUp").addEventListener("click", (e) => { e.preventDefault(); openModal("signup"); });
    document.getElementById("zinGoSignIn").addEventListener("click", (e) => { e.preventDefault(); openModal("signin"); });

    document.getElementById("zinForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const auth = window.ZindigonAuth;
      const email = document.getElementById("zinEmail").value.trim();
      const password = document.getElementById("zinPassword").value;
      const errEl = document.getElementById("zinError");
      const infoEl = document.getElementById("zinInfo");
      errEl.hidden = true;
      infoEl.hidden = true;
      try {
        if (zinAcctMode === "signup") {
          const { needsEmailConfirmation } = await auth.signUp(email, password);
          if (needsEmailConfirmation) {
            infoEl.textContent = "Check your email to confirm your account, then sign in.";
            infoEl.hidden = false;
            return;
          }
        } else {
          await auth.signInWithPassword(email, password);
        }
        closeModal();
        renderAccountBar();
      } catch (err) {
        errEl.textContent = (err && err.message) || "Something went wrong.";
        errEl.hidden = false;
      }
    });
  }

  function accountBarHtml(auth) {
    if (auth.isSignedIn() && auth.hasProfile()) {
      return `
        <span class="zin-account-name">${esc(auth.player.username)}</span>
        <button class="zin-btn zin-btn-text" data-zin-signout type="button">Sign out</button>`;
    }
    if (auth.isSignedIn() && !auth.hasProfile()) {
      return `
        <form class="zin-inline-form" data-zin-profile-form>
          <input class="zin-input" data-zin-profile-username placeholder="Choose a display name" required/>
          <button class="zin-btn zin-btn-primary" type="submit">Save</button>
        </form>`;
    }
    return `
      <button class="zin-btn zin-btn-text" data-zin-signin type="button">Sign in</button>
      <button class="zin-btn zin-btn-primary" data-zin-signup type="button">Sign up</button>`;
  }

  function wireAccountBarEvents(root, auth) {
    const signIn = root.querySelector("[data-zin-signin]");
    const signUp = root.querySelector("[data-zin-signup]");
    const signOut = root.querySelector("[data-zin-signout]");
    const profileForm = root.querySelector("[data-zin-profile-form]");
    if (signIn) signIn.addEventListener("click", () => openModal("signin"));
    if (signUp) signUp.addEventListener("click", () => openModal("signup"));
    if (signOut) signOut.addEventListener("click", async () => {
      await auth.signOut();
      renderAccountBar();
    });
    if (profileForm) profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = root.querySelector("[data-zin-profile-username]");
      const username = input.value.trim();
      if (!username) return;
      try {
        await auth.createProfile(username);
        renderAccountBar();
      } catch (err) {
        alert("Could not save display name: " + ((err && err.message) || "unknown error"));
      }
    });
  }

  function renderAccountBar() {
    const auth = window.ZindigonAuth;
    if (!auth) return;
    const desktop = document.getElementById("zinAccountBar");
    const mobile = document.getElementById("zinMobileAccountBar");
    const html = accountBarHtml(auth);
    if (desktop) { desktop.innerHTML = html; wireAccountBarEvents(desktop, auth); }
    if (mobile) { mobile.innerHTML = html; wireAccountBarEvents(mobile, auth); }
  }

  async function initAccount() {
    try {
      await ensureAuthLoaded();
    } catch (err) {
      console.warn("nav.js: could not load shared auth", err);
      return;
    }
    if (!window.ZindigonAuth) return;
    wireModal();
    await window.ZindigonAuth.init();
    renderAccountBar();
    window.ZindigonAuth.onChange(() => renderAccountBar());
  }

  /* ───────── Boot ─────────────────────────────────────────────── */

  injectSkeleton();
  highlightActive();
  wireDropdowns();
  wireMobileMenu();
  initAccount();
})();
