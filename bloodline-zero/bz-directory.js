// Bloodline Zero | landing page — episode directory, bundle picker,
// continue-reading banner.

(function () {
  const centsToStr = (c) => `$${(c / 100).toFixed(2)}`;

  let episodes = [];       // merged public + (if signed in) owned/progress
  let pricingTable = null; // /pricing response
  const selected = new Set();

  function lockedEpisodes() {
    return episodes.filter((e) => !e.is_free && !e.owned);
  }

  function renderRows() {
    const list = document.getElementById("epList");
    if (!episodes.length) {
      list.innerHTML = `<div class="bz-state">No episodes published yet — check back soon.</div>`;
      return;
    }
    list.innerHTML = episodes.map((ep) => {
      const owned = !!ep.owned;
      const isFree = !!ep.is_free;
      const statusClass = isFree ? "is-free" : owned ? "is-owned" : "is-locked";
      const href = `/bloodline-zero/episodes/${ep.number}.html`;
      const progress = ep.progress?.percent;
      const showProgress = (isFree || owned) && typeof progress === "number" && progress > 0;

      const metaBits = [`${ep.reading_time_min} min read`];
      if (isFree) metaBits.push(`<span class="bz-tag-free">Free</span>`);
      else if (owned) metaBits.push(`Unlocked`);
      else metaBits.push(centsToStr(ep.price_cents));

      const actionTop = isFree || owned
        ? `<a class="bz-btn bz-btn-primary" href="${href}">${showProgress ? "Continue" : "Read"}</a>`
        : `<a class="bz-btn" href="${href}">Preview</a>`;

      const checkbox = (!isFree && !owned)
        ? `<label class="bz-ep-check">
             <input type="checkbox" class="bz-ep-select" data-number="${ep.number}" ${selected.has(ep.number) ? "checked" : ""}/>
             Add to bundle
           </label>`
        : "";

      return `
        <div class="bz-ep-row ${statusClass}">
          <div class="bz-ep-num">${String(ep.number).padStart(2, "0")}</div>
          <div class="bz-ep-main">
            <h3><a href="${href}">${zxEsc(ep.title)}</a></h3>
            <p class="bz-ep-teaser">${zxEsc(ep.teaser)}</p>
            <div class="bz-ep-meta">${metaBits.join(" · ")}</div>
            ${showProgress ? `<div class="bz-ep-progress-mini"><span style="width:${progress}%"></span></div>` : ""}
          </div>
          <div class="bz-ep-action">
            ${actionTop}
            ${checkbox}
          </div>
        </div>`;
    }).join("");

    list.querySelectorAll(".bz-ep-select").forEach((cb) => {
      cb.addEventListener("change", () => {
        const n = Number(cb.dataset.number);
        if (cb.checked) selected.add(n); else selected.delete(n);
        renderBundleBar();
      });
    });
  }

  function renderBundleBar() {
    const bar = document.getElementById("bundleBar");
    if (selected.size === 0 || !pricingTable) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const n = selected.size;
    const row = pricingTable.table.find((r) => r.episodes === n) || pricingTable.table[pricingTable.table.length - 1];
    const total = row ? row.total_cents : n * pricingTable.base_price_cents;
    const discount = row ? row.discount_cents : 0;

    document.getElementById("bundleCount").textContent = String(n);
    document.getElementById("bundleTotal").textContent = centsToStr(total);
    document.getElementById("bundleSave").textContent = discount > 0 ? `— saves ${centsToStr(discount)}` : "";
  }

  async function handleBuySelected() {
    if (selected.size === 0) return;
    const auth = window.ZindigonAuth;
    if (!auth.isSignedIn()) {
      window.bzOpenModal("signin");
      return;
    }
    const btn = document.getElementById("bundleBuyBtn");
    btn.disabled = true;
    btn.textContent = "Redirecting to checkout…";
    try {
      await bzStartCheckout(Array.from(selected));
    } catch (err) {
      alert(err.message || "Could not start checkout.");
      btn.disabled = false;
      btn.textContent = "Unlock selected";
    }
  }

  async function renderContinueReading() {
    const auth = window.ZindigonAuth;
    const section = document.getElementById("continueReading");
    if (!auth.isSignedIn()) { section.hidden = true; return; }

    const inProgress = episodes
      .filter((e) => (e.is_free || e.owned) && e.progress && e.progress.percent > 0 && e.progress.percent < 99)
      .sort((a, b) => new Date(b.progress.updated_at) - new Date(a.progress.updated_at));

    if (inProgress.length === 0) { section.hidden = true; return; }

    const ep = inProgress[0];
    document.getElementById("continueTitle").textContent = `Ep. ${ep.number} — ${ep.title}`;
    document.getElementById("continueBar").style.width = `${ep.progress.percent}%`;
    document.getElementById("continueLink").href = `/bloodline-zero/episodes/${ep.number}.html`;
    section.hidden = false;
  }

  async function load() {
    try {
      pricingTable = await bzFetchPricing();
    } catch (err) {
      console.warn("pricing load failed", err);
    }

    const auth = window.ZindigonAuth;

    try {
      if (auth.isSignedIn()) {
        episodes = await bzFetchLibrary();
      } else {
        episodes = (await bzFetchEpisodes()).map((e) => ({ ...e, owned: e.is_free, progress: null }));
      }
    } catch (err) {
      document.getElementById("epList").innerHTML =
        `<div class="bz-state">Couldn't load episodes right now. Try refreshing.</div>`;
      console.error(err);
      return;
    }

    renderRows();
    renderBundleBar();
    renderContinueReading();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("bundleBuyBtn")?.addEventListener("click", handleBuySelected);
    window.bzOnAccountChange = load;
    await bzInitAccount();
    load();
  });
})();
