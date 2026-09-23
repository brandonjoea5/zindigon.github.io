// Zindigon League | AI Insights — branching chat intake for the AI review
// feature. Replaces the old single-click "AI Review" flow: instead of
// firing straight at OpenAI with one fixed prompt, this asks a couple of
// quick, free (no-API-call) questions first — is this your match, and
// what you actually want out of it — then generates a review tailored to
// that answer. See workers/zindigon-league-api/src/index.js's
// REVIEW_SYSTEM_PROMPTS for the prompt each choice maps to; every terminal
// choice below (everything except the two branching questions themselves)
// calls /ai/review for real and spends one of the plan's monthly review
// credits, same as the original single-review design did.
//
// Depends on auth-shared.js (esc) and billing-shared.js (requestAiReview,
// requestAiFollowup) already being loaded first.

const AiInsights = (() => {
  const panel = () => document.getElementById("aiReviewPanel");
  const resultEl = () => document.getElementById("result");
  const chatEl = () => document.getElementById("insightsChat");
  const controlsEl = () => document.getElementById("insightsControls");

  let state = null; // { matchId, platform, puuid, mode }

  function open({ matchId, platform, puuid }) {
    state = { matchId, platform, puuid };
    resultEl()?.classList.add("lp-insights-open");
    const p = panel();
    if (!p) return;
    p.hidden = false;
    p.innerHTML = `
      <div class="lp-ai-review-header">
        <h3>AI Insights</h3>
        <button type="button" class="lp-ai-review-close" aria-label="Close">&times;</button>
      </div>
      <div class="lp-insights-chat" id="insightsChat"></div>
      <div id="insightsControls"></div>`;
    p.querySelector(".lp-ai-review-close").addEventListener("click", close);
    askWho();
  }

  function close() {
    resultEl()?.classList.remove("lp-insights-open");
    const p = panel();
    if (p) { p.hidden = true; p.innerHTML = ""; }
    state = null;
  }

  function addMessage(className, html) {
    const el = document.createElement("div");
    el.className = `lp-insights-msg ${className}`;
    el.innerHTML = html;
    chatEl()?.appendChild(el);
    el.scrollIntoView({ block: "end", behavior: "smooth" });
    return el;
  }

  function setControls(html) {
    const c = controlsEl();
    if (c) c.innerHTML = html;
    return c;
  }

  function renderChoices(choices, onPick) {
    const c = setControls(`<div class="lp-insights-choices"></div>`);
    const wrap = c.querySelector(".lp-insights-choices");
    choices.forEach((choice) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary btn-sm";
      btn.textContent = choice.label;
      btn.addEventListener("click", () => {
        setControls("");
        addMessage("user", esc(choice.label));
        onPick(choice);
      });
      wrap.appendChild(btn);
    });
  }

  function renderFreeform(placeholder, onSubmit) {
    setControls(`
      <form class="lp-insights-freeform">
        <input type="text" class="input" placeholder="${esc(placeholder)}" required />
        <button type="submit" class="btn btn-secondary btn-sm">Ask</button>
      </form>`);
    const form = controlsEl().querySelector("form");
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const input = form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      setControls("");
      addMessage("user", esc(text));
      onSubmit(text);
    });
  }

  function askWho() {
    addMessage("assistant", "Is this your match, or someone else's?");
    renderChoices(
      [
        { label: "This is my match", value: "self" },
        { label: "Someone else's match", value: "other" },
      ],
      (choice) => (choice.value === "self" ? askSelfIntent() : askOtherIntent()),
    );
  }

  function askSelfIntent() {
    addMessage("assistant", "What would you like out of this review?");
    renderChoices(
      [
        { label: "Help me improve", value: "self_improve" },
        { label: "What I did right and wrong", value: "self_strengths_weaknesses" },
        { label: "Something else", value: "self_custom", freeform: true },
      ],
      handlePick,
    );
  }

  function askOtherIntent() {
    addMessage("assistant", "What are you looking for?");
    renderChoices(
      [
        { label: "An overall analysis of the game", value: "other_overview" },
        { label: "Something specific", value: "other_custom", freeform: true },
      ],
      handlePick,
    );
  }

  function handlePick(choice) {
    if (choice.freeform) {
      renderFreeform("Ask about this game…", (question) => runReview(choice.value, question));
    } else {
      runReview(choice.value, "");
    }
  }

  async function runReview(mode, question) {
    state.mode = mode;
    state.reviewQuestion = question;
    const loading = addMessage("assistant loading", "Thinking this one through…");
    try {
      const result = await requestAiReview({
        matchId: state.matchId, platform: state.platform, puuid: state.puuid, mode, question,
      });
      loading.remove();
      addMessage("assistant", esc(result.review).replace(/\n/g, "<br>"));
      renderFollowupBox();
    } catch (err) {
      loading.remove();
      addMessage("assistant", errorHtml(err));
      setControls(`<button type="button" class="btn btn-secondary btn-sm" id="insightsRetry">Start over</button>`);
      document.getElementById("insightsRetry")?.addEventListener("click", askWho);
    }
  }

  function renderFollowupBox() {
    setControls(`
      <form class="lp-insights-freeform">
        <input type="text" class="input" placeholder="Ask a follow-up question…" required />
        <button type="submit" class="btn btn-secondary btn-sm">Ask</button>
      </form>`);
    const form = controlsEl().querySelector("form");
    form.addEventListener("submit", async (evt) => {
      evt.preventDefault();
      const input = form.querySelector("input");
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      addMessage("user", esc(question));
      const loading = addMessage("assistant loading", "Thinking…");
      try {
        const result = await requestAiFollowup({
          matchId: state.matchId, question, reviewMode: state.mode, reviewQuestion: state.reviewQuestion,
        });
        loading.remove();
        addMessage("assistant", esc(result.answer).replace(/\n/g, "<br>"));
      } catch (err) {
        loading.remove();
        addMessage("assistant", errorHtml(err));
      }
      renderFollowupBox();
    }, { once: true });
  }

  function errorHtml(err) {
    if (err.code === "allowance_exceeded") {
      return `${esc(err.message)} <a href="pricing.html">See Plus/Premier plans</a>.`;
    }
    if (err.code === "unauthorized") {
      return "Please sign in again to continue.";
    }
    return esc(err.message || "Something went wrong on that request — please try again.");
  }

  return { open, close };
})();
