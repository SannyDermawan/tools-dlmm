-- Phase 13 (addendum v1.1 §6.2): conditional LLM layer. The LLM never decides entries, exits or
-- sizes; it only produces qualitative features and explanations. Additive only.
CREATE TABLE llm_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  role           TEXT NOT NULL,          -- token_social | explainer
  provider       TEXT NOT NULL,          -- anthropic | openai_compatible | local
  model          TEXT NOT NULL,          -- requested model
  served_model   TEXT,                   -- model that answered (differs after a refusal fallback)
  prompt_version TEXT NOT NULL,
  cache_key      TEXT NOT NULL,          -- sha256(role, subject, prompt version, model, input)
  subject        TEXT,                   -- token mint / session id
  input_summary  TEXT NOT NULL,          -- short, sanitized
  output         TEXT,                   -- validated JSON (null when invalid)
  raw_output     TEXT,                   -- first 2000 chars of the raw answer when invalid
  valid          INTEGER NOT NULL,
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  session_id     TEXT
);
CREATE INDEX llm_calls_ts ON llm_calls(ts);
CREATE INDEX llm_calls_cache ON llm_calls(cache_key, ts);

-- Features derived from validated LLM output (read look-ahead safe: ts <= t).
CREATE TABLE llm_features (
  token   TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  name    TEXT NOT NULL,                 -- llm_social_score
  value   REAL,
  call_id INTEGER,
  PRIMARY KEY (token, ts, name)
);
