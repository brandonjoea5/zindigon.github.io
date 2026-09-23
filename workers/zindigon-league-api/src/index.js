// Zindigon League API — Phase 1 (Riot proxy + cache) + Phase 2 (Plus/Premier
// billing + minimal AI match-review pipeline).
//
// Single file, no npm dependencies, no bundler — deployed by hand through
// Cloudflare's dashboard Quick Edit, so it has to stay copy/paste-able as
// one file. Stripe and Supabase are both called via plain fetch(), not
// their SDKs, for the same reason.
//
// Routes:
//   GET  /account?platform=na1&name=Foo&tag=NA1        (public)
//   GET  /rank?platform=na1&puuid=...                  (public)
//   GET  /matches?platform=na1&puuid=...&start=0&...   (public)
//   GET  /match?platform=na1&matchId=NA1_123456789      (public)
//   GET  /billing/plans                                 (public)
//   POST /billing/checkout        { plan }               (auth)
//   POST /billing/portal                                 (auth)
//   GET  /billing/status                                 (auth)
//   POST /billing/webhook                                (Stripe signature, not user auth)
//   POST /ai/review    { matchId, platform, puuid }       (auth)
//   POST /ai/followup  { matchId, question }              (auth)
//
// "Auth" above means a Supabase session access token in
// `Authorization: Bearer <token>`, verified against Supabase's own
// /auth/v1/user endpoint (see verifySupabaseUser below) — the same
// account system every zindigon.com sub-site shares.

// =======================================================================
// Constants
// =======================================================================

const QUEUE_NAMES = {
  400: 'Normal Draft', 420: 'Ranked Solo/Duo', 430: 'Normal Blind',
  440: 'Ranked Flex', 450: 'ARAM', 490: 'Quickplay', 700: 'Clash',
  720: 'ARAM Clash', 830: 'Co-op vs AI Intro', 840: 'Co-op vs AI Beginner',
  850: 'Co-op vs AI Intermediate', 900: 'ARURF', 1020: 'One for All',
  1700: 'Arena', 1900: 'URF',
};

// Riot platform -> regional routing cluster (account-v1 / match-v5 live here).
const PLATFORM_TO_REGION = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  kr: 'asia', jp1: 'asia',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

const VALID_PLATFORMS = Object.keys(PLATFORM_TO_REGION);

// Keep well under the Free-tier 50-subrequest ceiling per invocation —
// this caps how many *new* (not-yet-cached) matches get fetched+stored in
// a single /matches call. Anything beyond this shows up once the client
// pages further (each page is its own Worker invocation, its own budget).
const MAX_NEW_MATCHES_PER_REQUEST = 12;

// Same Supabase project every other Zindigon tool uses (Builds, Elemental
// Rift, /lol/ itself) — see builds/builds-shared.js / lol/auth-shared.js.
// The anon key is not a secret (it's already committed in those frontend
// files and is meant to be public — RLS is what actually protects data),
// so it's fine to also hold it here as a constant rather than a Worker
// secret. The service-role key below is the real secret and is NEVER
// committed — it's set only via the Cloudflare dashboard.
const SUPABASE_URL = 'https://kryfuceztfzccsidkzog.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyeWZ1Y2V6dGZ6Y2NzaWRrem9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODY1MjIsImV4cCI6MjA5MzY2MjUyMn0.c_pmdXWHLQYh1dwkCwhqpW7lpgIzK13UUq2ZW53XhAs';

const PURCHASABLE_PLAN_SLUGS = ['plus', 'premier'];

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || 'https://zindigon.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function errorJson(env, status, code, message) {
  return json(env, { error: { code, message } }, status);
}

function nowMs() { return Date.now(); }

function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// =======================================================================
// PART 1 — Riot proxy + D1/KV cache (Phase 1, unchanged)
// =======================================================================

class RiotAuthError extends Error {}
class RiotRateLimitError extends Error {}
class RiotNotFoundError extends Error {}

async function riotGet(env, url, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const resp = await fetch(url, {
      headers: { 'X-Riot-Token': env.RIOT_API_KEY },
    });

    if (resp.status === 200) return resp.json();
    if (resp.status === 404) throw new RiotNotFoundError('Not found');

    if (resp.status === 401 || resp.status === 403) {
      console.error({
        message: 'Riot auth failure — dev key likely expired or invalid',
        url,
        status: resp.status,
      });
      throw new RiotAuthError('Riot authentication failed');
    }

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '1', 10);
      if (attempt === tries - 1) {
        throw new RiotRateLimitError('Riot rate limit exceeded');
      }
      await new Promise((r) => setTimeout(r, (retryAfter + 0.25) * 1000));
      continue;
    }

    const text = await resp.text().catch(() => '');
    console.error({ message: 'Unexpected Riot response', url, status: resp.status, body: text.slice(0, 300) });
    throw new Error(`Riot error ${resp.status}`);
  }
  throw new RiotRateLimitError('Riot rate limit exceeded');
}

const ACCOUNT_CACHE_MS = 14 * 24 * 60 * 60 * 1000;

