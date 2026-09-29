-- Phase 12 (addendum v1.1 §5): read-only Telegram notifications. Additive only.
CREATE TABLE notifications_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  type      TEXT NOT NULL,          -- session_start | session_end | signal | alert | briefing | command | reply
  summary   TEXT NOT NULL,          -- first line / short content
  status    TEXT NOT NULL,          -- sent | failed | dropped (rate limit) | ignored (unauthorized command)
  detail    TEXT
);
CREATE INDEX notifications_ts ON notifications_log(ts);

-- Watcher cursors (last update id, last signal seen, sessions announced, ...), so a restart does
-- not resend anything.
CREATE TABLE telegram_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
