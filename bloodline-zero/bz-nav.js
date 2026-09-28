// Bloodline Zero | shared mobile-nav toggle. Loaded on every page.
(function () {
  const btn = document.getElementById("bzMenuBtn");
  const nav = document.getElementById("bzNav");
  if (!btn || !nav) return;
  btn.addEventListener("click", () => {
    const open = nav.dataset.open === "true";
    nav.dataset.open = String(!open);
    btn.setAttribute("aria-expanded", String(!open));
    btn.textContent = !open ? "Close" : "Menu";
  });
})();