async function resolveAccount(env, region, gameName, tagLine) {
  const cached = await env.DB
    .prepare('SELECT puuid, cached_at FROM riot_accounts WHERE region = ? AND game_name = ? AND tag_line = ?')
    .bind(region, gameName, tagLine)
    .first();

  if (cached && nowMs() - cached.cached_at < ACCOUNT_CACHE_MS) {
    return { puuid: cached.puuid, gameName, tagLine };
  }

  const url = `https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const acc = await riotGet(env, url);

  await env.DB
    .prepare('INSERT INTO riot_accounts (region, game_name, tag_line, puuid, cached_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (region, game_name, tag_line) DO UPDATE SET puuid = excluded.puuid, cached_at = excluded.cached_at')
    .bind(region, gameName, tagLine, acc.puuid, nowMs())
    .run();

  return { puuid: acc.puuid, gameName: acc.gameName, tagLine: acc.tagLine };
}

async function getRank(env, platform, puuid) {
  const cacheKey = `rank:${platform}:${puuid}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return cached;

  const url = `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
  const entries = await riotGet(env, url);

  const mapped = (entries || []).map((e) => ({
    queueType: e.queueType,
    tier: e.tier,
    rank: e.rank,
    leaguePoints: e.leaguePoints,
    wins: e.wins,
    losses: e.losses,
  }));

  await env.CACHE.put(cacheKey, JSON.stringify(mapped), { expirationTtl: 20 * 60 });
  return mapped;
}

async function getMatchIdWindow(env, region, puuid) {
  const cacheKey = `matchids:${region}:${puuid}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return cached;

  const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=100`;
  const ids = await riotGet(env, url);

  await env.CACHE.put(cacheKey, JSON.stringify(ids), { expirationTtl: 10 * 60 });
  return ids;
}

function mapParticipantRow(matchId, region, info, p) {
  const durMin = info.gameDuration > 0 && info.gameDuration < 20000
    ? info.gameDuration / 60
    : info.gameDuration / 1000 / 60;
  const cs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
  const teamKills = (info.participants || [])
    .filter((x) => x.teamId === p.teamId)
    .reduce((sum, x) => sum + (x.kills || 0), 0);

  return {
    match_id: matchId,
    puuid: p.puuid,
    participant_id: p.participantId,
    team_id: p.teamId,
    champion: p.championName,
    role: p.teamPosition || p.individualPosition || '',
    win: p.win ? 1 : 0,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    kda: +(((p.kills || 0) + (p.assists || 0)) / Math.max(1, p.deaths || 0)).toFixed(2),
    cs,
    cs_per_min: durMin ? +(cs / durMin).toFixed(2) : null,
    damage_to_champs: p.totalDamageDealtToChampions,
    damage_taken: p.totalDamageTaken,
    gold: p.goldEarned,
    gold_per_min: durMin ? Math.round((p.goldEarned || 0) / durMin) : null,
    vision_score: p.visionScore,
    kill_participation: teamKills ? +(((p.kills || 0) + (p.assists || 0)) / teamKills).toFixed(2) : null,
    queue_id: info.queueId,
    duration_sec: Math.round(durMin * 60),
    game_start_ms: info.gameStartTimestamp,
  };
}

async function ensureMatchCached(env, region, platform, matchId) {
  const existing = await env.DB.prepare('SELECT match_id FROM matches WHERE match_id = ?').bind(matchId).first();
  if (existing) return;

  const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  const m = await riotGet(env, url);
  const info = m.info;

  const raw = {
    matchId: m.metadata.matchId,
    date: new Date(info.gameStartTimestamp).toISOString(),
    queue: QUEUE_NAMES[info.queueId] || `queue ${info.queueId}`,
    queueId: info.queueId,
    durationSec: Math.round(info.gameDuration > 20000 ? info.gameDuration / 1000 : info.gameDuration),
    gameVersion: info.gameVersion,
    participants: info.participants.map((p) => ({
      puuid: p.puuid,
      summonerName: p.riotIdGameName || '',
      tag: p.riotIdTagline || '',
      champion: p.championName,
      role: p.teamPosition || p.individualPosition || '',
      teamId: p.teamId,
      win: p.win,
      kills: p.kills, deaths: p.deaths, assists: p.assists,
      items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
      summoner1Id: p.summoner1Id, summoner2Id: p.summoner2Id,
      keystoneId: p.perks?.styles?.[0]?.selections?.[0]?.perk ?? null,
      primaryTreeId: p.perks?.styles?.[0]?.style ?? null,
      secondaryTreeId: p.perks?.styles?.[1]?.style ?? null,
    })),
    teams: info.teams ?? null,
  };

  await env.DB
    .prepare('INSERT OR IGNORE INTO matches (match_id, platform, region, queue_id, queue_name, game_version, game_start_ms, duration_sec, raw_json, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(matchId, platform, region, info.queueId, raw.queue, info.gameVersion, info.gameStartTimestamp, raw.durationSec, JSON.stringify(raw), nowMs())
    .run();

  const stmts = info.participants.map((p) => {
    const row = mapParticipantRow(matchId, region, info, p);
    return env.DB
      .prepare(`INSERT OR IGNORE INTO match_participants
        (match_id, puuid, participant_id, team_id, champion, role, win, kills, deaths, assists, kda, cs, cs_per_min, damage_to_champs, damage_taken, gold, gold_per_min, vision_score, kill_participation, queue_id, duration_sec, game_start_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        row.match_id, row.puuid, row.participant_id, row.team_id, row.champion, row.role, row.win,
        row.kills, row.deaths, row.assists, row.kda, row.cs, row.cs_per_min, row.damage_to_champs,
        row.damage_taken, row.gold, row.gold_per_min, row.vision_score, row.kill_participation,
        row.queue_id, row.duration_sec, row.game_start_ms,
      );
  });
  await env.DB.batch(stmts);
}

