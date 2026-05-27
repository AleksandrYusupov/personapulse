create schema if not exists "inception-1-test";

do $$
begin
  create type "inception-1-test".sender_type as enum ('user', 'character', 'system');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".conversation_status as enum ('active', 'archived', 'deleted');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".event_type as enum (
    'user_message_received',
    'silence_timeout',
    'conversation_created',
    'agent_message_committed',
    'timer_scheduled',
    'timer_cancelled'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".job_type as enum (
    'mood_detection',
    'metric_detection',
    'character_agent',
    'metrics_reconciliation'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".job_status as enum (
    'queued',
    'running',
    'succeeded',
    'failed',
    'dead',
    'superseded'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".timer_status as enum (
    'scheduled',
    'paused_inactive',
    'cancelled_by_user_message',
    'cancelled_by_agent',
    'fired',
    'expired_stale'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".hypothesis_status as enum (
    'pending',
    'supported',
    'refuted',
    'inconclusive',
    'superseded'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type "inception-1-test".agent_action_type as enum (
    'send_text',
    'send_emoji',
    'send_image',
    'send_text_image',
    'no_response'
  );
exception when duplicate_object then null;
end $$;

create table if not exists "inception-1-test".schema_migrations (
  name text primary key,
  content_hash text not null,
  applied_at timestamptz not null default now()
);

create table if not exists "inception-1-test".browser_sessions (
  id uuid primary key,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  user_agent_hash text,
  client_version text,
  metadata jsonb not null default '{}'::jsonb,
  revoked_at timestamptz
);

create table if not exists "inception-1-test".characters (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  codename text not null,
  role text not null,
  short_desc text not null,
  long_desc text not null,
  avatar_storage_path text,
  theme jsonb not null default '{}'::jsonb,
  status text not null default 'ONLINE',
  traits jsonb not null default '[]'::jsonb,
  specials jsonb not null default '[]'::jsonb,
  suggested_prompts jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists "inception-1-test".conversations (
  id uuid primary key,
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  title text not null,
  status "inception-1-test".conversation_status not null default 'active',
  last_message_preview text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists "inception-1-test".messages (
  id uuid primary key,
  conversation_id uuid not null references "inception-1-test".conversations(id),
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  sender_type "inception-1-test".sender_type not null,
  text text,
  display_emotion text,
  client_message_id text,
  source_event_id uuid,
  agent_run_id uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint messages_user_text_or_agent_content check (sender_type <> 'user' or coalesce(length(text), 0) > 0)
);

create table if not exists "inception-1-test".message_media (
  id uuid primary key,
  message_id uuid references "inception-1-test".messages(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  media_type text not null,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text not null,
  width integer,
  height integer,
  alt_text text,
  generation_prompt text,
  provider text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists "inception-1-test".active_dialog_presence (
  browser_session_id uuid primary key references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  visibility_state text not null,
  last_heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists "inception-1-test".timeline_events (
  id uuid primary key,
  conversation_id uuid not null references "inception-1-test".conversations(id),
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  sequence_no integer not null,
  event_type "inception-1-test".event_type not null,
  source_message_id uuid references "inception-1-test".messages(id),
  source_timer_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence_no)
);

create table if not exists "inception-1-test".processing_jobs (
  id uuid primary key,
  job_type "inception-1-test".job_type not null,
  status "inception-1-test".job_status not null default 'queued',
  event_id uuid not null references "inception-1-test".timeline_events(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists "inception-1-test".mood_detections (
  id uuid primary key,
  event_id uuid not null unique references "inception-1-test".timeline_events(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  result jsonb not null,
  agent_run_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists "inception-1-test".metric_snapshots (
  id uuid primary key,
  event_id uuid not null unique references "inception-1-test".timeline_events(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  snapshot jsonb not null,
  mood_source text not null,
  created_at timestamptz not null default now()
);

create table if not exists "inception-1-test".metric_deltas (
  id uuid primary key,
  event_id uuid not null unique references "inception-1-test".timeline_events(id),
  previous_event_id uuid references "inception-1-test".timeline_events(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  delta jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists "inception-1-test".agent_runs (
  id uuid primary key,
  agent_key text not null,
  event_id uuid references "inception-1-test".timeline_events(id),
  job_id uuid references "inception-1-test".processing_jobs(id),
  conversation_id uuid references "inception-1-test".conversations(id),
  character_id uuid references "inception-1-test".characters(id),
  model text not null,
  status text not null,
  prompt_revision_ids jsonb not null default '[]'::jsonb,
  primary_prompt_revision_id uuid,
  prompt_registry_version bigint,
  prompt_content_hash text,
  compiled_prompt_hash text,
  input_summary jsonb not null default '{}'::jsonb,
  output_validated jsonb,
  error text,
  latency_ms integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists "inception-1-test".hypotheses (
  id uuid primary key,
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  event_id uuid not null references "inception-1-test".timeline_events(id),
  agent_run_id uuid references "inception-1-test".agent_runs(id),
  status "inception-1-test".hypothesis_status not null default 'pending',
  hypothesis_text text not null,
  expected_reaction jsonb not null default '{}'::jsonb,
  success_criteria jsonb not null default '{}'::jsonb,
  selected_action "inception-1-test".agent_action_type not null,
  topic_label text,
  mood_label text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists "inception-1-test".hypothesis_evaluations (
  id uuid primary key,
  hypothesis_id uuid not null references "inception-1-test".hypotheses(id),
  event_id uuid not null references "inception-1-test".timeline_events(id),
  agent_run_id uuid references "inception-1-test".agent_runs(id),
  assessment "inception-1-test".hypothesis_status not null,
  evidence text not null,
  confidence numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists "inception-1-test".silence_timers (
  id uuid primary key,
  browser_session_id uuid not null references "inception-1-test".browser_sessions(id),
  character_id uuid not null references "inception-1-test".characters(id),
  conversation_id uuid not null references "inception-1-test".conversations(id),
  source_event_id uuid references "inception-1-test".timeline_events(id),
  generation integer not null default 1,
  status "inception-1-test".timer_status not null,
  pause_seconds integer not null,
  scheduled_at timestamptz not null default now(),
  deadline_at timestamptz,
  paused_at timestamptz,
  remaining_ms integer,
  fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists "inception-1-test".app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists "inception-1-test".agent_definitions (
  id uuid primary key,
  agent_key text not null unique,
  display_name text not null,
  default_model text not null,
  is_character_scoped boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists "inception-1-test".agent_prompt_bundles (
  id uuid primary key,
  agent_definition_id uuid not null references "inception-1-test".agent_definitions(id),
  character_id uuid references "inception-1-test".characters(id),
  bundle_key text not null,
  environment text not null,
  locale text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_definition_id, character_id, bundle_key, environment, locale)
);

create table if not exists "inception-1-test".agent_prompt_revisions (
  id uuid primary key,
  bundle_id uuid not null references "inception-1-test".agent_prompt_bundles(id),
  revision_no integer not null,
  status text not null,
  system_prompt text not null,
  developer_prompt text not null,
  context_builder_instructions text not null,
  output_contract_instructions text not null,
  tool_policy jsonb not null default '{}'::jsonb,
  model_config jsonb not null default '{}'::jsonb,
  response_schema jsonb,
  safety_policy jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text not null,
  created_by text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  archived_at timestamptz,
  change_note text,
  unique (bundle_id, revision_no),
  unique (bundle_id, content_hash)
);

create table if not exists "inception-1-test".agent_prompt_activation_log (
  id uuid primary key,
  bundle_id uuid not null references "inception-1-test".agent_prompt_bundles(id),
  previous_revision_id uuid references "inception-1-test".agent_prompt_revisions(id),
  new_revision_id uuid not null references "inception-1-test".agent_prompt_revisions(id),
  activated_by text,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists "inception-1-test".prompt_registry_versions (
  id integer primary key,
  version bigint not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into "inception-1-test".prompt_registry_versions (id, version, updated_by)
values (1, 1, 'migration')
on conflict (id) do nothing;

create unique index if not exists idx_messages_client_message_unique
  on "inception-1-test".messages (conversation_id, client_message_id)
  where client_message_id is not null;

create unique index if not exists idx_messages_agent_source_unique
  on "inception-1-test".messages (source_event_id, sender_type)
  where sender_type = 'character';

create unique index if not exists idx_agent_prompt_active_revision
  on "inception-1-test".agent_prompt_revisions (bundle_id)
  where status = 'active';

create index if not exists idx_browser_sessions_last_seen
  on "inception-1-test".browser_sessions (last_seen_at);
create index if not exists idx_characters_active_slug
  on "inception-1-test".characters (is_active, slug);
create index if not exists idx_conversations_session_character_status
  on "inception-1-test".conversations (browser_session_id, character_id, status, last_message_at desc);
create index if not exists idx_messages_conversation_created
  on "inception-1-test".messages (conversation_id, created_at desc);
create index if not exists idx_timeline_conversation_sequence
  on "inception-1-test".timeline_events (conversation_id, sequence_no desc);
create index if not exists idx_jobs_status_available
  on "inception-1-test".processing_jobs (status, available_at);
create index if not exists idx_timers_due
  on "inception-1-test".silence_timers (status, deadline_at)
  where status = 'scheduled';
create index if not exists idx_hypotheses_memory
  on "inception-1-test".hypotheses (browser_session_id, character_id, status, created_at desc);
create index if not exists idx_metric_snapshots_conversation_created
  on "inception-1-test".metric_snapshots (conversation_id, created_at desc);
create index if not exists idx_mood_detections_conversation_created
  on "inception-1-test".mood_detections (conversation_id, created_at desc);

create or replace function "inception-1-test".next_timeline_sequence(p_conversation_id uuid)
returns integer
language plpgsql
as $$
declare
  next_sequence integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_conversation_id::text));

  select coalesce(max(sequence_no), 0) + 1
  into next_sequence
  from "inception-1-test".timeline_events
  where conversation_id = p_conversation_id;

  return next_sequence;
end;
$$;

create or replace function "inception-1-test".claim_processing_job(p_worker_id text)
returns setof "inception-1-test".processing_jobs
language sql
as $$
  update "inception-1-test".processing_jobs
  set status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      attempt = attempt + 1,
      updated_at = now()
  where id = (
    select id
    from "inception-1-test".processing_jobs
    where status in ('queued', 'failed')
      and available_at <= now()
      and attempt < max_attempts
    order by available_at asc, created_at asc
    for update skip locked
    limit 1
  )
  returning *;
$$;

create or replace function "inception-1-test".claim_due_silence_timer(p_worker_id text)
returns setof "inception-1-test".silence_timers
language sql
as $$
  update "inception-1-test".silence_timers
  set status = 'fired',
      fired_at = now(),
      updated_at = now(),
      metadata = metadata || jsonb_build_object('locked_by', p_worker_id)
  where id = (
    select id
    from "inception-1-test".silence_timers
    where status = 'scheduled'
      and deadline_at <= now()
    order by deadline_at asc
    for update skip locked
    limit 1
  )
  returning *;
$$;
