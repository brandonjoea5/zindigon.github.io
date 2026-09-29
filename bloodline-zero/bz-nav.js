// Bloodline Zero | shared mobile-nav toggle + header scroll state.
// Loaded on every page.
(function () {
  const btn = document.getElementById("bzMenuBtn");
  const nav = document.getElementById("bzNav");
  if (btn && nav) {
    btn.addEventListener("click", () => {
      const open = nav.dataset.open === "true";
      nav.dataset.open = String(!open);
      btn.setAttribute("aria-expanded", String(!open));
      btn.textContent = !open ? "Close" : "Menu";
    });
  }
})();

(function () {
  // The header is transparent at the very top of the page so it reads
  // as part of the hero image. Past a small scroll threshold it gains
  // a translucent smoky backdrop (see .bz-scrolled in style.css) so it
  // separates from the background without becoming a solid boxed bar.
  const header = document.querySelector(".bz-header");
  if (!header) return;
  const SCROLL_THRESHOLD = 8;
  const syncScrollState = () => {
    header.classList.toggle("bz-scrolled", window.scrollY > SCROLL_THRESHOLD);
  };
  syncScrollState();
  window.addEventListener("scroll", syncScrollState, { passive: true });
})();