function requirePlatform(env, url) {
  const platform = (url.searchParams.get('platform') || '').toLowerCase();
  if (!VALID_PLATFORMS.includes(platform)) {
    throw { status: 400, code: 'invalid_platform', message: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` };
  }
  return platform;
}

async function handleAccount(env, url) {
  const platform = requirePlatform(env, url);
  const region = PLATFORM_TO_REGION[platform];
  const name = (url.searchParams.get('name') || '').trim();
  const tag = (url.searchParams.get('tag') || '').trim();
  if (!name || !tag) throw { status: 400, code: 'missing_riot_id', message: 'name and tag are required' };

  const account = await resolveAccount(env, region, name, tag);
  return json(env, { platform, region, ...account });
}

async function handleRank(env, url) {
  const platform = requirePlatform(env, url);
  const puuid = url.searchParams.get('puuid');
  if (!puuid) throw { status: 400, code: 'missing_puuid', message: 'puuid is required' };

  const rank = await getRank(env, platform, puuid);
  return json(env, { platform, puuid, rank });
}

const SORT_COLUMNS = {
  newest: 'game_start_ms DESC',
  oldest: 'game_start_ms ASC',
  most_kills: 'kills DESC',
  most_deaths: 'deaths DESC',
  most_assists: 'assists DESC',
  highest_kda: 'kda DESC',
  most_cs: 'cs DESC',
  highest_cs_per_min: 'cs_per_min DESC',
  most_damage: 'damage_to_champs DESC',
  most_gold: 'gold DESC',
  highest_vision: 'vision_score DESC',
  fastest_win: 'duration_sec ASC',
  longest_match: 'duration_sec DESC',
};

async function handleMatches(env, url) {
  const platform = requirePlatform(env, url);
  const region = PLATFORM_TO_REGION[platform];
  const puuid = url.searchParams.get('puuid');
  if (!puuid) throw { status: 400, code: 'missing_puuid', message: 'puuid is required' };

  const start = Math.max(0, parseInt(url.searchParams.get('start') || '0', 10));
  const count = Math.min(50, Math.max(1, parseInt(url.searchParams.get('count') || '20', 10)));
  const sort = SORT_COLUMNS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'newest';

  const allIds = await getMatchIdWindow(env, region, puuid);
  const pageIds = allIds.slice(start, start + count);

  let newlyFetched = 0;
  for (const matchId of pageIds) {
    const exists = await env.DB.prepare('SELECT 1 FROM matches WHERE match_id = ?').bind(matchId).first();
    if (exists) continue;
    if (newlyFetched >= MAX_NEW_MATCHES_PER_REQUEST) break;
    await ensureMatchCached(env, region, platform, matchId);
    newlyFetched++;
  }

  if (pageIds.length === 0) {
    return json(env, { platform, puuid, total: allIds.length, start, count, items: [] });
  
  }

  const filters = [];
  const binds = [puuid];
  const placeholders = pageIds.map(() => '?').join(',');
  filters.push(`match_id IN (${placeholders})`);
  binds.push(...pageIds);

  const champion = url.searchParams.get('champion');
  if (champion) { filters.push('champion = ?'); binds.push(champion); }
  const role = url.searchParams.get('role');
  if (role) { filters.push('role = ?'); binds.push(role); }
  const queueId = url.searchParams.get('queueId');
  if (queueId) { filters.push('queue_id = ?'); binds.push(parseInt(queueId, 10)); }
  const win = url.searchParams.get('win');
  if (win === 'true' || win === 'false') { filters.push('win = ?'); binds.push(win === 'true' ? 1 : 0); }
  const minKills = url.searchParams.get('minKills');
  if (minKills) { filters.push('kills >= ?'); binds.push(parseInt(minKills, 10)); }
  const minCs = url.searchParams.get('minCs');
  if (minCs) { filters.push('cs >= ?'); binds.push(parseInt(minCs, 10)); }

  const sql = `SELECT * FROM match_participants WHERE puuid = ? AND ${filters.join(' AND ')} ORDER BY ${SORT_COLUMNS[sort]}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all(); // fix: `binds` already starts with puuid; binding it again exceeded the placeholder count (D1 "wrong number of parameter bindings", confirmed live 2026-09-23)

  return json(env, {
    platform, puuid,
    total: allIds.length,
    start, count,
    nextStart: start + count < allIds.length ? start + count : null,
    items: results,
  });
}

async function handleMatchDetail(env, url) {
  const platform = requirePlatform(env, url);
  const region = PLATFORM_TO_REGION[platform];
  const matchId = url.searchParams.get('matchId');
  if (!matchId) throw { status: 400, code: 'missing_match_id', message: 'matchId is required' };

  await ensureMatchCached(env, region, platform, matchId);
  const row = await env.DB.prepare('SELECT raw_json FROM matches WHERE match_id = ?').bind(matchId).first();
  if (!row) throw { status: 404, code: 'match_not_found', message: 'Match not found' };

  return json(env, JSON.parse(row.raw_json));
}

// =======================================================================
// PART 2 — Auth (verifying a Supabase browser session)
// =======================================================================

async function verifySupabaseUser(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];

  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const user = await resp.json().catch(() => null);
  if (!user || !user.id) return null;
  return { id: user.id, email: user.email, emailConfirmedAt: user.email_confirmed_at };
}

async function requireUser(request) {
  const user = await verifySupabaseUser(request);
  if (!user) throw { status: 401, code: 'unauthorized', message: 'Sign in required.' };
  return user;
}

// =======================================================================
// PART 3 — Supabase REST access (PostgREST via plain fetch — no supabase-js
// needed server-side). Two credential levels:
//   - sbAnonJson: the public anon key, for rows RLS already allows anyone
//     to read (subscription_plans).
//   - sbServiceJson: the service-role key (a Worker secret), which
//     bypasses RLS entirely — used for every privileged read/write
//     (user_subscriptions, ai_allowances, ai_reviews, ai_usage_events,
//     stripe_webhook_events, and the consume_ai_allowance RPC).
// =======================================================================

async function sbAnonJson(env, path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!resp.ok) {
    const err = new Error((body && body.message) || `Supabase error ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function sbServiceJson(env, path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!resp.ok) {
    const err = new Error((body && body.message) || `Supabase error ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function sbRpc(env, fnName, args) {
  return sbServiceJson(env, `/rpc/${fnName}`, { method: 'POST', body: JSON.stringify(args) });
}

function isMissingRelationError(err) {
  // Postgres 42P01 = "relation does not exist" (raw DB error). PostgREST's
  // own PGRST205 = "table not found in schema cache" — what it actually
  // returns for a missing table via the REST API (confirmed live against
  // this project, 2026-09-21). Both mean the same thing here: the
  // migration hasn't been applied to Supabase yet. Map either to a clear
  // "not configured" response rather than a raw DB error.
  const code = err?.body?.code;
  return code === '42P01' || code === 'PGRST205';
}

// =======================================================================
// PART 4 — Stripe (plain fetch(), no Stripe SDK — see file header)
// =======================================================================

function toFormBody(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    usp.append(k, String(v));
  }
  return usp.toString();
}

async function stripeRequest(env, method, path, params) {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? toFormBody(params) : undefined,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = data?.error?.message || `Stripe error ${resp.status}`;
    const err = new Error(message);
    err.status = 502;
    err.code = 'stripe_error';
    throw err;
  }
  return data;
}

async function createStripeCustomer(env, { email, userId }) {
  return stripeRequest(env, 'POST', '/customers', {
    email,
    'metadata[supabase_user_id]': userId,
  });
}

async function createStripeCheckoutSession(env, { customerId, priceId, successUrl, cancelUrl, userId }) {
  return stripeRequest(env, 'POST', '/checkout/sessions', {
    customer: customerId,
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: 'true',
    'subscription_data[metadata][supabase_user_id]': userId,
  });
}

async function createStripePortalSession(env, customerId, returnUrl) {
  return stripeRequest(env, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

async function getStripeSubscription(env, subscriptionId) {
  return stripeRequest(env, 'GET', `/subscriptions/${subscriptionId}`);
}

// Hand-rolled webhook signature verification (crypto.subtle HMAC-SHA256),
// since the Stripe SDK isn't available in this single-file Worker.
async function verifyStripeSignature(env, rawBody, sigHeader) {
  if (!sigHeader || !env.STRIPE_WEBHOOK_SECRET) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => kv.split('=').map((s) => s.trim())),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > 300) return false; // reject stale (>5min) timestamps — replay defense

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expectedHex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expectedHex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// =======================================================================
// PART 5 — AI (OpenAI only, for now — see plan notes on why this is one
// function rather than a formal multi-provider interface)
// =======================================================================

// Confirmed live on the account's own OpenAI platform pages (Models docs
// + Settings > Limits, checked 2026-09-18): gpt-5.6-terra is a real,
// current, non-deprecated model — "balances intelligence and cost" is
// OpenAI's own description, a good fit for a per-request coaching feature
// with a monthly allowance. Override any time via the AI_MODEL Worker var
// without a code change.
const DEFAULT_AI_MODEL = 'gpt-5.6-terra';

// Approximate, for internal ai_usage_events cost tracking only — never
// surfaced to the end user as a guaranteed figure. Rates below are from
// the account's own published per-model pricing (checked 2026-09-18); an
// unknown/future model estimates as $0 rather than guessing at a number.
const OPENAI_PRICING_PER_1K_USD = {
  'gpt-5.6-luna': { input: 0.0002, output: 0.0012 },
  'gpt-5.6-terra': { input: 0.002, output: 0.012 },
  'gpt-5.6-sol': { input: 0.004, output: 0.02 },
  'gpt-6-astra': { input: 0.01, output: 0.05 },
};

function estimateCostCents(model, promptTokens, completionTokens) {
  const rate = OPENAI_PRICING_PER_1K_USD[model];
  if (!rate) return 0;
  const usd = ((promptTokens || 0) / 1000) * rate.input + ((completionTokens || 0) / 1000) * rate.output;
  return +(usd * 100).toFixed(4);
}

async function openaiChat(env, messages, maxTokens) {
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const start = Date.now();
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_completion_tokens: maxTokens }),
  });
  const latencyMs = Date.now() - start;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = data?.error?.message || `OpenAI error ${resp.status}`;
    const err = new Error(message);
    err.status = 502;
    err.code = 'openai_error';
    throw err;
  }
  const content = data.choices?.[0]?.message?.content || '';
  const promptTokens = data.usage?.prompt_tokens || 0;
  const completionTokens = data.usage?.completion_tokens || 0;
  return {
    content, model, promptTokens, completionTokens,
    costCents: estimateCostCents(model, promptTokens, completionTokens),
    latencyMs,
  };
}

