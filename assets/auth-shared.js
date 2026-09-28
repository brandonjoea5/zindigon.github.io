// Zindigon | shared Supabase client + core auth/session logic.
// Same Supabase project as every Zindigon tool (League, Builds,
// ToonData), so a session started anywhere on zindigon.com is
// recognized everywhere else too — one account, no separate logins
// per area.
//
// This is the CORE auth contract only: session + player row + sign
// in/up/out. Area-specific extensions (like League's saved Riot
// profiles in lol/auth-shared.js) build on top of window.ZindigonAuth
// rather than duplicating this logic.

(function (global) {
  const SUPABASE_URL = "https://kryfuceztfzccsidkzog.supabase.co";
  const SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyeWZ1Y2V6dGZ6Y2NzaWRrem9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODY1MjIsImV4cCI6MjA5MzY2MjUyMn0.c_pmdXWHLQYh1dwkCwhqpW7lpgIzK13UUq2ZW53XhAs";

  if (!global.supabase) {
    console.error("ZindigonAuth: window.supabase is not loaded — include the Supabase JS CDN script before assets/auth-shared.js.");
    return;
  }

  const sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const ZindigonAuth = {
    sb,
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

  global.ZindigonAuth = ZindigonAuth;
  global.zxEsc = esc;
})(window);
