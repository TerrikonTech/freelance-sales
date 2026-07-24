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

-- One sale can move between FL.ru, Telegram Business and future channels.
-- The lead remains the canonical deal; channel identities only point to it.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_stage text NOT NULL DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_summary text NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_readiness integer NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS build_readiness integer NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action text;

CREATE TABLE IF NOT EXISTS lead_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel, external_id),
  UNIQUE(lead_id, channel, external_id)
);

CREATE INDEX IF NOT EXISTS lead_channels_lead_idx
  ON lead_channels(lead_id, last_seen_at DESC);

INSERT INTO lead_channels(lead_id,channel,external_id)
SELECT id,source,external_id FROM leads
WHERE external_id IS NOT NULL AND external_id<>''
ON CONFLICT(channel,external_id) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_lead_source_channel()
RETURNS trigger AS $$
BEGIN
  IF NEW.external_id IS NOT NULL AND NEW.external_id <> '' THEN
    INSERT INTO lead_channels(lead_id,channel,external_id)
    VALUES(NEW.id,NEW.source,NEW.external_id)
    ON CONFLICT(channel,external_id) DO UPDATE SET
      lead_id=EXCLUDED.lead_id,last_seen_at=now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_sync_source_channel ON leads;
CREATE TRIGGER leads_sync_source_channel
AFTER INSERT OR UPDATE OF source,external_id ON leads
FOR EACH ROW EXECUTE FUNCTION sync_lead_source_channel();

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

-- Durable, explainable memory.  Raw messages remain the source of truth;
-- these rows are the current structured understanding extracted from them.
CREATE TABLE IF NOT EXISTS sales_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  category text NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  value jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','confirmed','assumed','rejected','not_applicable'
  )),
  required boolean NOT NULL DEFAULT true,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, category, slug)
);

CREATE INDEX IF NOT EXISTS sales_requirements_lead_idx
  ON sales_requirements(lead_id, status, category);

CREATE TABLE IF NOT EXISTS agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  channel text NOT NULL,
  stage_before text NOT NULL,
  stage_after text NOT NULL,
  intent text NOT NULL,
  reply text NOT NULL,
  summary text NOT NULL DEFAULT '',
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_turns_lead_idx
  ON agent_turns(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  from_channel text NOT NULL,
  to_channel text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','used','expired','cancelled'
  )),
  target_external_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_handoffs_lookup_idx
  ON conversation_handoffs(token, status, expires_at);

CREATE TABLE IF NOT EXISTS codex_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','needs_answers','ready','approved','started','completed','cancelled'
  )),
  payload jsonb NOT NULL,
  source_last_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, version)
);

CREATE INDEX IF NOT EXISTS codex_handoffs_lead_idx
  ON codex_handoffs(lead_id, version DESC);

CREATE TABLE IF NOT EXISTS owner_agent_sessions (
  owner_external_id text PRIMARY KEY,
  active_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  pending_draft_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='owner_agent_sessions_pending_draft_fk'
  ) THEN
    ALTER TABLE owner_agent_sessions
      ADD CONSTRAINT owner_agent_sessions_pending_draft_fk
      FOREIGN KEY(pending_draft_id) REFERENCES drafts(id) ON DELETE SET NULL;
  END IF;
END;
$$;

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

-- Smart autonomy stays opt-in.  Decisions are stored separately from drafts so
-- an owner can audit why a message was sent, held, or ignored.
CREATE TABLE IF NOT EXISTS autonomy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  draft_id uuid REFERENCES drafts(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  policy_mode text NOT NULL CHECK (policy_mode IN ('manual','smart')),
  decision text NOT NULL CHECK (decision IN ('auto_send','ask_owner','skip')),
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS autonomy_decisions_draft_idx
  ON autonomy_decisions(draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS autonomy_decisions_source_message_idx
  ON autonomy_decisions(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS autonomy_decisions_lead_created_idx
  ON autonomy_decisions(lead_id, created_at DESC);

-- A client pause is distinct from the global switch in settings.  Both are
-- durable and are re-checked immediately before any external write.
CREATE TABLE IF NOT EXISTS autonomy_client_state (
  lead_id uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The delivery ledger is the idempotency boundary.  A send_unknown row is
-- terminal: the system never retries an operation whose remote outcome cannot
-- be proven.
CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel text NOT NULL,
  target_external_id text,
  content_hash text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'reserved','sending','sent','failed_before_send','send_unknown','blocked_paused'
  )),
  external_id text,
  error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_deliveries_draft_idx
  ON outbound_deliveries(draft_id, created_at DESC);

-- Owner prompts are delivered by the host broker through the already running
-- Hermes Telegram bot.  A claimed notification is never automatically
-- reclaimed: duplicating an approval prompt is worse than leaving it visible
-- in the FL.ru menu for manual review.
CREATE TABLE IF NOT EXISTS owner_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL UNIQUE REFERENCES autonomy_decisions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','claimed','sent','failed','actioned'
  )),
  external_id text,
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS owner_notifications_status_created_idx
  ON owner_notifications(status, created_at);