// The AI never receives raw Riot match JSON or timelines — only this
// compact, already-computed object (spec's "compact match-analysis
// object" pattern). It explains the numbers; it never (re)calculates them.
async function buildCompactMatchObject(env, platform, region, matchId, puuid) {
  await ensureMatchCached(env, region, platform, matchId);

  const own = await env.DB
    .prepare('SELECT * FROM match_participants WHERE match_id = ? AND puuid = ?')
    .bind(matchId, puuid)
    .first();
  if (!own) throw { status: 404, code: 'participant_not_found', message: 'That player was not found in this match.' };

  let opponent = null;
  if (own.role) {
    opponent = await env.DB
      .prepare('SELECT * FROM match_participants WHERE match_id = ? AND role = ? AND team_id != ? LIMIT 1')
      .bind(matchId, own.role, own.team_id)
      .first();
  }

  const shape = (row) => row && {
    champion: row.champion,
    role: row.role,
    win: !!row.win,
    kills: row.kills, deaths: row.deaths, assists: row.assists,
    kda: row.kda,
    csPerMin: row.cs_per_min,
    goldPerMin: row.gold_per_min,
    damageToChampions: row.damage_to_champs,
    visionScore: row.vision_score,
    killParticipation: row.kill_participation,
  };

  return {
    matchId,
    queue: QUEUE_NAMES[own.queue_id] || `Queue ${own.queue_id}`,
    durationSec: own.duration_sec,
    player: shape(own),
    opponent: shape(opponent),
  };
}

