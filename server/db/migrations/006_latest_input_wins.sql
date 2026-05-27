alter table "inception-1-test".timeline_events
  add column if not exists processing_status text not null default 'active',
  add column if not exists superseded_by_event_id uuid references "inception-1-test".timeline_events(id),
  add column if not exists superseded_at timestamptz;

do $$
begin
  alter table "inception-1-test".timeline_events
    add constraint timeline_events_processing_status_check
    check (processing_status in ('active', 'superseded'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_timeline_events_actionable_latest
  on "inception-1-test".timeline_events (conversation_id, sequence_no desc)
  where event_type in ('user_message_received', 'silence_timeout');

create index if not exists idx_timeline_events_processing_status
  on "inception-1-test".timeline_events (processing_status, conversation_id, sequence_no);

create or replace function "inception-1-test".supersede_conversation_work(
  p_conversation_id uuid,
  p_new_event_id uuid,
  p_new_sequence_no integer
)
returns void
language plpgsql
as $$
begin
  perform id
  from "inception-1-test".conversations
  where id = p_conversation_id
  for update;

  with stale_events as (
    select e.id
    from "inception-1-test".timeline_events e
    where e.conversation_id = p_conversation_id
      and e.id <> p_new_event_id
      and e.sequence_no < p_new_sequence_no
      and e.event_type in ('user_message_received', 'silence_timeout')
      and e.processing_status = 'active'
      and (
        exists (
          select 1
          from "inception-1-test".processing_jobs j
          where j.event_id = e.id
            and j.status in ('queued', 'running', 'failed')
        )
        or not exists (
          select 1
          from "inception-1-test".processing_jobs cj
          where cj.event_id = e.id
            and cj.job_type = 'character_agent'
            and cj.status in ('succeeded', 'dead')
        )
      )
    for update
  ),
  updated_events as (
    update "inception-1-test".timeline_events e
    set processing_status = 'superseded',
        superseded_by_event_id = p_new_event_id,
        superseded_at = coalesce(e.superseded_at, now())
    where e.id in (select id from stale_events)
    returning e.id
  )
  update "inception-1-test".processing_jobs j
  set status = 'superseded',
      finished_at = now(),
      updated_at = now(),
      locked_at = null,
      locked_by = null,
      last_error = coalesce(j.last_error, 'superseded_by_event_id=' || p_new_event_id::text)
  where j.event_id in (select id from updated_events)
    and j.status in ('queued', 'running', 'failed');
end;
$$;

create or replace function "inception-1-test".claim_processing_job(
  p_worker_id text,
  p_worker_pool text
)
returns setof "inception-1-test".processing_jobs
language sql
as $$
  update "inception-1-test".processing_jobs
  set status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      started_at = coalesce(started_at, now()),
      attempt = attempt + 1,
      updated_at = now()
  where id = (
    select j.id
    from "inception-1-test".processing_jobs j
    join "inception-1-test".timeline_events e on e.id = j.event_id
    where j.status in ('queued', 'failed')
      and j.worker_pool = p_worker_pool
      and j.available_at <= now()
      and j.attempt < j.max_attempts
      and e.processing_status = 'active'
      and not exists (
        select 1
        from "inception-1-test".timeline_events newer
        where newer.conversation_id = e.conversation_id
          and newer.sequence_no > e.sequence_no
          and newer.event_type in ('user_message_received', 'silence_timeout')
      )
      and (
        j.job_type <> 'metric_detection'
        or exists (
          select 1
          from "inception-1-test".mood_detections md
          where md.event_id = j.event_id
        )
      )
    order by j.queue_priority asc, j.available_at asc, j.created_at asc
    for update of j skip locked
    limit 1
  )
  returning *;
$$;

create or replace function "inception-1-test".post_user_message_fast(
  p_session_id uuid,
  p_secret_hash text,
  p_conversation_id uuid,
  p_client_message_id text,
  p_text text,
  p_message_id uuid,
  p_event_id uuid,
  p_mood_job_id uuid,
  p_metric_job_id uuid
)
returns table (
  result_status text,
  result_event_id uuid,
  message_id uuid,
  message_conversation_id uuid,
  message_browser_session_id uuid,
  message_character_id uuid,
  message_sender_type "inception-1-test".sender_type,
  message_text text,
  message_display_emotion text,
  message_client_message_id text,
  message_source_event_id uuid,
  message_agent_run_id uuid,
  message_created_at timestamptz,
  message_deleted_at timestamptz,
  message_metadata jsonb
)
language plpgsql
as $$
declare
  v_session_id uuid;
  v_conversation "inception-1-test".conversations%rowtype;
  v_message "inception-1-test".messages%rowtype;
  v_sequence_no integer;
  v_cancelled_timer_ids uuid[];
begin
  update "inception-1-test".browser_sessions
  set last_seen_at = now()
  where id = p_session_id
    and secret_hash = p_secret_hash
    and revoked_at is null
  returning id into v_session_id;

  if v_session_id is null then
    result_status := 'invalid_session';
    return next;
    return;
  end if;

  select *
  into v_conversation
  from "inception-1-test".conversations
  where id = p_conversation_id
    and browser_session_id = p_session_id
    and status = 'active'
    and deleted_at is null
  for update;

  if not found then
    result_status := 'conversation_not_found';
    return next;
    return;
  end if;

  select *
  into v_message
  from "inception-1-test".messages
  where conversation_id = p_conversation_id
    and client_message_id = p_client_message_id
  limit 1;

  if found then
    result_status := 'duplicate';
    result_event_id := null;
    message_id := v_message.id;
    message_conversation_id := v_message.conversation_id;
    message_browser_session_id := v_message.browser_session_id;
    message_character_id := v_message.character_id;
    message_sender_type := v_message.sender_type;
    message_text := v_message.text;
    message_display_emotion := v_message.display_emotion;
    message_client_message_id := v_message.client_message_id;
    message_source_event_id := v_message.source_event_id;
    message_agent_run_id := v_message.agent_run_id;
    message_created_at := v_message.created_at;
    message_deleted_at := v_message.deleted_at;
    message_metadata := v_message.metadata;
    return next;
    return;
  end if;

  with cancelled as (
    update "inception-1-test".silence_timers
    set status = 'cancelled_by_user_message',
        updated_at = now()
    where conversation_id = p_conversation_id
      and status in ('scheduled', 'paused_inactive')
    returning id
  )
  select coalesce(array_agg(id), array[]::uuid[])
  into v_cancelled_timer_ids
  from cancelled;

  insert into "inception-1-test".messages (
    id, conversation_id, browser_session_id, character_id, sender_type, text, client_message_id
  )
  values (
    p_message_id, p_conversation_id, p_session_id, v_conversation.character_id, 'user', p_text, p_client_message_id
  )
  returning * into v_message;

  select "inception-1-test".next_timeline_sequence(p_conversation_id)
  into v_sequence_no;

  insert into "inception-1-test".timeline_events (
    id, conversation_id, browser_session_id, character_id, sequence_no, event_type,
    source_message_id, payload
  )
  values (
    p_event_id, p_conversation_id, p_session_id, v_conversation.character_id, v_sequence_no,
    'user_message_received', p_message_id,
    jsonb_build_object(
      'kind', 'user_message_received',
      'message_id', p_message_id,
      'client_message_id', p_client_message_id,
      'text_length', length(p_text),
      'has_media', false,
      'server_received_at', now(),
      'cancelled_timer_ids', coalesce(v_cancelled_timer_ids, array[]::uuid[])
    )
  );

  perform "inception-1-test".supersede_conversation_work(p_conversation_id, p_event_id, v_sequence_no);

  update "inception-1-test".conversations
  set last_message_preview = left(p_text, 160),
      last_message_at = now(),
      updated_at = now()
  where id = p_conversation_id;

  insert into "inception-1-test".processing_jobs (
    id, job_type, event_id, conversation_id, idempotency_key, worker_pool, queue_priority
  )
  values
    (p_mood_job_id, 'mood_detection', p_event_id, p_conversation_id, 'mood_detection:' || p_event_id::text, 'analysis', 10),
    (p_metric_job_id, 'metric_detection', p_event_id, p_conversation_id, 'metric_detection:' || p_event_id::text, 'analysis', 20)
  on conflict (idempotency_key) do nothing;

  result_status := 'accepted';
  result_event_id := p_event_id;
  message_id := v_message.id;
  message_conversation_id := v_message.conversation_id;
  message_browser_session_id := v_message.browser_session_id;
  message_character_id := v_message.character_id;
  message_sender_type := v_message.sender_type;
  message_text := v_message.text;
  message_display_emotion := v_message.display_emotion;
  message_client_message_id := v_message.client_message_id;
  message_source_event_id := v_message.source_event_id;
  message_agent_run_id := v_message.agent_run_id;
  message_created_at := v_message.created_at;
  message_deleted_at := v_message.deleted_at;
  message_metadata := v_message.metadata;
  return next;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select distinct on (conversation_id) conversation_id, id, sequence_no
    from "inception-1-test".timeline_events
    where event_type in ('user_message_received', 'silence_timeout')
    order by conversation_id, sequence_no desc
  loop
    perform "inception-1-test".supersede_conversation_work(r.conversation_id, r.id, r.sequence_no);
  end loop;
end $$;
