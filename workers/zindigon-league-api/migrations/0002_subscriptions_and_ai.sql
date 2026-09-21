-- Zindigon League — Phase 2 Supabase migration (Plus/Premier billing + the
-- minimal AI match-review pipeline that gives paid tiers something real).
--
-- STAGED, NOT YET APPLIED. Supabase is still unreachable from the user's
-- dev network (same constraint as 0001_saved_riot_profiles.sql) — apply
-- this in the Supabase SQL editor, or via a service-role key/DB connection
-- string from a network that *can* reach the project, whichever comes
-- first. Nothing in the existing Worker or D1 cache depends on this
-- existing yet.
--
-- Design notes:
--  * subscription_plans is what the pricing UI and the Worker both read —
--    nothing about prices, allowances, or Stripe price IDs is hard-coded
--    anywhere else. Public (anon + authenticated) read-only.
--  * user_subscriptions is a SEPARATE table from public.players, not new
--    columns bolted onto it. players already carries a self-service
--    "update your own row" pattern (username/selected_title) for ordinary
--    account fields — adding plan/status columns there risks a future
--    edit to that policy accidentally letting a user PATCH their own way
--    onto Premier. This table gets a read-only policy for its own owner
--    and *no* insert/update/delete policy at all, which under Postgres
--    RLS means default-deny: only a request using the service-role key
--    (which bypasses RLS, and is only ever used server-side inside the
--    Worker after a verified Stripe webhook) can ever write a row here.
--  * ai_allowances / ai_usage_events / ai_reviews / stripe_webhook_events
--    follow the same default-deny-write pattern.
--  * consume_ai_allowance() is a single atomic RPC so two near-simultaneous
--    duplicate "review this match" requests can't both succeed and double
--    charge an allowance — the ai_reviews unique constraint plus this
--    function's row lock (`for update`) is the real guarantee; a
--    short-TTL KV lock in the Worker is just a cheap first line of
--    defense in front of it, not a substitute.

-- ---------------------------------------------------------------------
-- subscription_plans
-- ---------------------------------------------------------------------
create table if not exists public.subscription_plans (
  slug text primary key,                    -- 'free' | 'plus' | 'premier'
  display_name text not null,
  price_cents integer not null default 0,
  stripe_price_id text,                     -- null for 'free'
  monthly_review_allowance integer not null default 0,
  monthly_followup_allowance integer not null default 0,
  saved_profile_limit integer not null default 3,
  active boolean not null default true,
  sort_order integer not null default 0
);

alter table public.subscription_plans enable row level security;

create policy "subscription_plans_select_active"
  on public.subscription_plans for select
  using (active);

-- Seed rows — safe to re-run (on conflict re-syncs stripe_price_id, so a
-- switch from test-mode to live-mode price IDs just needs this insert
-- re-run with updated values). The two stripe_price_id values below are
-- real Stripe TEST-mode price IDs for "Zindigon League Plus" ($9.99/mo)
-- and "Zindigon League Premier" ($19.99/mo), created directly in the
-- Stripe dashboard; swap them for live-mode price IDs before going live.
-- Prices/allowances below are starting values the user can adjust freely
-- (they're config, not schema).
insert into public.subscription_plans
  (slug, display_name, price_cents, stripe_price_id, monthly_review_allowance, monthly_followup_allowance, saved_profile_limit, sort_order)
values
  ('free', 'Free', 0, null, 0, 0, 3, 0),
  ('plus', 'Plus', 999, 'price_1UI8PWPF8SrXiC52QEGvEYpv', 15, 30, 10, 1),
  ('premier', 'Premier', 1999, 'price_1UI8QFPF8SrXiC5274gH6JPW', 50, 100, 25, 2)
on conflict (slug) do update set stripe_price_id = excluded.stripe_price_id;

-- ---------------------------------------------------------------------
-- user_subscriptions — separate table, default-deny writes (see notes
-- above). One row per user; absence of a row means "free" (the Worker and
-- consume_ai_allowance() both treat a missing row as plan_slug = 'free').
-- ---------------------------------------------------------------------
create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_slug text not null default 'free' references public.subscription_plans(slug),
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'active'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  payment_failed_at timestamptz,
  grace_period_end timestamptz,
  last_successful_payment_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_subscriptions_stripe_customer
  on public.user_subscriptions(stripe_customer_id);
create index if not exists idx_user_subscriptions_stripe_subscription
  on public.user_subscriptions(stripe_subscription_id);

alter table public.user_subscriptions enable row level security;

-- Users can see their own plan/status. No insert/update/delete policy
-- exists — that's the default-deny: only the service-role key (used only
-- inside the Worker, only after a verified Stripe webhook) can write here.
create policy "user_subscriptions_select_own"
  on public.user_subscriptions for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- ai_allowances — authoritative per-period usage counters. This is what