const MATCH_REVIEW_SYSTEM_PROMPT =
  'You are a League of Legends coach reviewing one game for a player. You will be given a compact JSON object of ' +
  "already-computed stats for the player and (when available) their direct opposing laner — never raw game data. " +
  'Do not invent or recalculate any numbers; only reference the values you are given. Explain what the stats ' +
  "suggest about the player's performance in this game, call out one or two concrete strengths and one or two " +
  'concrete areas to improve, and keep the whole review under 200 words in a direct, encouraging coaching tone.';

async function generateMatchReview(env, compactStats, playerContext) {
  return openaiChat(env, [
    { role: 'system', content: MATCH_REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ stats: compactStats, player: playerContext }) },
  ], 400);
}

const FOLLOWUP_SYSTEM_PROMPT =
  'You are a League of Legends coach continuing a conversation about a specific game you already reviewed. Answer ' +
  "the player's follow-up question using only the original review you were given — never invent new numbers. " +
  'Keep answers concise (under 150 words) and actionable.';

async function answerFollowupQuestion(env, priorReviewContent, question) {
  return openaiChat(env, [
    { role: 'system', content: FOLLOWUP_SYSTEM_PROMPT },
    { role: 'assistant', content: String(priorReviewContent) },
    { role: 'user', content: question },
  ], 300);
}

// =======================================================================
// PART 6 — Billing routes
// =======================================================================

async function handleBillingPlans(request, env) {
  let rows;
  try {
    rows = await sbAnonJson(
      env,
      '/subscription_plans?select=slug,display_name,price_cents,monthly_review_allowance,monthly_followup_allowance,saved_profile_limit&active=eq.true&order=sort_order.asc',
    );
  } catch (err) {
    if (isMissingRelationError(err)) {
      throw { status: 503, code: 'billing_not_configured', message: 'Billing is not set up yet.' };
    }
    throw { status: 502, code: 'billing_upstream_error', message: 'Could not load plans right now.' };
  }
  return json(env, { plans: rows || [] });
}

async function handleBillingCheckout(request, env) {
  const user = await requireUser(request);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const planSlug = body?.plan;
  if (!PURCHASABLE_PLAN_SLUGS.includes(planSlug)) {
    throw { status: 400, code: 'invalid_plan', message: `plan must be one of: ${PURCHASABLE_PLAN_SLUGS.join(', ')}` };
  }

  let planRow;
  try {
    const rows = await sbAnonJson(env, `/subscription_plans?select=slug,stripe_price_id,active&slug=eq.${encodeURIComponent(planSlug)}`);
    planRow = rows?.[0];
  } catch (err) {
    if (isMissingRelationError(err)) throw { status: 503, code: 'billing_not_configured', message: 'Billing is not set up yet.' };
    throw { status: 502, code: 'billing_upstream_error', message: 'Could not load that plan right now.' };
  }
  if (!planRow || !planRow.active) throw { status: 400, code: 'invalid_plan', message: 'That plan is not currently available.' };
  if (!planRow.stripe_price_id) throw { status: 503, code: 'billing_not_configured', message: 'That plan is not connected to Stripe yet.' };

  let existing;
  try {
    const rows = await sbServiceJson(env, `/user_subscriptions?select=stripe_customer_id&user_id=eq.${encodeURIComponent(user.id)}`);
    existing = rows?.[0];
  } catch {
    existing = null;
  }

  let customerId = existing?.stripe_customer_id;
  if (!customerId) {
    const customer = await createStripeCustomer(env, { email: user.email, userId: user.id });
    customerId = customer.id;
    await sbServiceJson(env, '/user_subscriptions?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: user.id, stripe_customer_id: customerId }),
    });
  }

  const successUrl = env.STRIPE_SUCCESS_URL || 'https://zindigon.com/lol/index.html?checkout=success';
  const cancelUrl = env.STRIPE_CANCEL_URL || 'https://zindigon.com/lol/index.html?checkout=cancel';

  const session = await createStripeCheckoutSession(env, {
    customerId, priceId: planRow.stripe_price_id, successUrl, cancelUrl, userId: user.id,
  });

  return json(env, { url: session.url });
}

