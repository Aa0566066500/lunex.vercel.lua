CREATE TABLE IF NOT EXISTS scripts (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT UNIQUE NOT NULL,
    owner_uid TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS scripts_owner_uid_idx
ON scripts(owner_uid);

CREATE TABLE IF NOT EXISTS access_events (
    id BIGSERIAL PRIMARY KEY,
    script_id BIGINT REFERENCES scripts(id) ON DELETE CASCADE,
    actor_uid TEXT,
    event_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS access_events_script_idx
ON access_events(script_id);