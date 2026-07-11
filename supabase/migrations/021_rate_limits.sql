-- ============================================================
-- API rate limiting
--
-- Claude-backed routes (chat, classify-document, email-draft) had no
-- request cap at all — any authenticated caller could trigger unlimited
-- paid AI calls. This adds a small fixed-window counter table plus an
-- atomic check-and-increment function so the limit holds across
-- concurrent requests and multiple serverless instances (a JS-side
-- in-memory counter would not, since each instance has its own memory).
-- ============================================================

CREATE TABLE api_rate_limits (
  key           text        PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  count         int         NOT NULL DEFAULT 0
);

-- Returns true when the call is allowed (and records it), false when the
-- caller is over the limit for the current window. Single UPSERT — atomic
-- under concurrent calls for the same key.
CREATE OR REPLACE FUNCTION check_rate_limit(p_key text, p_window_seconds int, p_limit int)
RETURNS boolean AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO api_rate_limits (key, window_start, count)
  VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN api_rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN 1
        ELSE api_rate_limits.count + 1
      END,
    window_start = CASE
      WHEN api_rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN now()
        ELSE api_rate_limits.window_start
      END
  RETURNING count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$ LANGUAGE plpgsql;

-- Service-role only — the check_rate_limit RPC is called exclusively from
-- server-side route handlers, never from the browser.
ALTER TABLE api_rate_limits ENABLE ROW LEVEL SECURITY;
