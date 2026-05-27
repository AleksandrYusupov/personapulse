alter table "inception-1-test".processing_jobs
  add column if not exists worker_pool text,
  add column if not exists queue_priority smallint,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz;

update "inception-1-test".processing_jobs
set worker_pool = case
    when job_type in ('mood_detection', 'metric_detection') then 'analysis'
    when job_type = 'character_agent' then 'response'
    else 'analysis'
  end
where worker_pool is null;

update "inception-1-test".processing_jobs
set queue_priority = case
    when job_type = 'character_agent' then 0
    when job_type = 'mood_detection' then 10
    when job_type = 'metric_detection' then 20
    else 50
  end
where queue_priority is null;

update "inception-1-test".processing_jobs
set started_at = locked_at
where started_at is null
  and locked_at is not null;

update "inception-1-test".processing_jobs
set finished_at = updated_at
where finished_at is null
  and status in ('succeeded', 'dead', 'superseded');

alter table "inception-1-test".processing_jobs
  alter column worker_pool set not null,
  alter column worker_pool set default 'analysis',
  alter column queue_priority set not null,
  alter column queue_priority set default 50;

drop index if exists "inception-1-test".idx_jobs_status_available;

create index if not exists idx_jobs_pool_status_priority_available
  on "inception-1-test".processing_jobs (worker_pool, status, queue_priority, available_at, created_at);

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
    where j.status in ('queued', 'failed')
      and j.worker_pool = p_worker_pool
      and j.available_at <= now()
      and j.attempt < j.max_attempts
      and (
        j.job_type <> 'metric_detection'
        or exists (
          select 1
          from "inception-1-test".mood_detections md
          where md.event_id = j.event_id
        )
      )
    order by j.queue_priority asc, j.available_at asc, j.created_at asc
    for update skip locked
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