async function handleBillingPortal(request, env) {
  const user = await requireUser(request);
  let existing;
  try {
    const rows = await sbServiceJson(env, `/user_subscriptions?select=stripe_customer_id&user_id=eq.${encodeURIComponent(user.id)}`);
    existing = rows?.[0];
  } catch {
    existing = null;
  }
  if (!existing?.stripe_customer_id) {
    throw { status: 400, code: 'no_stripe_customer', message: 'Set up a subscription before managing billing.' };
  }
  const returnUrl = env.STRIPE_PORTAL_RETURN_URL || 'https://zindigon.com/lol/index.html';
  const session = await createStripePortalSession(env, existing.stripe_customer_id, returnUrl);
  return json(env, { url: session.url });
}

async function handleBillingStatus(request, env) {
  const user = await requireUser(request);

  let sub = null;
  try {
    const rows = await sbServiceJson(
      env,
      `/user_subscriptions?select=plan_slug,status,current_period_start,current_period_end,cancel_at_period_end&user_id=eq.${encodeURIComponent(user.id)}`,
    );
    sub = rows?.[0] || null;
  } catch { /* treated as free below */ }

  const planSlug = sub?.plan_slug || 'free';

  let planRow = null;
  try {
    const rows = await sbAnonJson(
      env,
      `/subscription_plans?select=slug,display_name,monthly_review_allowance,monthly_followup_allowance,saved_profile_limit&slug=eq.${encodeURIComponent(planSlug)}`,
    );
    planRow = rows?.[0] || null;
  } catch { /* fall back to defaults below */ }

  const periodStartIso = monthStartIso();
  let allowanceRow = null;
  try {
    const rows = await sbServiceJson(
      env,
      `/ai_allowances?select=reviews_used,followups_used&user_id=eq.${encodeURIComponent(user.id)}&period_start=eq.${encodeURIComponent(periodStartIso)}`,
    );
    allowanceRow = rows?.[0] || null;
  } catch { /* none consumed yet this period */ }

  return json(env, {
    plan: planSlug,
    planDisplayName: planRow?.display_name || 'Free',
    status: sub?.status || 'active',
    currentPeriodStart: sub?.current_period_start || null,
    currentPeriodEnd: sub?.current_period_end || null,
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    allowances: {
      reviews: { used: allowanceRow?.reviews_used || 0, limit: planRow?.monthly_review_allowance ?? 0 },
      followups: { used: allowanceRow?.followups_used || 0, limit: planRow?.monthly_followup_allowance ?? 0 },
    },
    savedProfileLimit: planRow?.saved_profile_limit ?? 3,
  });
}

async function findUserIdByStripeCustomer(env, customerId) {
  const rows = await sbServiceJson(env, `/user_subscriptions?select=user_id&stripe_customer_id=eq.${encodeURIComponent(customerId)}`);
  return rows?.[0]?.user_id || null;
}

async function planSlugForStripePrice(env, priceId) {
  if (!priceId) return null;
  const rows = await sbAnonJson(env, `/subscription_plans?select=slug&stripe_price_id=eq.${encodeURIComponent(priceId)}`);
  return rows?.[0]?.slug || null;
}

async function upsertUserSubscription(env, userId, fields) {
  await sbServiceJson(env, '/user_subscriptions?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, updated_at: new Date().toISOString(), ...fields }),
  });
}

// Stripe's account API version pinned in the dashboard for this project
// (2025-11-17.clover, confirmed via Workbench > Webhooks > destination
// details) moved `current_period_start`/`current_period_end` off the
// Subscription object and onto each item in `subscription.items.data[]`
// (Stripe's "flexible billing mode" change). The old top-level
// `subscription.current_period_start`/`current_period_end` fields are
// `undefined` under this API version, so `undefined * 1000` -> `NaN` ->
// `new Date(NaN).toISOString()` threw `RangeError: Invalid time value` —
// confirmed live via Cloudflare's Observability logs, where every
// checkout.session.completed webhook was failing with exactly this error
// at this call site, which is why a completed Stripe checkout never made
// it into `user_subscriptions` and the site kept showing "Free". Reading
// from the first subscription item first (falling back to the old
// top-level fields for safety, in case Stripe ever reverts or a different
// API version is pinned later) fixes this for both current and older
// accounts.
function subscriptionPeriod(subscription) {
  const item = subscription.items?.data?.[0];
  const start = item?.current_period_start ?? subscription.current_period_start;
  const end = item?.current_period_end ?? subscription.current_period_end;
  return {
    start: Number.isFinite(start) ? new Date(start * 1000).toISOString() : null,
    end: Number.isFinite(end) ? new Date(end * 1000).toISOString() : null,
  };
}

async function handleCheckoutSessionCompleted(env, session) {
  const userId = await findUserIdByStripeCustomer(env, session.customer);
  if (!userId) {
    console.error({ message: 'checkout.session.completed: no matching user for customer', customer: session.customer });
    return;
  }
  if (!session.subscription) return; // not a subscription checkout

  const subscription = await getStripeSubscription(env, session.subscription);
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const planSlug = (await planSlugForStripePrice(env, priceId)) || 'free';
  const period = subscriptionPeriod(subscription);

  await upsertUserSubscription(env, userId, {
    plan_slug: planSlug,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: !!subscription.cancel_at_period_end,
    canceled_at: null,
    payment_failed_at: null,
    grace_period_end: null,
    last_successful_payment_at: new Date().toISOString(),
  });
}

