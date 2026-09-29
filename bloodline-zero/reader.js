// Bloodline Zero | episode reader: fetches the gated body, renders
// prose or a locked-episode gate, tracks reading progress, and wires
// previous/next navigation. `window.BZ_EPISODE` (number) and
// `window.BZ_EPISODES_META` (public list, no bodies) are inlined by
// each generated episodes/N.html page.

(function () {
  const number = window.BZ_EPISODE;
  const meta = window.BZ_EPISODES_META || [];
  const centsToStr = (c) => `$${(c / 100).toFixed(2)}`;

  function paragraphsToHtml(body) {
    return body
      .split(/\n\n+/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        if (/^\*{3,}$/.test(block)) return `<div class="bz-scene-break">◆ ◆ ◆</div>`;
        return `<p>${zxEsc(block).replace(/\n/g, "<br/>")}</p>`;
      })
      .join("\n");
  }

  function renderNav() {
    const prev = meta.find((e) => e.number === number - 1);
    const next = meta.find((e) => e.number === number + 1 && e.number !== 14);
    const wrap = document.getElementById("epNav");

    const prevHtml = prev
      ? `<a class="bz-ep-nav-link" href="/bloodline-zero/episodes/${prev.number}.html">
           <span class="bz-ep-nav-label">Previous</span>
           <span class="bz-ep-nav-title">${zxEsc(prev.title)}</span>
         </a>`
      : `<span></span>`;

    const nextHtml = next
      ? `<a class="bz-ep-nav-link is-next" href="/bloodline-zero/episodes/${next.number}.html">
           <span class="bz-ep-nav-label">Next episode</span>
           <span class="bz-ep-nav-title">${zxEsc(next.title)}</span>
         </a>`
      : `<a class="bz-ep-nav-link is-next" href="/bloodline-zero/">
           <span class="bz-ep-nav-label">That's all so far</span>
           <span class="bz-ep-nav-title">Back to Episodes</span>
         </a>`;

    wrap.innerHTML = `${prevHtml}<a class="bz-ep-nav-all" href="/bloodline-zero/#directory">All Episodes</a>${nextHtml}`;
  }

  function renderGateSignIn(ep) {
    document.getElementById("readerBody").innerHTML = `
      <div class="bz-gate">
        <h2>Sign in to continue</h2>
        <p>${zxEsc(ep.teaser)}</p>
        <div class="bz-gate-price">${ep.price_cents > 0 ? `<strong>${centsToStr(ep.price_cents)}</strong> to unlock` : ""}</div>
        <button class="bz-btn bz-btn-primary" id="gateSignInBtn" type="button">Sign in</button>
      </div>`;
    document.getElementById("gateSignInBtn").addEventListener("click", () => window.bzOpenModal("signin"));
  }

  function renderGateLocked(ep, priceCents) {
    document.getElementById("readerBody").innerHTML = `
      <div class="bz-gate">
        <h2>Unlock this episode</h2>
        <p>${zxEsc(ep.teaser)}</p>
        <div class="bz-gate-price"><strong>${centsToStr(priceCents)}</strong> · one-time, yours to keep</div>
        <button class="bz-btn bz-btn-primary" id="gateUnlockBtn" type="button">Unlock Episode ${number}</button>
      </div>`;
    document.getElementById("gateUnlockBtn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Redirecting to checkout…";
      try {
        await bzStartCheckout([number]);
      } catch (err) {
        alert(err.message || "Could not start checkout.");
        btn.disabled = false;
        btn.textContent = `Unlock Episode ${number}`;
      }
    });
  }

  function renderStory(episode) {
    document.getElementById("readerBody").innerHTML =
      `<div class="bz-prose">${paragraphsToHtml(episode.body)}</div>`;
  }

  // ---- Reading progress ------------------------------------------------
  let lastSentPercent = -1;
  let progressTimer = null;

  function currentScrollPercent() {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - doc.clientHeight;
    if (scrollable <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round((doc.scrollTop / scrollable) * 100)));
  }

  function wireProgressTracking(canTrackServerSide) {
    const rail = document.getElementById("progressBar");
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const pct = currentScrollPercent();
        if (rail) rail.style.width = pct + "%";
        if (canTrackServerSide) scheduleProgressSave(pct);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    if (canTrackServerSide) {
      window.addEventListener("pagehide", () => sendProgress(currentScrollPercent()));
    }
  }

  function scheduleProgressSave(pct) {
    if (Math.abs(pct - lastSentPercent) < 5 && pct < 99) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => sendProgress(pct), 1500);
  }

  async function sendProgress(pct) {
    if (pct === lastSentPercent) return;
    lastSentPercent = pct;
    try {
      await bzPostProgress(number, pct);
    } catch (err) {
      // Non-fatal: reading still works without progress sync.
      console.warn("progress save failed", err);
    }
  }

  async function load() {
    const localMeta = meta.find((e) => e.number === number) || {};
    try {
      const episode = await bzFetchEpisode(number);
      renderStory(episode);
      // The progress rail always tracks scroll visually; only signed-in
      // readers have anywhere server-side to save it to.
      wireProgressTracking(window.ZindigonAuth.isSignedIn());
    } catch (err) {
      if (err.status === 401) {
        renderGateSignIn(localMeta);
      } else if (err.status === 403 && err.body?.error === "not_purchased") {
        renderGateLocked(localMeta, err.body.price_cents ?? localMeta.price_cents);
      } else if (err.status === 404) {
        document.getElementById("readerBody").innerHTML = `<div class="bz-state">Episode not found.</div>`;
      } else {
        document.getElementById("readerBody").innerHTML = `<div class="bz-state">Couldn't load this episode right now. Try refreshing.</div>`;
        console.error(err);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    renderNav();
    window.bzOnAccountChange = load;
    await bzInitAccount();
    load();
  });
})();
