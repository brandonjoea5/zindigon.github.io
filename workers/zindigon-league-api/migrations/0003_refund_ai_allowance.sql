-- Zindigon League — refund_ai_allowance(p_user_id, p_kind)
--
-- Companion to consume_ai_allowance() in 0002. That function has to
-- increment the counter *before* the OpenAI call (so two near-simultaneous
-- requests can't both slip through and both pay for generation), which
-- means a request that fails after the increment — e.g. the OpenAI API
-- error that motivated this migration (2026-09-24: /ai/review calls were
-- failing with "Unsupported parameter: 'max_tokens'...", and the caller
-- was charged a review for a request that produced nothing) — leaves the
-- user's allowance charged for a review/follow-up they never received.
--
-- This is a best-effort compensating decrement, not a symmetrical inverse
-- of consume_ai_allowance: it doesn't need the row lock or the cache
-- check, because it's only ever called by the Worker right after a
-- *known-fresh* consumption (gate.cached === false) failed downstream, in
-- the same request. greatest(..., 0) keeps it from ever going negative if
-- it's ever called twice for the same consumption by mistake, or the
-- period rolled over between the consume and the refund.
create or replace function public.refund_ai_allowance(
  p_user_id uuid,
  p_kind text  -- 'review' | 'followup'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_start timestamptz := date_trunc('month', now());
begin
  if p_kind not in ('review', 'followup') then
    raise exception 'invalid p_kind: %', p_kind;
  end if;

  if p_kind = 'review' then
    update public.ai_allowances
      set reviews_used = greatest(reviews_used - 1, 0)
      where user_id = p_user_id and period_start = v_period_start;
  else
    update public.ai_allowances
      set followups_used = greatest(followups_used - 1, 0)
      where user_id = p_user_id and period_start = v_period_start;
  end if;
end;
$$;

revoke all on function public.refund_ai_allowance(uuid, text) from public;
revoke all on function public.refund_ai_allowance(uuid, text) from anon;
revoke all on function public.refund_ai_allowance(uuid, text) from authenticated;
grant execute on function public.refund_ai_allowance(uuid, text) to service_role;

