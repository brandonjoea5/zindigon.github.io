// Bloodline Zero | account bar (sign in / sign up / sign out).
// Same pattern as lol/account.js and builds/account.js, adapted to the
// shared window.ZindigonAuth (assets/auth-shared.js) so a Bloodline
// Zero purchase is tied to the same one Zindigon account used
// everywhere else on the site.

let bzAcctMode = "signin";

function bzRenderAccountBar() {
  const el = document.getElementById("bzAccountBar");
  if (!el) return;
  const auth = window.ZindigonAuth;

  if (auth.isSignedIn() && auth.hasProfile()) {
    el.innerHTML = `
      <div class="bz-account">
        <span class="bz-account-name">${zxEsc(auth.player.username)}</span>
        <button id="bzSignOutBtn" class="bz-btn bz-btn-text" type="button">Sign out</button>
      </div>`;
    document.getElementById("bzSignOutBtn").addEventListener("click", async () => {
      await auth.signOut();
      bzRenderAccountBar();
      if (typeof window.bzOnAccountChange === "function") window.bzOnAccountChange();
    });
    return;
  }

  if (auth.isSignedIn() && !auth.hasProfile()) {
    el.innerHTML = `
      <div class="bz-account">
        <form id="bzProfileForm" class="bz-inline-form">
          <input class="bz-input" id="bzProfileUsername" placeholder="Choose a display name" required />
          <button class="bz-btn bz-btn-primary" type="submit">Save</button>
        </form>
      </div>`;
    document.getElementById("bzProfileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("bzProfileUsername").value.trim();
      if (!username) return;
      try {
        await auth.createProfile(username);
        bzRenderAccountBar();
        if (typeof window.bzOnAccountChange === "function") window.bzOnAccountChange();
      } catch (err) {
        alert("Could not save display name: " + err.message);
      }
    });
    return;
  }

  el.innerHTML = `
    <div class="bz-account">
      <button id="bzSignInBtn" class="bz-btn bz-btn-text" type="button">Sign in</button>
      <button id="bzSignUpBtn" class="bz-btn" type="button">Sign up</button>
    </div>`;
  document.getElementById("bzSignInBtn").addEventListener("click", () => bzOpenModal("signin"));
  document.getElementById("bzSignUpBtn").addEventListener("click", () => bzOpenModal("signup"));
}

function bzOpenModal(mode) {
  bzAcctMode = mode;
  document.getElementById("bzModalOverlay").hidden = false;
  document.getElementById("bzModalTitle").textContent = mode === "signup" ? "Create an account" : "Sign in";
  document.getElementById("bzSubmitBtn").textContent = mode === "signup" ? "Sign up" : "Sign in";
  document.getElementById("bzSwitchToSignUp").hidden = mode === "signup";
  document.getElementById("bzSwitchToSignIn").hidden = mode !== "signup";
  document.getElementById("bzError").hidden = true;
  document.getElementById("bzInfo").hidden = true;
  document.getElementById("bzForm").reset();
}

function bzCloseModal() {
  document.getElementById("bzModalOverlay").hidden = true;
}
window.bzOpenModal = bzOpenModal;

function bzInjectAccountModal() {
  if (document.getElementById("bzModalOverlay")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="bz-modal-overlay" id="bzModalOverlay" hidden>
      <div class="bz-modal">
        <button class="bz-modal-close" id="bzModalClose" type="button" aria-label="Close">&times;</button>
        <h3 id="bzModalTitle">Sign in</h3>
        <form id="bzForm">
          <div class="bz-field">
            <label for="bzEmail">Email</label>
            <input class="bz-input" type="email" id="bzEmail" required autocomplete="email" />
          </div>
          <div class="bz-field">
            <label for="bzPassword">Password</label>
            <input class="bz-input" type="password" id="bzPassword" required minlength="6" autocomplete="current-password" />
          </div>
          <p class="bz-error" id="bzError" hidden></p>
          <p class="bz-info" id="bzInfo" hidden></p>
          <button type="submit" class="bz-btn bz-btn-primary" id="bzSubmitBtn" style="width:100%; justify-content:center;">Sign in</button>
        </form>
        <p class="bz-switch">
          <span id="bzSwitchToSignUp">New here? <a href="#" id="bzGoSignUp">Create an account</a></span>
          <span id="bzSwitchToSignIn" hidden>Already have an account? <a href="#" id="bzGoSignIn">Sign in</a></span>
        </p>
      </div>
    </div>`);

  document.getElementById("bzModalClose").addEventListener("click", bzCloseModal);
  document.getElementById("bzModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "bzModalOverlay") bzCloseModal();
  });
  document.getElementById("bzGoSignUp").addEventListener("click", (e) => { e.preventDefault(); bzOpenModal("signup"); });
  document.getElementById("bzGoSignIn").addEventListener("click", (e) => { e.preventDefault(); bzOpenModal("signin"); });

  document.getElementById("bzForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const auth = window.ZindigonAuth;
    const email = document.getElementById("bzEmail").value.trim();
    const password = document.getElementById("bzPassword").value;
    const errEl = document.getElementById("bzError");
    const infoEl = document.getElementById("bzInfo");
    errEl.hidden = true;
    infoEl.hidden = true;
    try {
      if (bzAcctMode === "signup") {
        const { needsEmailConfirmation } = await auth.signUp(email, password);
        if (needsEmailConfirmation) {
          infoEl.textContent = "Check your email to confirm your account, then sign in.";
          infoEl.hidden = false;
          return;
        }
      } else {
        await auth.signInWithPassword(email, password);
      }
      bzCloseModal();
      bzRenderAccountBar();
      if (typeof window.bzOnAccountChange === "function") window.bzOnAccountChange();
    } catch (err) {
      errEl.textContent = err.message || "Something went wrong.";
      errEl.hidden = false;
    }
  });
}

async function bzInitAccount() {
  bzInjectAccountModal();
  await window.ZindigonAuth.init();
  bzRenderAccountBar();
  window.ZindigonAuth.onChange(() => bzRenderAccountBar());
}
