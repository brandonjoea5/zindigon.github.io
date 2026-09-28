// Zindigon | Bloodline Zero — episode API.
// Single-file Worker (no bundler, no npm deps) so it can be deployed by
// `wrangler deploy` from GitHub Actions with nothing else to install.
// Raw fetch() everywhere instead of the Stripe/Supabase SDKs, same pattern
// as zindigon-league-api.
//
// Isolated on purpose: its own D1 database (zindigon-bloodlinezero), no
// bindings shared with the paused League Worker.

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

// Same Supabase project every other Zindigon tool uses — not a secret,
// hard-coded like lol/auth-shared.js and builds/builds-shared.js.
const SUPABASE_URL = "https://kryfuceztfzccsidkzog.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyeWZ1Y2V6dGZ6Y2NzaWRrem9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODY1MjIsImV4cCI6MjA5MzY2MjUyMn0.c_pmdXWHLQYh1dwkCwhqpW7lpgIzK13UUq2ZW53XhAs";

const DEFAULT_ALLOW_ORIGIN = "https://zindigon.com";
const DEFAULT_SUCCESS_URL = "https://zindigon.com/bloodline-zero/library.html?checkout=success";
const DEFAULT_CANCEL_URL = "https://zindigon.com/bloodline-zero/checkout.html?checkout=cancelled";

// $1.99/episode base price. Bundle discount is derived from real Stripe fee
// savings (2.9% + $0.30/transaction): bundling N episodes into one Checkout
// instead of N separate purchases saves exactly (N-1) * $0.30 in fixed fees
// (the 2.9% variable cut is identical either way). ~55.6% of that raw saving
// is passed back to the customer as a discount, which comes out to almost
// exactly 50/3 cents (~16.67 cents) per additional episode in the bundle.
// Integer cent math throughout — never floats — so this always matches
// what Stripe actually charges to the cent.
const BASE_PRICE_CENTS = 199;
const DISCOUNT_NUM = 50; // discountCents(N) = round((N-1) * DISCOUNT_NUM / DISCOUNT_DEN)
const DISCOUNT_DEN = 3;

function discountCentsFor(n) {
  if (n <= 1) return 0;
  return Math.round(((n - 1) * DISCOUNT_NUM) / DISCOUNT_DEN);
}

function bundlePriceCents(n) {
  if (n <= 0) return 0;
  return n * BASE_PRICE_CENTS - discountCentsFor(n);
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function corsHeaders(env) {
  const origin = env.ALLOW_ORIGIN || DEFAULT_ALLOW_ORIGIN;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Secret",
    "Vary": "Origin",
  };
}

function json(data, status, env, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
      ...(extraHeaders || {}),
    },
  });
}

function errorJson(message, status, env) {
  return json({ error: message }, status || 400, env);
}

// ---------------------------------------------------------------------
// Auth — verify the browser's Supabase session token, same contract used
// by every other Zindigon Worker route.
// ---------------------------------------------------------------------

async function verifySupabaseUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON,
    },
  });
  if (!resp.ok) return null;
  const user = await resp.json();
  if (!user || !user.id) return null;
  return user;
}

function requireAdmin(request, env) {
  const provided = request.headers.get("X-Admin-Secret") || "";
  if (!env.ADMIN_INGEST_SECRET) return false;
  return provided.length > 0 && provided === env.ADMIN_INGEST_SECRET;
}

// ---------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------

const EPISODE_PUBLIC_COLUMNS =
  "number, slug, title, teaser, is_free, price_cents, reading_time_min, word_count, published_at";