async function handleSubscriptionUpdated(env, subscription) {
  const userId = await findUserIdByStripeCustomer(env, subscription.customer);
  if (!userId) return;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const planSlug = (await planSlugForStripePrice(env, priceId)) || 'free';
  const period = subscriptionPeriod(subscription);

  await upsertUserSubscription(env, userId, {
    plan_slug: planSlug,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: !!subscription.cancel_at_period_end,
  });
}

async function handleSubscriptionDeleted(env, subscription) {
  const userId = await findUserIdByStripeCustomer(env, subscription.customer);
  if (!userId) return;
  await upsertUserSubscription(env, userId, {
    plan_slug: 'free',
    status: 'canceled',
    canceled_at: new Date().toISOString(),
  });
}

async function handleInvoicePaymentFailed(env, invoice) {
  const userId = await findUserIdByStripeCustomer(env, invoice.customer);
  if (!userId) return;
  await upsertUserSubscription(env, userId, {
    status: 'past_due',
    payment_failed_at: new Date().toISOString(),
    grace_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

async function handleInvoicePaid(env, invoice) {
  const userId = await findUserIdByStripeCustomer(env, invoice.customer);
  if (!userId) return;
  await upsertUserSubscription(env, userId, {
    status: 'active',
    payment_failed_at: null,
    grace_period_end: null,
    last_successful_payment_at: new Date().toISOString(),
  });
}

async function processStripeEvent(env, event) {
  switch (event.type) {
    case 'checkout.session.completed': return handleCheckoutSessionCompleted(env, event.data.object);
    case 'customer.subscription.updated': return handleSubscriptionUpdated(env, event.data.object);
    case 'customer.subscription.deleted': return handleSubscriptionDeleted(env, event.data.object);
    case 'invoice.payment_failed': return handleInvoicePaymentFailed(env, event.data.object);
    case 'invoice.paid': return handleInvoicePaid(env, event.data.object);
    default: return; // unhandled event types are fine to ignore
  }
}

async function handleBillingWebhook(request, env) {
  const rawBody = await request.text();
  const sig = request.headers.get('Stripe-Signature');
  const valid = await verifyStripeSignature(env, rawBody, sig);
  if (!valid) throw { status: 400, code: 'invalid_signature', message: 'Invalid Stripe signature.' };

  let event;
  try { event = JSON.parse(rawBody); } catch {
    throw { status: 400, code: 'invalid_payload', message: 'Invalid JSON payload.' };
  }

  // Idempotency: insert-before-process. A primary-key conflict means this
  // event was already handled — return 200 without redoing side effects.
  try {
    await sbServiceJson(env, '/stripe_webhook_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ event_id: event.id, type: event.type }),
    });
  } catch (err) {
    if (err.status === 409) {
      return json(env, { received: true, duplicate: true });
    }
    console.error({ message: 'Failed to record webhook event — processing anyway', error: String(err) });
  }

  try {
    await processStripeEvent(env, event);
  } catch (err) {
    // Still return 200 below — Stripe retries on non-2xx, and retrying a
    // handler that will deterministically fail again just burns webhook
    // attempts. Logged here for manual follow-up instead.
    console.error({ message: 'Webhook processing failed', type: event.type, error: String(err && err.stack || err) });
  }

  return json(env, { received: true });
}

// =======================================================================
// PART 7 — AI routes
// =======================================================================

async function handleAiReview(request, env) {
  const user = await requireUser(request);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { matchId, puuid } = body || {};
  const platform = (body?.platform || '').toLowerCase();
  if (!matchId || !puuid || !VALID_PLATFORMS.includes(platform)) {
    throw { status: 400, code: 'invalid_request', message: 'matchId, puuid, and a valid platform are required.' };
  }
  const region = PLATFORM_TO_REGION[platform];

  // Cheap best-effort fast path against duplicate double-clicks — NOT a
  // substitute for the ai_reviews unique constraint / consume_ai_allowance
  // RPC, which are the real correctness guarantee (see migration file).
  const lockKey = `aireview-lock:${user.id}:${matchId}`;
  const locked = await env.CACHE.get(lockKey);
  if (locked) {
    throw { status: 409, code: 'review_in_progress', message: 'A review for this match is already being generated — try again in a moment.' };
  }
  await env.CACHE.put(lockKey, '1', { expirationTtl: 90 });

  try {
    const gate = await sbRpc(env, 'consume_ai_allowance', { p_user_id: user.id, p_kind: 'review', p_match_id: matchId });

    if (gate.cached) {
      const rows = await sbServiceJson(
        env,
        `/ai_reviews?select=content,created_at&user_id=eq.${encodeURIComponent(user.id)}&match_id=eq.${encodeURIComponent(matchId)}`,
      );
      const existing = rows?.[0];
      if (existing) return json(env, { review: existing.content, cached: true, createdAt: existing.created_at });
      // Fell through: the RPC says cached but the row is gone — regenerate below.
    }

    if (!gate.allowed) {
      throw { status: 402, code: 'allowance_exceeded', message: `You've used all your AI reviews for this billing period on the ${gate.plan || 'free'} plan.` };
    }

    const consumedFreshUnit = !gate.cached;

    let compact, result;
    try {
      compact = await buildCompactMatchObject(env, platform, region, matchId, puuid);
      result = await generateMatchReview(env, compact, { champion: compact.player?.champion, role: compact.player?.role });
    } catch (err) {
      if (consumedFreshUnit) {
        await sbRpc(env, 'refund_ai_allowance', { p_user_id: user.id, p_kind: 'review' }).catch((refundErr) =>
          console.error({ message: 'Failed to refund ai_allowance after review failure', error: String(refundErr) }));
      }
      throw err;
    }

    let stored = result.content;
    try {
      const rows = await sbServiceJson(env, '/ai_reviews', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: user.id, match_id: matchId, provider: 'openai', model: result.model, content: result.content }),
      });
      stored = rows?.[0]?.content ?? result.content;
    } catch (err) {
      if (err.status === 409) {
        // Lost a race with a concurrent identical request — serve the
        // version that won rather than returning two different reviews.
        const rows = await sbServiceJson(
          env,
          `/ai_reviews?select=content&user_id=eq.${encodeURIComponent(user.id)}&match_id=eq.${encodeURIComponent(matchId)}`,
        );
        stored = rows?.[0]?.content ?? result.content;
      } else {
        console.error({ message: 'Failed to store ai_review', error: String(err) });
      }
    }

    sbServiceJson(env, '/ai_usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: user.id, request_type: 'review', provider: 'openai', model: result.model, match_id: matchId,
        input_tokens: result.promptTokens, output_tokens: result.completionTokens,
        estimated_cost_cents: result.costCents, latency_ms: result.latencyMs, success: true, cached: false,
      }),
    }).catch((err) => console.error({ message: 'Failed to log ai_usage_event', error: String(err) }));

    return json(env, { review: stored, cached: false, remaining: gate.remaining });
  } finally {
    await env.CACHE.delete(lockKey);
  }
}

