CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  encrypted_value text,
  public_value jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'manual',
  external_id text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  url text,
  budget_text text,
  status text NOT NULL DEFAULT 'new',
  score integer,
  confidence integer,
  recommended_price integer,
  recommended_days integer,
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  client jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status, updated_at DESC);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS analysis_fingerprint text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS analysis_state text NOT NULL DEFAULT 'idle';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS analysis_started_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS analysis_completed_at timestamptz;
CREATE INDEX IF NOT EXISTS leads_analysis_state_idx ON leads(analysis_state, analysis_started_at);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_id text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author text,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel, external_id)
);

CREATE INDEX IF NOT EXISTS messages_lead_idx ON messages(lead_id, created_at);

CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind text NOT NULL,
  channel text NOT NULL,
  target_external_id text,
  content text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  version integer NOT NULL DEFAULT 1,
  source_last_message_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel, target_external_id, content_hash)
);

CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  markdown text NOT NULL DEFAULT '',
  file_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, kind, version)
);

CREATE TABLE IF NOT EXISTS activities (
  id bigserial PRIMARY KEY,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activities_lead_idx ON activities(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connector_state (
  connector text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  healthy boolean NOT NULL DEFAULT false,
  status_text text,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO connector_state(connector, enabled, healthy, status_text)
VALUES
  ('openai', false, false, 'Не настроен'),
  ('codex', false, false, 'Не настроен'),
  ('fl', false, false, 'Не настроен'),
  ('telegram', false, false, 'Не настроен')
ON CONFLICT (connector) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','failed')),
  result jsonb,
  error text,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_tasks_status_idx ON ai_tasks(status, created_at);

CREATE TABLE IF NOT EXISTS scan_runs (
  id bigserial PRIMARY KEY,
  connector text NOT NULL,
  found_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  analyzed_count integer NOT NULL DEFAULT 0,
  skipped_known_count integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_runs_connector_created_idx ON scan_runs(connector, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
