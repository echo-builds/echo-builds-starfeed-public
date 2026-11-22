CREATE TABLE IF NOT EXISTS projects (
  full_name_key text PRIMARY KEY,
  full_name text NOT NULL,
  github_id bigint,
  category text,
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_github_id_idx
  ON projects (github_id) WHERE github_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS projects_category_idx ON projects (category);

CREATE TABLE IF NOT EXISTS feed_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  project_full_name_key text NOT NULL REFERENCES projects(full_name_key) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('new','release','classic')),
  occurred_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  selection_reason text NOT NULL,
  release_payload jsonb,
  rank_score numeric NOT NULL DEFAULT 0,
  timeline_position bigint,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','removed'))
);

ALTER TABLE feed_events ADD COLUMN IF NOT EXISTS timeline_position bigint;
UPDATE feed_events SET timeline_position=1000000000 + id WHERE timeline_position IS NULL;
ALTER TABLE feed_events ALTER COLUMN timeline_position SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feed_events_timeline_position_idx
  ON feed_events (timeline_position);

CREATE INDEX IF NOT EXISTS feed_events_published_idx
  ON feed_events (id DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS feed_events_published_timeline_idx
  ON feed_events (timeline_position DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS feed_events_project_idx
  ON feed_events (project_full_name_key, id DESC);

CREATE TABLE IF NOT EXISTS repo_snapshots (
  project_full_name_key text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  stars integer NOT NULL DEFAULT 0,
  forks integer NOT NULL DEFAULT 0,
  pushed_at timestamptz,
  PRIMARY KEY (project_full_name_key, observed_at)
);

CREATE INDEX IF NOT EXISTS repo_snapshots_recent_idx
  ON repo_snapshots (project_full_name_key, observed_at DESC);

CREATE TABLE IF NOT EXISTS user_progress (
  github_login text PRIMARY KEY,
  github_user_id bigint UNIQUE,
  latest_seen_event_id bigint,
  resume_event_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  candidates integer NOT NULL DEFAULT 0,
  published integer NOT NULL DEFAULT 0,
  detail text
);
