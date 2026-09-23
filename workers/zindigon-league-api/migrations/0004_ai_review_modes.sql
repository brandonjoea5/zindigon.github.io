-- Zindigon League — tailored AI review modes (branching intake flow)
--
-- The AI Insights intake now asks a couple of quick, free (no-OpenAI-call)
-- questions before generating anything: is this your match or someone
-- else's, and what kind of answer you want (help me improve / what I did
-- right and wrong / something specific). Each combination is a "mode",
-- and unlike the original single-review-per-match design, a user can now
-- legitimately want more than one tailored take on the same match (e.g.
-- "help me improve" today, "what did I do right" next week) — so the old
-- unique(user_id, match_id) constraint, which silently served back
-- whichever review was generated first regardless of what was actually
-- asked this time, needs to widen.
--
-- The two free-text modes (self_custom / other_custom) fold the literal
-- question into the uniqueness key too: repeating the exact same question
-- is still a free, idempotent re-fetch (matching the original design's
-- intent), but two different questions about the same match are two
-- different reviews, not a cache collision. Non-custom modes always store
-- question = '' (not null — Postgres unique constraints treat NULL as
-- always-distinct, which would have silently broken dedup for them).
alter table public.ai_reviews
  add column if not exists mode text not null default 'self_strengths_weaknesses',
  add column if not exists question text not null default '';

alter table public.ai_reviews
  drop constraint if exists ai_reviews_user_id_match_id_key;

alter table public.ai_reviews
  add constraint ai_reviews_user_match_mode_question_key
  unique (user_id, match_id, mode, question);

-- consume_ai_allowance() gains two optional, defaulted parameters so a
-- call with the original 3 args still works; the cache check now matches
-- on mode + question too, for the same reason as the constraint above.
-- create-or-replace with a wider signature creates a second overload
-- rather than replacing the original, so the old 3-arg version is
-- dropped explicitly afterward to avoid an ambiguous-call error.
create or replace function public.consume_ai_allowance(
  p_user_id uuid,
  p_kind text,     -- 'review' | 'followup'
  p_match_id text, -- required for 'review' (cache check); ignored for 'followup'
  p_mode text default 'self_strengths_weaknesses',
  p_question text default ''
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

  if p_kind = 'review' and p_match_id is not null then
    if exists (
      select 1 from public.ai_reviews
      where user_id = p_user_id and match_id = p_match_id
        and mode = coalesce(p_mode, 'self_strengths_weaknesses')
        and question = coalesce(p_question, '')
    ) then
      return jsonb_build_object('allowed', true, 'cached', true);
    end if;
  end if;

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
    v_review_limit := 0;
    v_followup_limit := 0;
  end if;

  v_period_start := date_trunc('month', now());
  v_period_end := v_period_start + interval '1 month';

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

revoke all on function public.consume_ai_allowance(uuid, text, text, text, text) from public;
revoke all on function public.consume_ai_allowance(uuid, text, text, text, text) from anon;
revoke all on function public.consume_ai_allowance(uuid, text, text, text, text) from authenticated;
grant execute on function public.consume_ai_allowance(uuid, text, text, text, text) to service_role;

drop function if exists public.consume_ai_allowance(uuid, text, text);
