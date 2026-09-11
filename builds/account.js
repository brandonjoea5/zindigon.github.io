// Zindigon Builds | public account bar (sign up / sign in / sign out).
// Shared by every public page (index.html, detail.html, submit.html).
// Renders into <div id="accountBar"></div> and injects its own sign-in/
// sign-up modal right after it. Depends on builds-shared.js (sb, esc,
// BuildsAuth) being loaded first.

let acctMode = "signin";

function renderAccountBar() {
  const el = document.getElementById("accountBar");
  if (!el) return;

  if (BuildsAuth.isSignedIn() && BuildsAuth.hasProfile()) {
    el.innerHTML = `
      <div class="bp-account">
        <span class="bp-account-name">Hi, ${esc(BuildsAuth.player.username)}</span>
        <a href="submit.html" class="btn btn-secondary btn-sm">+ Submit a Build</a>
        <button id="acctSignOutBtn" class="btn btn-ghost btn-sm" type="button">Sign Out</button>
      </div>`;
    document.getElementById("acctSignOutBtn").addEventListener("click", async () => {
      await BuildsAuth.signOut();
      renderAccountBar();
      if (typeof onAccountChange === "function") onAccountChange();
    });
    return;
  }

  if (BuildsAuth.isSignedIn() && !BuildsAuth.hasProfile()) {
    el.innerHTML = `
      <div class="bp-account">
        <form id="acctProfileForm" class="bp-account-inline-form">
          <input class="input" id="acctProfileUsername" placeholder="Choose a username" required />
          <button class="btn btn-primary btn-sm" type="submit">Finish setting up account</button>
        </form>
      </div>`;
    document.getElementById("acctProfileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("acctProfileUsername").value.trim();
      if (!username) return;
      try {
        await BuildsAuth.createProfile(username);
        renderAccountBar();
        if (typeof onAccountChange === "function") onAccountChange();
      } catch (err) {
        alert("Could not save username: " + err.message);
      }
    });
    return;
  }

  el.innerHTML = `
    <div class="bp-account">
      <button id="acctSignInBtn" class="btn btn-ghost btn-sm" type="button">Sign In</button>
      <button id="acctSignUpBtn" class="btn btn-secondary btn-sm" type="button">Sign Up</button>
    </div>`;
  document.getElementById("acctSignInBtn").addEventListener("click", () => openAccountModal("signin"));
  document.getElementById("acctSignUpBtn").addEventListener("click", () => openAccountModal("signup"));
}

function openAccountModal(mode) {
  acctMode = mode;
  document.getElementById("acctModalOverlay").hidden = false;
  document.getElementById("acctModalTitle").textContent = mode === "signup" ? "Sign Up" : "Sign In";
  document.getElementById("acctUsernameField").hidden = mode !== "signup";
  document.getElementById("acctSubmitBtn").textContent = mode === "signup" ? "Sign Up" : "Sign In";
  document.getElementById("acctSwitchToSignUp").hidden = mode === "signup";
  document.getElementById("acctSwitchToSignIn").hidden = mode !== "signup";
  document.getElementById("acctError").hidden = true;
  document.getElementById("acctInfo").hidden = true;
  document.getElementById("acctForm").reset();
}

function closeAccountModal() {
  document.getElementById("acctModalOverlay").hidden = true;
}

function injectAccountModal() {
  const bar = document.getElementById("accountBar");
  bar.insertAdjacentHTML("afterend", `
    <div class="bp-modal-overlay" id="acctModalOverlay" hidden>
      <div class="bp-modal">
        <button class="bp-modal-close" id="acctModalClose" type="button" aria-label="Close">&times;</button>
        <h3 id="acctModalTitle">Sign In</h3>
        <form id="acctForm">
          <div class="field" id="acctUsernameField" hidden>
            <label for="acctUsername">Username</label>
            <input class="input" id="acctUsername" />
          </div>
          <div class="field">
            <label for="acctEmail">Email</label>
            <input class="input" type="email" id="acctEmail" required />
          </div>
          <div class="field">
            <label for="acctPassword">Password</label>
            <input class="input" type="password" id="acctPassword" required minlength="6" />
          </div>
          <p class="bp-account-error" id="acctError" hidden></p>
          <p class="bp-account-info" id="acctInfo" hidden></p>
          <button type="submit" class="btn btn-primary" id="acctSubmitBtn">Sign In</button>
        </form>
        <p class="bp-account-switch">
          <span id="acctSwitchToSignUp">Need an account? <a href="#" id="acctGoSignUp">Sign up</a></span>
          <span id="acctSwitchToSignIn" hidden>Already have an account? <a href="#" id="acctGoSignIn">Sign in</a></span>
        </p>
      </div>
    </div>`);

  document.getElementById("acctModalClose").addEventListener("click", closeAccountModal);
  document.getElementById("acctModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "acctModalOverlay") closeAccountModal();
  });
  document.getElementById("acctGoSignUp").addEventListener("click", (e) => { e.preventDefault(); openAccountModal("signup"); });
  document.getElementById("acctGoSignIn").addEventListener("click", (e) => { e.preventDefault(); openAccountModal("signin"); });

  document.getElementById("acctForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("acctEmail").value.trim();
    const password = document.getElementById("acctPassword").value;
    const errEl = document.getElementById("acctError");
    const infoEl = document.getElementById("acctInfo");
    errEl.hidden = true;
    infoEl.hidden = true;
    try {
      if (acctMode === "signup") {
        const username = document.getElementById("acctUsername").value.trim();
        if (!username) {
          errEl.textContent = "Please choose a username.";
          errEl.hidden = false;
          return;
        }
        const { needsEmailConfirmation } = await BuildsAuth.signUp(email, password);
        if (needsEmailConfirmation) {
          infoEl.textContent = "Check your email to confirm your account, then sign in.";
          infoEl.hidden = false;
          return;
        }
        await BuildsAuth.createProfile(username);
      } else {
        await BuildsAuth.signInWithPassword(email, password);
      }
      closeAccountModal();
      renderAccountBar();
      if (typeof onAccountChange === "function") onAccountChange();
    } catch (err) {
      errEl.textContent = err.message || "Something went wrong.";
      errEl.hidden = false;
    }
  });
}

async function initAccountBar() {
  const container = document.getElementById("accountBar");
  if (!container) return;
  injectAccountModal();
  await BuildsAuth.init();
  renderAccountBar();
    BuildsAuth.onChange(() => renderAccountBar());

  const calloutBtn = document.getElementById("calloutSignUp");
  if (calloutBtn) {
    calloutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openAccountModal("signup");
    });
  }
}

initAccountBar();