-- gets checked/incremented, never derived by counting ai_usage_events at
-- request time.
-- ---------------------------------------------------------------------
create table if not exists public.ai_allowances (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  reviews_used integer not null default 0,
  followups_used integer not null default 0,
  primary key (user_id, period_start)
);

alter table public.ai_allowances enable row level security;

create policy "ai_allowances_select_own"
  on public.ai_allowances for select
  using (auth.uid() = user_id);
-- No write policy — service-role only, via consume_ai_allowance() below.

-- ---------------------------------------------------------------------
-- ai_usage_events — append-only cost/audit log. Never read for allowance
-- math; exists only to feed a future admin cost dashboard (out of scope
-- for this round).
-- ---------------------------------------------------------------------
create table if not exists public.ai_usage_events (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('review', 'followup')),
  provider text not null default 'openai',
  model text,
  match_id text,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_cents numeric(10,4),
  latency_ms integer,
  success boolean not null default true,
  cached boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_usage_events_user_created
  on public.ai_usage_events(user_id, created_at desc);

alter table public.ai_usage_events enable row level security;
-- No policies at all — not even self-select. This table backs a future
-- admin cost dashboard (service-role only); ai_allowances/ai_reviews
-- already cover what a user should ever see about their own usage.

-- ---------------------------------------------------------------------
-- ai_reviews — one stored review per (user, match). The unique constraint
-- is what makes a duplicate "review this match" request safe to retry
-- for free (see consume_ai_allowance()'s cache check below).
-- ---------------------------------------------------------------------
create table if not exists public.ai_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  match_id text not null,
  provider text not null default 'openai',
  model text,
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, match_id)
);

create index if not exists idx_ai_reviews_user on public.ai_reviews(user_id);

alter table public.ai_reviews enable row level security;

create policy "ai_reviews_select_own"
  on public.ai_reviews for select
  using (auth.uid() = user_id);
-- No write policy — only the Worker's service-role insert (after a
-- successful OpenAI call) can create a review row.

-- ---------------------------------------------------------------------
-- stripe_webhook_events — idempotency ledger. The webhook handler inserts
-- the event id *before* processing; a primary-key conflict means "already
-- handled," so it can return 200 immediately without redoing side effects.
-- ---------------------------------------------------------------------
create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
-- No policies at all — service-role only, never read or written by any
-- user-facing code path.

