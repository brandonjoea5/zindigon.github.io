// Zindigon League | shared Supabase client + auth + saved-profile helpers.
// Same Supabase project every other Zindigon tool uses (Builds, Elemental
// Rift), so a session started anywhere on zindigon.com is recognized here
// too — one account, no separate League login. See builds/builds-shared.js
// for the original version of this pattern.

const SUPABASE_URL = "https://kryfuceztfzccsidkzog.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyeWZ1Y2V6dGZ6Y2NzaWRrem9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODY1MjIsImV4cCI6MjA5MzY2MjUyMn0.c_pmdXWHLQYh1dwkCwhqpW7lpgIzK13UUq2ZW53XhAs";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------
// Auth state — identical contract to BuildsAuth (builds/builds-shared.js):
// same `players` row, same session. Kept as its own object (rather than
// importing that file) so /lol/ has no hard dependency on /builds/.
// ---------------------------------------------------------------------
const LeagueAuth = {
  session: null,
  player: null,

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
  hasProfile() { return !!this.player; },

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
// Saved Riot profiles — public.saved_riot_profiles (see
// workers/zindigon-league-api/migrations/0001_saved_riot_profiles.sql).
// Free/Plus/Premier limits (3/10/25) are enforced here in application
// code against a plan value on `players`, once that column exists
// (Phase 3) — until then everyone is treated as Free (limit 3) so the
// UI never promises more than Phase 1 can actually honor.
// ---------------------------------------------------------------------
const SAVED_PROFILE_LIMIT_DEFAULT = 3;

async function listSavedProfiles() {
  if (!LeagueAuth.isSignedIn()) return [];
  const { data, error } = await sb
    .from("saved_riot_profiles")
    .select("id, platform, region, game_name, tag_line, puuid, relationship, created_at")
    .order("created_at", { ascending: true });
  if (error) { console.warn("saved profiles load failed", error); return []; }
  return data || [];
}

async function saveRiotProfile({ platform, region, gameName, tagLine, puuid, relationship }) {
  if (!LeagueAuth.isSignedIn()) throw new Error("Sign in to save profiles.");
  const existing = await listSavedProfiles();
  if (existing.length >= SAVED_PROFILE_LIMIT_DEFAULT) {
    throw new Error(`You've reached your saved-profile limit (${SAVED_PROFILE_LIMIT_DEFAULT}). Remove one to add another.`);
  }
  const { data, error } = await sb
    .from("saved_riot_profiles")
    .insert({
      user_id: LeagueAuth.session.user.id,
      platform, region,
      game_name: gameName, tag_line: tagLine,
      puuid, relationship: relationship || "other",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteSavedProfile(id) {
  if (!LeagueAuth.isSignedIn()) throw new Error("Not signed in.");
  const { error } = await sb.from("saved_riot_profiles").delete().eq("id", id);
  if (error) throw error;
}
