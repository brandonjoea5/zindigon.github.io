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

  async signUp(email, password) {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    this.session = data.session || null;
    if (this.session) await this._loadPlayer();
    return { session: this.session, needsEmailConfirmation: !this.session };
  },

  hasProfile() { return !!this.player; },

  async createProfile(username) {
    if (!this.session) throw new Error("Not signed in.");
    const { data, error } = await sb
      .from("players")
      .insert({ id: this.session.user.id, username, role: "user" })
      .select("id, username, role, selected_title, created_at")
      .single();
    if (error) throw error;
    this.player = data;
    return data;
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
    powerArrays, powerArrayAbilities, iconicAbilities, artifacts, allies,
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
    sb.from("allies").select("*").order("name"),
  ]);
  const problems = [powers, roles, powerRoles, buildTypes, contentTypes, movementModes,
    powerArrays, powerArrayAbilities, iconicAbilities, artifacts, allies]
    .filter((r) => r.error).map((r) => r.error.message);
  if (problems.length) throw new Error("Reference data load failed: " + problems.join("; "));

  return {
    powers: powers.data, roles: roles.data, powerRoles: powerRoles.data,
    buildTypes: buildTypes.data, contentTypes: contentTypes.data,
    movementModes: movementModes.data, powerArrays: powerArrays.data,
    powerArrayAbilities: powerArrayAbilities.data,
    iconicAbilities: iconicAbilities.data, artifacts: artifacts.data,
    allies: allies.data,
  };
}

function rolesForPower(ref, powerId) {
  const ids = new Set(ref.powerRoles.filter((pr) => pr.power_id === powerId).map((pr) => pr.role_id));
  return ref.roles.filter((r) => ids.has(r.id));
}
// ---------------------------------------------------------------------
// Voting — build_votes (build_id, user_id, vote, created_at, updated_at).
// vote is 1 (up) or -1 (down); one row per user per build. Counts are
// computed client-side from the raw rows (small scale), so anon/auth
// just needs SELECT on build_votes; casting a vote needs the caller to
// be signed in and own the row (user_id = auth.uid()).
// ---------------------------------------------------------------------
async function fetchVoteTotals(buildIds) {
  const totals = {};
  (buildIds || []).forEach((id) => { totals[id] = { up: 0, down: 0, score: 0 }; });
  if (!buildIds || !buildIds.length) return totals;
  const { data, error } = await sb.from("build_votes").select("build_id, vote").in("build_id", buildIds);
  if (error) { console.warn("vote totals load failed", error); return totals; }
  (data || []).forEach((row) => {
    const t = totals[row.build_id];
    if (!t) return;
    if (row.vote > 0) t.up += 1; else if (row.vote < 0) t.down += 1;
    t.score = t.up - t.down;
  });
  return totals;
}

async function fetchMyVote(buildId) {
  if (!BuildsAuth.isSignedIn()) return 0;
  const { data, error } = await sb
    .from("build_votes")
    .select("vote")
    .eq("build_id", buildId)
    .eq("user_id", BuildsAuth.session.user.id)
    .maybeSingle();
  if (error) { console.warn("my vote load failed", error); return 0; }
  return data ? data.vote : 0;
}

async function castVote(buildId, value) {
  if (!BuildsAuth.isSignedIn()) throw new Error("Not signed in.");
  const userId = BuildsAuth.session.user.id;
  const current = await fetchMyVote(buildId);
  if (current === value) {
    const { error } = await sb.from("build_votes").delete().eq("build_id", buildId).eq("user_id", userId);
    if (error) throw error;
    return 0;
  }
  const { error } = await sb
    .from("build_votes")
    .upsert({ build_id: buildId, user_id: userId, vote: value, updated_at: new Date().toISOString() }, { onConflict: "build_id,user_id" });
  if (error) throw error;
  return value;
}
// ---------------------------------------------------------------------
// Comments — build_comments (id, build_id, user_id, body, status,
// created_at). status is 'visible' | 'hidden' | 'deleted'. Anyone can
// read visible comments; posting requires being signed in. New comments
// are inserted as 'visible' unless they match the basic blocked-word
// filter below, in which case they're inserted as 'hidden' so an admin
// can review them (admins can also hide/show/delete manually). There's
// no username column on the row — resolved via a join against players
// by user_id when rendering.
// ---------------------------------------------------------------------
const BLOCKED_WORDS = [
  // Deliberately short — a basic, easily-extended safeguard, not a full
  // moderation system. Admins can still hide/delete anything manually
  // regardless of whether it tripped this list.
  "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "nigger", "nigga",
  "faggot", "retard", "whore", "slut",
];

function containsBlockedWord(text) {
  const lower = String(text || "").toLowerCase();
  return BLOCKED_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
}

async function fetchComments(buildId) {
  const { data, error } = await sb
    .from("build_comments")
    .select("id, build_id, user_id, body, status, created_at")
    .eq("build_id", buildId)
    .eq("status", "visible")
    .order("created_at", { ascending: true });
  if (error) { console.warn("comments load failed", error); return []; }
  const rows = data || [];
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  let usernames = {};
  if (userIds.length) {
    const { data: players } = await sb.from("players").select("id, username").in("id", userIds);
    (players || []).forEach((p) => { usernames[p.id] = p.username; });
  }
  return rows.map((r) => ({ ...r, username: usernames[r.user_id] || "Deleted User" }));
}

async function postComment(buildId, body) {
  if (!BuildsAuth.isSignedIn()) throw new Error("Not signed in.");
  const trimmed = String(body || "").trim();
  if (!trimmed) throw new Error("Comment can't be empty.");
  const status = containsBlockedWord(trimmed) ? "hidden" : "visible";
  const { data, error } = await sb
    .from("build_comments")
    .insert({ build_id: buildId, user_id: BuildsAuth.session.user.id, body: trimmed, status })
    .select()
    .single();
  if (error) throw error;
  return { ...data, flagged: status === "hidden" };
}
