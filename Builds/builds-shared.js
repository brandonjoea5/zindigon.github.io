// Zindigon Builds | shared Supabase client + auth helpers.
// This file is loaded by every page under /builds/ (admin now; the public
// Browse/Matcher/Detail pages in later phases). It intentionally knows
// nothing about builds-specific UI — just "who is signed in" and "are they
// an admin" — so it can also be the seed of a future account-wide
// Zindigon Studios profile shared across other games/tools.
//
// Same Supabase project Elemental Rift already uses, so a session started
// there (or here) is recognized everywhere on zindigon.com — one account,
// no separate Builds login.

const SUPABASE_URL = "https://kryfuceztfzccsidkzog.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyeWZ1Y2V6dGZ6Y2NzaWRrem9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODY1MjIsImV4cCI6MjA5MzY2MjUyMn0.c_pmdXWHLQYh1dwkCwhqpW7lpgIzK13UUq2ZW53XhAs";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ---------------------------------------------------------------------
// esc() — shared HTML-escaping helper, same contract as ToonData's.
// ---------------------------------------------------------------------
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function slugify(str) {
  return String(str ?? "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------
// Auth state — one place every page asks "who's signed in / are they
// admin", backed by Supabase's own session (persisted in localStorage by
// supabase-js, shared across every zindigon.com page on this origin).
// ---------------------------------------------------------------------
const BuildsAuth = {
  session: null,
  player: null, // row from public.players for the current user, incl. role

  async init() {
    const { data } = await sb.auth.getSession();
    this.session = data.session || null;
    if (this.session) await this._loadPlayer();
    return this.session;
  },

  async _loadPlayer() {
    if (!this.session) { this.player = null; return null; }
    const { data, error } = await sb
      .from("players")
      .select("id, username, role, selected_title, created_at")
      .eq("id", this.session.user.id)
      .maybeSingle();
    if (error) { console.warn("players lookup failed", error); this.player = null; return null; }
    this.player = data;
    return data;
  },

  isSignedIn() { return !!this.session; },
  isAdmin() { return !!this.player && this.player.role === "admin"; },

  async signInWithPassword(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.session = data.session;
    await this._loadPlayer();
    return this.player;
  },

  async signOut() {
    await sb.auth.signOut();
    this.session = null;
    this.player = null;
  },

  onChange(cb) {
    sb.auth.onAuthStateChange(async (_event, session) => {
      this.session = session;
      if (session) await this._loadPlayer(); else this.player = null;
      cb(this.session, this.player);
    });
  },
};

// ---------------------------------------------------------------------
// Reference data — every lookup table Builds pages need. Fetched once
// per page load and cached in memory; admin writes go straight to
// Supabase and the caller re-fetches (no client-side cache invalidation
// cleverness needed at this scale).
// ---------------------------------------------------------------------
async function fetchReferenceData() {
  const [
    powers, roles, powerRoles, buildTypes, contentTypes, movementModes,
    powerArrays, powerArrayAbilities, iconicAbilities, artifacts,
  ] = await Promise.all([
    sb.from("powers").select("*").order("sort_order"),
    sb.from("roles").select("*").order("sort_order"),
    sb.from("power_roles").select("*"),
    sb.from("build_types").select("*").order("sort_order"),
    sb.from("content_types").select("*").order("sort_order"),
    sb.from("movement_modes").select("*").order("sort_order"),
    sb.from("power_arrays").select("*").order("name"),
    sb.from("power_array_abilities").select("*").order("sort_order"),
    sb.from("iconic_abilities").select("*").order("name"),
    sb.from("artifacts").select("*").order("name"),
  ]);
  const problems = [powers, roles, powerRoles, buildTypes, contentTypes, movementModes,
    powerArrays, powerArrayAbilities, iconicAbilities, artifacts]
    .filter((r) => r.error).map((r) => r.error.message);
  if (problems.length) throw new Error("Reference data load failed: " + problems.join("; "));

  return {
    powers: powers.data, roles: roles.data, powerRoles: powerRoles.data,
    buildTypes: buildTypes.data, contentTypes: contentTypes.data,
    movementModes: movementModes.data, powerArrays: powerArrays.data,
    powerArrayAbilities: powerArrayAbilities.data,
    iconicAbilities: iconicAbilities.data, artifacts: artifacts.data,
  };
}

function rolesForPower(ref, powerId) {
  const ids = new Set(ref.powerRoles.filter((pr) => pr.power_id === powerId).map((pr) => pr.role_id));
  return ref.roles.filter((r) => ids.has(r.id));
}