-- ---------------------------------------------------------------------
-- consume_ai_allowance(p_user_id, p_kind, p_match_id)
--
-- Atomically:
--  1. If p_kind = 'review' and an ai_reviews row already exists for
--     (p_user_id, p_match_id), returns {allowed: true, cached: true}
--     immediately without touching the allowance counters — a duplicate
--     request for a match already reviewed is free and idempotent.
--  2. Otherwise resolves the caller's plan from user_subscriptions
--     (defaulting to 'free' if no row exists, or its status isn't one of
--     active/trialing/past_due — past_due still gets a grace window
--     rather than an instant hard cutoff), looks up that plan's
--     monthly_review_allowance/monthly_followup_allowance, locks (or
--     creates) the current calendar-month's ai_allowances row with
--     `for update` so concurrent calls serialize, and either increments
--     the relevant counter and returns {allowed: true, cached: false} or
--     returns {allowed: false, reason: 'limit'} if the caller is at cap.
--
-- SECURITY DEFINER so it can read/write ai_allowances and ai_reviews
-- despite their having no user-facing write policy. Only the service-role
-- key may ever call it (see the revoke/grant below) — never a browser's
-- anon/authenticated session, since a caller-supplied p_user_id would
-- otherwise let any signed-in user consume or probe another user's
-- allowance.
-- ---------------------------------------------------------------------
create or replace function public.consume_ai_allowance(
  p_user_id uuid,
  p_kind text,     -- 'review' | 'followup'
  p_match_id text  -- required for 'review' (cache check); ignored for 'followup'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_slug text;
  v_review_limit integer;
  v_followup_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_reviews_used integer;
  v_followups_used integer;
begin
  if p_kind not in ('review', 'followup') then
    raise exception 'invalid p_kind: %', p_kind;
  end if;

  -- 1. Cache check for reviews: a match already reviewed for this user is
  --    always a free, allowed, idempotent re-fetch.
  if p_kind = 'review' and p_match_id is not null then
    if exists (select 1 from public.ai_reviews where user_id = p_user_id and match_id = p_match_id) then
      return jsonb_build_object('allowed', true, 'cached', true);
    end if;
  end if;

  -- 2. Resolve the caller's plan; missing row or non-paying status = free.
  select plan_slug into v_plan_slug
    from public.user_subscriptions
    where user_id = p_user_id and status in ('active', 'trialing', 'past_due');

  if v_plan_slug is null then
    v_plan_slug := 'free';
  end if;

  select monthly_review_allowance, monthly_followup_allowance
    into v_review_limit, v_followup_limit
    from public.subscription_plans
    where slug = v_plan_slug;

  if v_review_limit is null then
    -- Plan slug on the subscription row doesn't match any known plan
    -- (shouldn't happen given the FK, but fail closed rather than error).
    v_review_limit := 0;
    v_followup_limit := 0;
  end if;

  -- 3. Current calendar-month period. Billing-period alignment for paying
  --    users happens at the webhook layer (current_period_start/end on
  --    user_subscriptions); this function only needs *a* period key that
  --    doesn't reset early or overlap.
  v_period_start := date_trunc('month', now());
  v_period_end := v_period_start + interval '1 month';

  -- 4. Lock (or create) this period's row for this user, so two
  --    concurrent calls serialize instead of both reading stale counts.
  insert into public.ai_allowances (user_id, period_start, period_end, reviews_used, followups_used)
  values (p_user_id, v_period_start, v_period_end, 0, 0)
  on conflict (user_id, period_start) do nothing;

  select reviews_used, followups_used
    into v_reviews_used, v_followups_used
    from public.ai_allowances
    where user_id = p_user_id and period_start = v_period_start
    for update;

  if p_kind = 'review' then
    if v_reviews_used >= v_review_limit then
      return jsonb_build_object('allowed', false, 'cached', false, 'reason', 'limit', 'plan', v_plan_slug);
    end if;
    update public.ai_allowances
      set reviews_used = reviews_used + 1
      where user_id = p_user_id and period_start = v_period_start;
    return jsonb_build_object('allowed', true, 'cached', false, 'plan', v_plan_slug, 'remaining', v_review_limit - v_reviews_used - 1);
  else
    if v_followups_used >= v_followup_limit then
      return jsonb_build_object('allowed', false, 'cached', false, 'reason', 'limit', 'plan', v_plan_slug);
    end if;
    update public.ai_allowances
      set followups_used = followups_used + 1
      where user_id = p_user_id and period_start = v_period_start;
    return jsonb_build_object('allowed', true, 'cached', false, 'plan', v_plan_slug, 'remaining', v_followup_limit - v_followups_used - 1);
  end if;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default — revoke
-- that and grant only to service_role, since this function is
-- SECURITY DEFINER and takes a caller-supplied p_user_id.
revoke all on function public.consume_ai_allowance(uuid, text, text) from public;
revoke all on function public.consume_ai_allowance(uuid, text, text) from anon;
revoke all on function public.consume_ai_allowance(uuid, text, text) from authenticated;
grant execute on function public.consume_ai_allowance(uuid, text, text) to service_role;
