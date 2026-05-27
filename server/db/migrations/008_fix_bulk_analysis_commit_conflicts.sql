create or replace function "inception-1-test".commit_analysis_job_result(
  p_job_id uuid,
  p_agent_run_id uuid,
  p_mood_detection_id uuid,
  p_metric_snapshot_id uuid,
  p_metric_delta_id uuid,
  p_character_job_id uuid,
  p_agent_run jsonb,
  p_compiled_input jsonb,
  p_output jsonb,
  p_latency_ms integer,
  p_metric_snapshot jsonb,
  p_metric_delta jsonb,
  p_previous_metric_event_id uuid,
  p_stage_ms jsonb
)
returns table (
  committed boolean,
  event_id uuid,
  character_job_id uuid
)
language plpgsql
as $$
declare
  v_job "inception-1-test".processing_jobs%rowtype;
  v_event "inception-1-test".timeline_events%rowtype;
begin
  select *
  into v_job
  from "inception-1-test".processing_jobs
  where id = p_job_id
  for update;

  if not found then
    committed := false;
    return next;
    return;
  end if;

  select *
  into v_event
  from "inception-1-test".timeline_events
  where id = v_job.event_id
  for update;

  perform id
  from "inception-1-test".conversations
  where id = v_job.conversation_id
  for update;

  if v_job.status <> 'running'
    or v_event.processing_status <> 'active'
    or exists (
      select 1
      from "inception-1-test".timeline_events newer
      where newer.conversation_id = v_event.conversation_id
        and newer.sequence_no > v_event.sequence_no
        and newer.event_type in ('user_message_received', 'silence_timeout')
    )
  then
    update "inception-1-test".processing_jobs
    set status = 'superseded',
        finished_at = now(),
        updated_at = now(),
        locked_at = null,
        locked_by = null
    where id = p_job_id
      and status = 'running';
    committed := false;
    event_id := v_job.event_id;
    character_job_id := null;
    return next;
    return;
  end if;

  update "inception-1-test".processing_jobs
  set status = 'succeeded',
      finished_at = now(),
      updated_at = now(),
      last_error = null,
      locked_at = null,
      locked_by = null,
      payload = payload || jsonb_build_object('stage_ms', coalesce(p_stage_ms, '{}'::jsonb))
  where id = p_job_id;

  insert into "inception-1-test".agent_runs (
    id, agent_key, event_id, job_id, conversation_id, character_id, model, status,
    prompt_revision_ids, primary_prompt_revision_id, prompt_registry_version,
    prompt_content_hash, compiled_prompt_hash, input_summary, output_validated,
    latency_ms, finished_at
  )
  values (
    p_agent_run_id,
    p_agent_run->>'agent_key',
    v_event.id,
    p_job_id,
    v_event.conversation_id,
    v_event.character_id,
    p_agent_run->>'model',
    'succeeded',
    coalesce(p_agent_run->'prompt_revision_ids', '[]'::jsonb),
    nullif(p_agent_run->>'primary_prompt_revision_id', '')::uuid,
    nullif(p_agent_run->>'prompt_registry_version', '')::bigint,
    p_agent_run->>'prompt_content_hash',
    p_agent_run->>'compiled_prompt_hash',
    coalesce(p_agent_run->'input_summary', '{}'::jsonb),
    p_output,
    p_latency_ms,
    now()
  );

  insert into "inception-1-test".mood_detections (
    id, event_id, conversation_id, browser_session_id, character_id, result, agent_run_id
  )
  values (
    p_mood_detection_id, v_event.id, v_event.conversation_id, v_event.browser_session_id,
    v_event.character_id, p_output, p_agent_run_id
  )
  on conflict on constraint mood_detections_event_id_key do update set
    result = excluded.result,
    agent_run_id = excluded.agent_run_id;

  insert into "inception-1-test".metric_snapshots (
    id, event_id, conversation_id, browser_session_id, character_id, snapshot, mood_source
  )
  values (
    p_metric_snapshot_id, v_event.id, v_event.conversation_id, v_event.browser_session_id,
    v_event.character_id, p_metric_snapshot, 'current_mood_detection'
  )
  on conflict on constraint metric_snapshots_event_id_key do update set
    snapshot = excluded.snapshot,
    mood_source = excluded.mood_source;

  insert into "inception-1-test".metric_deltas (
    id, event_id, previous_event_id, conversation_id, delta
  )
  values (
    p_metric_delta_id, v_event.id, p_previous_metric_event_id, v_event.conversation_id, p_metric_delta
  )
  on conflict on constraint metric_deltas_event_id_key do update set
    previous_event_id = excluded.previous_event_id,
    delta = excluded.delta;

  insert into "inception-1-test".processing_jobs (
    id, job_type, event_id, conversation_id, idempotency_key, worker_pool, queue_priority
  )
  values (
    p_character_job_id, 'character_agent', v_event.id, v_event.conversation_id,
    'character_agent:' || v_event.id::text, 'response', 0
  )
  on conflict (idempotency_key) do nothing;

  perform pg_notify('personapulse_jobs_response', v_event.id::text);

  committed := true;
  event_id := v_event.id;
  character_job_id := p_character_job_id;
  return next;
end;
$$;
