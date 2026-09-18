// Zindigon League API — Phase 1
//
// Public, unauthenticated endpoints backing zindigon.com/lol/. Resolves a
// Riot ID to a PUUID, fetches rank + match history, and normalizes/caches
// everything in D1 (durable) and KV (short-TTL) so that browsing match
// history almost never touches Riot's API after the first visit.
//
// Design constraint: this runs on the Workers FREE plan (10ms CPU / 50
// subrequests per invocation). Browsing (this file) never fetches match
// timelines — only account/rank/match-list/match-detail, which is enough
// for the free numerical match-history experience. Timelines are fetched
// lazily, one match at a time, only when a paid/trial AI review needs one
// (that's Phase 2 — a separate route will be added then, not here).
//
// Routes:
//   GET /account?platform=na1&name=Foo&tag=NA1
//   GET /rank?platform=na1&puuid=...
//   GET /matches?platform=na1&puuid=...&start=0&count=20&sort=newest&...filters
//   GET /match?platform=na1&matchId=NA1_123456789

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

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || 'https://zindigon.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

// ---------------------------------------------------------------------
// Riot fetch wrapper — retry on 429 (Retry-After), surface expired-key
// and rate-limit states as typed errors rather than letting a raw Riot
// error reach the browser.
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Account resolution (Riot ID -> PUUID), cached in D1 for ~14 days.
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Rank, cached in KV for 20 minutes (native TTL).
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Match ID list, cached in KV for 10 minutes (native TTL). Riot returns
// newest-first; we cache a generous window (100) once and paginate
// in-Worker so repeated page requests don't re-hit Riot.
// ---------------------------------------------------------------------

async function getMatchIdWindow(env, region, puuid) {
  const cacheKey = `matchids:${region}:${puuid}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return cached;

  const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=100`;
  const ids = await riotGet(env, url);

  await env.CACHE.put(cacheKey, JSON.stringify(ids), { expirationTtl: 10 * 60 });
  return ids;
}

// ---------------------------------------------------------------------
// Match normalization — mirrors the fields the original Catalyst function
// captured, trimmed to what Phase 1's browsing/filtering UI needs.
// Full participant detail still lives in matches.raw_json for the detail
// view; match_participants is the fast, filterable/sortable index.
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

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

  // 1. Get the cached window of recent match ids (newest-first) and slice
  //    the page the client asked for.
  const allIds = await getMatchIdWindow(env, region, puuid);
  const pageIds = allIds.slice(start, start + count);

  // 2. Make sure every id on this page is cached in D1 (bounded per request
  //    so a single invocation can't blow the Free-tier subrequest budget).
  let newlyFetched = 0;
  for (const matchId of pageIds) {
    const exists = await env.DB.prepare('SELECT 1 FROM matches WHERE match_id = ?').bind(matchId).first();
    if (exists) continue;
    if (newlyFetched >= MAX_NEW_MATCHES_PER_REQUEST) break; // rest arrive on the next page/refresh
    await ensureMatchCached(env, region, platform, matchId);
    newlyFetched++;
  }

  // 3. Pull the (now-cached) rows for this page's ids, honoring filters +
  //    the requested sort, straight from the fast index table.
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
  const { results } = await env.DB.prepare(sql).bind(puuid, ...binds).all();

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

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/account': return await handleAccount(env, url);
        case '/rank': return await handleRank(env, url);
        case '/matches': return await handleMatches(env, url);
        case '/match': return await handleMatchDetail(env, url);
        default:
          return errorJson(env, 404, 'not_found', 'Unknown route');
      }
    } catch (err) {
      if (err instanceof RiotAuthError) {
        // Never surface Riot's own error to the visitor — this is almost
        // always the 24h dev key expiring during development.
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