async function listEpisodesPublic(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${EPISODE_PUBLIC_COLUMNS} FROM episodes ORDER BY number ASC`
  ).all();
  return (results || []).map((row) => ({
    ...row,
    is_free: !!row.is_free,
  }));
}

async function getEpisodeByNumber(env, number) {
  const row = await env.DB.prepare(
    `SELECT id, ${EPISODE_PUBLIC_COLUMNS}, body FROM episodes WHERE number = ?`
  )
    .bind(number)
    .first();
  return row || null;
}

async function hasPurchase(env, userId, episodeId) {
  const row = await env.DB.prepare(
    "SELECT 1 FROM episode_purchases WHERE user_id = ? AND episode_id = ?"
  )
    .bind(userId, episodeId)
    .first();
  return !!row;
}

async function listPurchasedEpisodeIds(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT episode_id FROM episode_purchases WHERE user_id = ?"
  )
    .bind(userId)
    .all();
  return new Set((results || []).map((r) => r.episode_id));
}

async function upsertEpisode(env, ep) {
  await env.DB.prepare(
    `INSERT INTO episodes
       (number, slug, title, teaser, is_free, price_cents, reading_time_min, word_count, body, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET
       slug = excluded.slug,
       title = excluded.title,
       teaser = excluded.teaser,
       is_free = excluded.is_free,
       price_cents = excluded.price_cents,
       reading_time_min = excluded.reading_time_min,
       word_count = excluded.word_count,
       body = excluded.body,
       published_at = excluded.published_at`
  )
    .bind(
      ep.number,
      ep.slug,
      ep.title,
      ep.teaser,
      ep.is_free ? 1 : 0,
      ep.price_cents,
      ep.reading_time_min,
      ep.word_count,
      ep.body,
      ep.published_at
    )
    .run();
}

// ---------------------------------------------------------------------
// Stripe helpers (raw fetch, no SDK)
// ---------------------------------------------------------------------

function formEncode(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) params.append(k, v);
  return params.toString();
}

async function stripeCreateCheckoutSession(env, { userId, userEmail, episodeNumbers, amountCents, description, successUrl, cancelUrl }) {
  const body = {
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": "Bloodline Zero — Episodes",
    "line_items[0][price_data][product_data][description]": description,
    "line_items[0][quantity]": "1",
    "metadata[user_id]": userId,
    "metadata[episode_numbers]": episodeNumbers.join(","),
    success_url: successUrl || env.STRIPE_SUCCESS_URL || DEFAULT_SUCCESS_URL,
    cancel_url: cancelUrl || env.STRIPE_CANCEL_URL || DEFAULT_CANCEL_URL,
  };
  if (userEmail) body.customer_email = userEmail;

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Stripe checkout session creation failed");
  return data;
}

async function verifyStripeSignature(request, env, rawBody) {
  const sigHeader = request.headers.get("Stripe-Signature") || "";
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  // Reject stale signatures (replay defense) — 5 minute window.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time-ish compare.
  if (computed.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      // ---- Health -------------------------------------------------
      if (path === "/health" && method === "GET") {
        return json({ ok: true, service: "zindigon-bloodlinezero-api" }, 200, env);
      }

      // ---- Pricing (public — powers the "+episode" cart stepper) --
      if (path === "/pricing" && method === "GET") {
        const table = [];
        for (let n = 1; n <= 14; n++) {
          table.push({
            episodes: n,
            total_cents: bundlePriceCents(n),
            discount_cents: discountCentsFor(n),
          });
        }
        return json(
          { base_price_cents: BASE_PRICE_CENTS, table },
          200,
          env
        );
      }

      // ---- Episodes list (public metadata only, no body) -----------
      if (path === "/episodes" && method === "GET") {
        const episodes = await listEpisodesPublic(env);
        return json({ episodes }, 200, env);
      }

      // ---- Single episode (gated body) -----------------------------
      const episodeMatch = path.match(/^\/episodes\/(\d+)$/);
      if (episodeMatch && method === "GET") {
        const number = Number(episodeMatch[1]);
        const episode = await getEpisodeByNumber(env, number);
        if (!episode) return errorJson("Episode not found.", 404, env);

        if (episode.is_free) {
          return json({ episode: { ...episode, is_free: true } }, 200, env);
        }

        const user = await verifySupabaseUser(request, env);
        if (!user) {
          return errorJson(
            "Sign in to read this episode.",
            401,
            env
          );
        }
        const owned = await hasPurchase(env, user.id, episode.id);
        if (!owned) {
          return json(
            {
              error: "not_purchased",
              message: "Purchase this episode to read it.",
              price_cents: episode.price_cents,
            },
            403,
            env
          );
        }
        return json({ episode: { ...episode, is_free: !!episode.is_free } }, 200, env);
      }

      // ---- My Library (purchased episodes + progress) --------------
      if (path === "/library" && method === "GET") {
        const user = await verifySupabaseUser(request, env);
        if (!user) return errorJson("Sign in required.", 401, env);

        const [episodes, ownedIds, progressRows] = await Promise.all([
          listEpisodesPublic(env),
          listPurchasedEpisodeIds(env, user.id),
          env.DB.prepare(
            "SELECT episode_id, percent, updated_at FROM reading_progress WHERE user_id = ?"
          )
            .bind(user.id)
            .all()
            .then((r) => r.results || []),
        ]);

        // Need episode.id <-> number mapping for progress; fetch ids too.
        const { results: idRows } = await env.DB.prepare(
          "SELECT id, number FROM episodes"
        ).all();
        const idToNumber = new Map((idRows || []).map((r) => [r.id, r.number]));
        const progressByNumber = {};
        for (const p of progressRows) {
          const num = idToNumber.get(p.episode_id);
          if (num != null) progressByNumber[num] = { percent: p.percent, updated_at: p.updated_at };
        }
        const numberToId = new Map((idRows || []).map((r) => [r.number, r.id]));

        const library = episodes.map((ep) => ({
          ...ep,
          owned: ep.is_free || ownedIds.has(numberToId.get(ep.number)),
          progress: progressByNumber[ep.number] || null,
        }));

        return json({ library }, 200, env);
      }

      // ---- Reading progress ------------------------------------------
      if (path === "/progress" && method === "POST") {
        const user = await verifySupabaseUser(request, env);
        if (!user) return errorJson("Sign in required.", 401, env);
        const body = await request.json().catch(() => null);
        if (!body || typeof body.episodeNumber !== "number" || typeof body.percent !== "number") {
          return errorJson("episodeNumber and percent are required.", 400, env);
        }
        const percent = Math.max(0, Math.min(100, body.percent));
        const episode = await getEpisodeByNumber(env, body.episodeNumber);
        if (!episode) return errorJson("Episode not found.", 404, env);

        await env.DB.prepare(
          `INSERT INTO reading_progress (user_id, episode_id, percent, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, episode_id) DO UPDATE SET
             percent = excluded.percent,
             updated_at = excluded.updated_at`
        )
          .bind(user.id, episode.id, percent)
          .run();

        return json({ ok: true }, 200, env);
      }

      // ---- Billing: create checkout session ---------------------------
      if (path === "/billing/checkout" && method === "POST") {
        if (!env.STRIPE_SECRET_KEY) {
          return errorJson("Stripe not configured yet.", 501, env);
        }
        const user = await verifySupabaseUser(request, env);
        if (!user) return errorJson("Sign in required.", 401, env);

        const body = await request.json().catch(() => null);
        const episodeNumbers = Array.isArray(body?.episodeNumbers)
          ? [...new Set(body.episodeNumbers.map(Number))].filter((n) => Number.isInteger(n))
          : [];
        if (episodeNumbers.length === 0) {
          return errorJson("episodeNumbers must be a non-empty array.", 400, env);
        }

        // Server always recomputes from scratch — never trusts a
        // client-submitted total. Drop free episodes and anything the
        // user already owns before pricing the bundle.
        const owned = await listPurchasedEpisodeIds(env, user.id);
        const { results: rows } = await env.DB.prepare(
          `SELECT id, number, is_free, price_cents FROM episodes WHERE number IN (${episodeNumbers.map(() => "?").join(",")})`
        )
          .bind(...episodeNumbers)
          .all();

        const toBuy = (rows || []).filter((r) => !r.is_free && !owned.has(r.id));
        if (toBuy.length === 0) {
          return errorJson("Nothing left to purchase in that selection.", 400, env);
        }

        const n = toBuy.length;
        const amountCents = bundlePriceCents(n);
        const numbers = toBuy.map((r) => r.number).sort((a, b) => a - b);
        const description =
          n === 1 ? `Episode ${numbers[0]}` : `Episodes ${numbers.join(", ")} (${n}-episode bundle)`;

        const session = await stripeCreateCheckoutSession(env, {
          userId: user.id,
          userEmail: user.email,
          episodeNumbers: numbers,
          amountCents,
          description,
          successUrl: body?.successUrl,
          cancelUrl: body?.cancelUrl,
        });

        return json({ url: session.url, amount_cents: amountCents }, 200, env);
      }

      // ---- Billing: Stripe webhook -------------------------------------
      if (path === "/billing/webhook" && method === "POST") {
        const rawBody = await request.text();
        const valid = await verifyStripeSignature(request, env, rawBody);
        if (!valid) return errorJson("Invalid signature.", 400, env);

        const event = JSON.parse(rawBody);

        // Dedupe — insert-before-process; a conflict means already handled.
        try {
          await env.DB.prepare(
            "INSERT INTO stripe_webhook_events (event_id, type) VALUES (?, ?)"
          )
            .bind(event.id, event.type)
            .run();
        } catch (e) {
          return json({ received: true, deduped: true }, 200, env);
        }

        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const userId = session.metadata?.user_id;
          const episodeNumbersStr = session.metadata?.episode_numbers || "";
          const numbers = episodeNumbersStr
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n));
          const totalAmountCents = session.amount_total || 0;

          if (userId && numbers.length > 0) {
            const { results: rows } = await env.DB.prepare(
              `SELECT id, number FROM episodes WHERE number IN (${numbers.map(() => "?").join(",")})`
            )
              .bind(...numbers)
              .all();
            const perEpisodeCents = Math.round(totalAmountCents / numbers.length);
            for (const row of rows || []) {
              await env.DB.prepare(
                `INSERT INTO episode_purchases
                   (user_id, episode_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, episode_id) DO NOTHING`
              )
                .bind(userId, row.id, session.id, session.payment_intent || null, perEpisodeCents)
                .run();
            }
          }
        }

        return json({ received: true }, 200, env);
      }

      // ---- Admin: ingest/update episode content -----------------------
      // Content never lives in the (public) GitHub repo or ships to the
      // client — it's POSTed here once, straight into D1, from a trusted
      // browser session (never from anything in this repo).
      if (path === "/admin/ingest" && method === "POST") {
        if (!requireAdmin(request, env)) return errorJson("Forbidden.", 403, env);
        const body = await request.json().catch(() => null);
        const episodes = Array.isArray(body?.episodes) ? body.episodes : null;
        if (!episodes) return errorJson("Expected { episodes: [...] }.", 400, env);

        const required = [
          "number",
          "slug",
          "title",
          "teaser",
          "is_free",
          "price_cents",
          "reading_time_min",
          "word_count",
          "body",
          "published_at",
        ];
        for (const ep of episodes) {
          for (const key of required) {
            if (ep[key] === undefined) {
              return errorJson(`Episode ${ep.number ?? "?"} missing field "${key}".`, 400, env);
            }
          }
        }

        for (const ep of episodes) {
          await upsertEpisode(env, ep);
        }

        return json({ ok: true, ingested: episodes.length }, 200, env);
      }

      return errorJson("Not found.", 404, env);
    } catch (err) {
      return errorJson(`Internal error: ${err.message}`, 500, env);
    }
  },
};
