create or replace function "inception-1-test".commit_character_job_result(
  p_job_id uuid,
  p_agent_run_id uuid,
  p_message_id uuid,
  p_media_id uuid,
  p_hypothesis_id uuid,
  p_hypothesis_evaluation_id uuid,
  p_timer_id uuid,
  p_agent_run jsonb,
  p_compiled_input jsonb,
  p_output jsonb,
  p_latency_ms integer,
  p_image_media jsonb,
  p_pause_seconds integer,
  p_stage_ms jsonb
)
returns table (
  committed boolean,
  event_id uuid,
  message_id uuid
)
language plpgsql
as $$
declare
  v_job "inception-1-test".processing_jobs%rowtype;
  v_event "inception-1-test".timeline_events%rowtype;
  v_action jsonb;
  v_selected jsonb;
  v_assessment jsonb;
  v_assessment_status text;
  v_assessed_hypothesis_id uuid;
  v_user_visible_text text;
  v_sends_visible_content boolean;
  v_is_active boolean;
  v_hypothesis_text text;
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
    message_id := null;
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

  v_assessment := p_output->'previous_hypothesis_assessment';
  if v_assessment ? 'hypothesis_id'
     and coalesce(v_assessment->>'assessment', 'not_applicable') <> 'not_applicable'
  then
    v_assessment_status := case
      when v_assessment->>'assessment' in ('supported', 'refuted', 'inconclusive')
        then v_assessment->>'assessment'
      else 'inconclusive'
    end;

    update "inception-1-test".hypotheses h
    set status = v_assessment_status::"inception-1-test".hypothesis_status,
        resolved_at = now()
    where h.id = (v_assessment->>'hypothesis_id')::uuid
      and h.status = 'pending'
      and exists (
        select 1
        from "inception-1-test".timeline_events he
        where he.id = h.event_id
          and he.processing_status = 'active'
      )
    returning h.id into v_assessed_hypothesis_id;

    if v_assessed_hypothesis_id is not null then
      insert into "inception-1-test".hypothesis_evaluations (
        id, hypothesis_id, event_id, agent_run_id, assessment, evidence, confidence
      )
      values (
        p_hypothesis_evaluation_id, v_assessed_hypothesis_id, v_event.id, p_agent_run_id,
        v_assessment_status::"inception-1-test".hypothesis_status,
        left(coalesce(v_assessment->>'evidence', ''), 2000),
        coalesce(nullif(v_assessment->>'confidence', '')::numeric, 0)
      );
    end if;
  end if;

  v_selected := p_output->'selected_hypothesis';
  v_hypothesis_text := trim(coalesce(v_selected->>'hypothesis_text', v_selected->>'hypothesis', ''));
  if v_hypothesis_text <> '' then
    insert into "inception-1-test".hypotheses (
      id, browser_session_id, character_id, conversation_id, event_id, agent_run_id,
      status, hypothesis_text, expected_reaction, success_criteria, selected_action,
      topic_label, mood_label
    )
    values (
      p_hypothesis_id, v_event.browser_session_id, v_event.character_id, v_event.conversation_id,
      v_event.id, p_agent_run_id, 'pending', v_hypothesis_text,
      coalesce(v_selected->'expected_user_reaction', '{}'::jsonb),
      coalesce(v_selected->'success_criteria', '{}'::jsonb),
      (p_output->'action'->>'type')::"inception-1-test".agent_action_type,
      p_compiled_input->'mood'->'current_topic'->>'label',
      p_compiled_input->'mood'->'current_user_mood'->>'label'
    );
  end if;

  v_action := p_output->'action';
  v_user_visible_text := nullif(trim(coalesce(v_action->>'user_visible_text', '')), '');
  v_sends_visible_content := coalesce(v_action->>'type', 'no_response') <> 'no_response'
    and (v_user_visible_text is not null or p_image_media is not null);

  if v_sends_visible_content and p_message_id is not null then
    insert into "inception-1-test".messages (
      id, conversation_id, browser_session_id, character_id, sender_type, text,
      display_emotion, source_event_id, agent_run_id
    )
    values (
      p_message_id, v_event.conversation_id, v_event.browser_session_id, v_event.character_id,
      'character', v_user_visible_text, v_action->>'character_emotion', v_event.id, p_agent_run_id
    );

    if p_image_media is not null and p_media_id is not null then
      insert into "inception-1-test".message_media (
        id, message_id, conversation_id, media_type, storage_bucket, storage_path,
        mime_type, width, height, alt_text, generation_prompt, provider
      )
      values (
        p_media_id, p_message_id, v_event.conversation_id, 'image',
        p_image_media->>'bucket', p_image_media->>'path',
        coalesce(p_image_media->>'mimeType', p_image_media->>'mime_type', 'image/png'),
        null, null,
        coalesce(p_image_media->>'altText', p_image_media->>'alt_text', 'Generated PersonaPulse image'),
        p_image_media->>'prompt',
        'gemini'
      );
    end if;

    update "inception-1-test".conversations
    set last_message_preview = coalesce(v_user_visible_text, '[image]'),
        last_message_at = now(),
        updated_at = now()
    where id = v_event.conversation_id;
  end if;

  update "inception-1-test".silence_timers
  set status = 'cancelled_by_agent',
      updated_at = now()
  where conversation_id = v_event.conversation_id
    and status in ('scheduled', 'paused_inactive');

  select exists(
    select 1
    from "inception-1-test".active_dialog_presence
    where browser_session_id = v_event.browser_session_id
      and character_id = v_event.character_id
      and conversation_id = v_event.conversation_id
      and expires_at > now()
  ) into v_is_active;

  insert into "inception-1-test".silence_timers (
    id, browser_session_id, character_id, conversation_id, source_event_id,
    generation, status, pause_seconds, deadline_at, remaining_ms, metadata
  )
  values (
    p_timer_id, v_event.browser_session_id, v_event.character_id, v_event.conversation_id,
    v_event.id, 1,
    case
      when v_is_active then 'scheduled'::"inception-1-test".timer_status
      else 'paused_inactive'::"inception-1-test".timer_status
    end,
    p_pause_seconds,
    case when v_is_active then now() + (p_pause_seconds || ' seconds')::interval else null end,
    case when v_is_active then null::integer else (p_pause_seconds * 1000)::integer end,
    jsonb_build_object('reason', p_output->'silence_timer'->>'reason')
  );

  committed := true;
  event_id := v_event.id;
  message_id := case when v_sends_visible_content then p_message_id else null end;
  return next;
end;
$$;
