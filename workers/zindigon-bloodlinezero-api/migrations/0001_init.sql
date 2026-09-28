-- Bloodline Zero — initial schema.
-- Applied by hand through the D1 dashboard console (this sandbox cannot
-- reach any Cloudflare-hosted host directly — confirmed 2026-09-28 — so
-- there is no wrangler d1 execute in this workflow yet). This file exists
-- so the schema is reproducible and reviewable in the repo, not because it
-- was actually run via `wrangler d1 migrations apply`.

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  teaser TEXT NOT NULL,
  is_free INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 199,
  reading_time_min INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE episode_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL,
  UNIQUE(user_id, episode_id)
);

CREATE TABLE reading_progress (
  user_id TEXT NOT NULL,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  percent REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, episode_id)
);

CREATE TABLE stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_episode_purchases_user ON episode_purchases(user_id);
CREATE INDEX idx_reading_progress_user ON reading_progress(user_id);
