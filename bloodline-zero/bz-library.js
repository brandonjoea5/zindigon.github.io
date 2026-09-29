// Bloodline Zero | My Library: owned episodes + reading progress.

(function () {
  const centsToStr = (c) => `$${(c / 100).toFixed(2)}`;

  function renderSignedOut() {
    document.getElementById("libraryBody").innerHTML = `
      <div class="bz-signed-out">
        <p>Sign in to see the episodes you've unlocked and pick up where you left off.</p>
        <button class="bz-btn bz-btn-primary" id="libSignInBtn" type="button">Sign in</button>
      </div>`;
    document.getElementById("libSignInBtn").addEventListener("click", () => window.bzOpenModal("signin"));
  }

  function renderLibrary(library) {
    const owned = library.filter((e) => e.is_free || e.owned);
    const locked = library.filter((e) => !e.is_free && !e.owned);
    const body = document.getElementById("libraryBody");

    if (owned.length === 0) {
      body.innerHTML = `
        <div class="bz-signed-out">
          <p>You haven't unlocked any episodes yet. Episode 1 is free.</p>
          <a class="bz-btn bz-btn-primary" href="/bloodline-zero/episodes/1.html">Start Reading</a>
        </div>`;
      return;
    }

    const rows = owned.map((ep) => {
      const progress = ep.progress?.percent || 0;
      const label = progress >= 99 ? "Read again" : progress > 0 ? "Continue" : "Read";
      return `
        <div class="bz-ep-row is-owned">
          <div class="bz-ep-num">Episode ${String(ep.number).padStart(2, "0")}</div>
          <div class="bz-ep-main">
            <h3><a href="/bloodline-zero/episodes/${ep.number}.html">${zxEsc(ep.title)}</a></h3>
            <div class="bz-ep-meta">${ep.reading_time_min} min read${progress > 0 ? ` · ${progress}% read` : ""}</div>
            ${progress > 0 ? `<div class="bz-ep-progress-mini"><span style="width:${progress}%"></span></div>` : ""}
          </div>
          <div class="bz-ep-action">
            <a class="bz-btn bz-btn-primary" href="/bloodline-zero/episodes/${ep.number}.html">${label}</a>
          </div>
        </div>`;
    }).join("");

    const lockedNote = locked.length > 0
      ? `<div class="bz-section-head" style="margin-top:48px;">
           <h2 style="font-size:20px;">${locked.length} more episode${locked.length === 1 ? "" : "s"} waiting</h2>
           <p><a href="/bloodline-zero/#directory">Browse the full directory &rarr;</a></p>
         </div>`
      : "";

    body.innerHTML = `<div class="bz-ep-list">${rows}</div>${lockedNote}`;
  }

  function renderToast() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("checkout");
    if (!status) return;
    const el = document.getElementById("checkoutToast");
    if (status === "success") {
      el.innerHTML = `<div class="bz-toast">Payment received. Your library is updating now.</div>`;
    } else if (status === "cancelled") {
      el.innerHTML = `<div class="bz-toast">Checkout was cancelled. Nothing was charged.</div>`;
    }
  }

  async function load() {
    const auth = window.ZindigonAuth;
    if (!auth.isSignedIn()) {
      renderSignedOut();
      return;
    }
    try {
      const library = await bzFetchLibrary();
      renderLibrary(library);
    } catch (err) {
      document.getElementById("libraryBody").innerHTML =
        `<div class="bz-state">Couldn't load your library right now. Try refreshing.</div>`;
      console.error(err);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    renderToast();
    window.bzOnAccountChange = load;
    await bzInitAccount();
    await load();

    // The Stripe webhook usually lands within a second or two of the
    // redirect back here; one quiet re-fetch covers that gap without
    // making the visitor manually refresh.
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      setTimeout(load, 2500);
    }
  });
})();