async function handleAiFollowup(request, env) {
  const user = await requireUser(request);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { matchId, question } = body || {};
  if (!matchId || !question || !String(question).trim()) {
    throw { status: 400, code: 'invalid_request', message: 'matchId and question are required.' };
  }

  const existingRows = await sbServiceJson(
    env,
    `/ai_reviews?select=content&user_id=eq.${encodeURIComponent(user.id)}&match_id=eq.${encodeURIComponent(matchId)}`,
  );
  const existing = existingRows?.[0];
  if (!existing) {
    throw { status: 400, code: 'no_review_yet', message: 'Get an AI review for this match before asking a follow-up question.' };
  }

  const gate = await sbRpc(env, 'consume_ai_allowance', { p_user_id: user.id, p_kind: 'followup', p_match_id: null });
  if (!gate.allowed) {
    throw { status: 402, code: 'allowance_exceeded', message: `You've used all your follow-up questions for this billing period on the ${gate.plan || 'free'} plan.` };
  }

  let result;
  try {
    result = await answerFollowupQuestion(env, existing.content, String(question).trim());
  } catch (err) {
    await sbRpc(env, 'refund_ai_allowance', { p_user_id: user.id, p_kind: 'followup' }).catch((refundErr) =>
      console.error({ message: 'Failed to refund ai_allowance after followup failure', error: String(refundErr) }));
    throw err;
  }

  sbServiceJson(env, '/ai_usage_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.id, request_type: 'followup', provider: 'openai', model: result.model, match_id: matchId,
      input_tokens: result.promptTokens, output_tokens: result.completionTokens,
      estimated_cost_cents: result.costCents, latency_ms: result.latencyMs, success: true, cached: false,
    }),
  }).catch((err) => console.error({ message: 'Failed to log ai_usage_event', error: String(err) }));

  return json(env, { answer: result.content, remaining: gate.remaining });
}

// =======================================================================
// Entry point
// =======================================================================

const ROUTES = [
  { method: 'GET', path: '/account', handler: (request, env, url) => handleAccount(env, url) },
  { method: 'GET', path: '/rank', handler: (request, env, url) => handleRank(env, url) },
  { method: 'GET', path: '/matches', handler: (request, env, url) => handleMatches(env, url) },
  { method: 'GET', path: '/match', handler: (request, env, url) => handleMatchDetail(env, url) },
  { method: 'GET', path: '/billing/plans', handler: (request, env) => handleBillingPlans(request, env) },
  { method: 'POST', path: '/billing/checkout', handler: (request, env) => handleBillingCheckout(request, env) },
  { method: 'POST', path: '/billing/portal', handler: (request, env) => handleBillingPortal(request, env) },
  { method: 'GET', path: '/billing/status', handler: (request, env) => handleBillingStatus(request, env) },
  { method: 'POST', path: '/billing/webhook', handler: (request, env) => handleBillingWebhook(request, env) },
  { method: 'POST', path: '/ai/review', handler: (request, env) => handleAiReview(request, env) },
  { method: 'POST', path: '/ai/followup', handler: (request, env) => handleAiFollowup(request, env) },
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const route = ROUTES.find((r) => r.method === request.method && r.path === url.pathname);

    try {
      if (!route) return errorJson(env, 404, 'not_found', 'Unknown route');
      return await route.handler(request, env, url);
    } catch (err) {
      if (err instanceof RiotAuthError) {
        return errorJson(env, 503, 'riot_unavailable',
          'League data is temporarily unavailable while our Riot connection is refreshed. Please try again shortly.');
      }
      if (err instanceof RiotRateLimitError) {
        return errorJson(env, 503, 'riot_rate_limited', 'Riot is rate-limiting us right now — please try again in a moment.');
      }
      if (err instanceof RiotNotFoundError) {
        return errorJson(env, 404, 'riot_not_found', 'That Riot ID or match could not be found.');
      }
      if (err && typeof err.status === 'number') {
        return errorJson(env, err.status, err.code || 'bad_request', err.message || 'Bad request');
      }
      console.error({ message: 'Unhandled error', error: String(err && err.stack || err) });
      return errorJson(env, 500, 'internal_error', 'Something went wrong on our end.');
    }
  },
};
