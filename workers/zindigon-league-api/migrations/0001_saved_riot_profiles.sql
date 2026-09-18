-- Zindigon League — Phase 1 Supabase migration
--
-- STAGED, NOT YET APPLIED. Supabase is unreachable from the current dev
-- network, so this file is ready to run in the Supabase SQL editor (or via
-- the CLI/migration tool) as soon as that access is restored. Nothing in
-- Phase 1's Cloudflare Worker or D1 cache depends on this table existing.
--
-- Follows the existing account pattern used by Builds/Elemental Rift:
-- `public.players` already holds the Zindigon-wide account row per
-- Supabase auth user (id = auth.uid()). This table just adds League-specific
-- saved-profile data on top of that same identity — no separate account
-- system, per the project's own rule.

create table if not exists public.saved_riot_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null,               -- e.g. 'na1', 'euw1'
  region text not null,                 -- derived routing cluster, e.g. 'americas'
  game_name text not null,
  tag_line text not null,
  puuid text not null,
  relationship text not null default 'other'
    check (relationship in ('me', 'friend', 'teammate', 'watch', 'comparison', 'other')),
  created_at timestamptz not null default now(),
  unique (user_id, platform, game_name, tag_line)
);

create index if not exists idx_saved_riot_profiles_user
  on public.saved_riot_profiles(user_id);

alter table public.saved_riot_profiles enable row level security;

-- Users can only ever see/manage their own saved profiles. No public read —
-- unlike Riot match data itself (which is public), *who a Zindigon user has
-- saved and how they've labeled them* is private account information.
create policy "saved_riot_profiles_select_own"
  on public.saved_riot_profiles for select
  using (auth.uid() = user_id);

create policy "saved_riot_profiles_insert_own"
  on public.saved_riot_profiles for insert
  with check (auth.uid() = user_id);

create policy "saved_riot_profiles_update_own"
  on public.saved_riot_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "saved_riot_profiles_delete_own"
  on public.saved_riot_profiles for delete
  using (auth.uid() = user_id);

-- Per-plan saved-profile limits (Free: 3, Plus: 10, Premier: 25) are
-- enforced in application code, not the database — they're configurable
-- values, not a fixed schema constraint. Phase 3 wires that check up
-- against `public.players`' plan/subscription fields once those exist.
