create or replace function "inception-1-test".create_conversation_fast(
  p_session_id uuid,
  p_secret_hash text,
  p_character_slug text,
  p_title text,
  p_conversation_id uuid,
  p_event_id uuid
)
returns table (
  result_status text,
  conversation_id uuid,
  conversation_browser_session_id uuid,
  conversation_character_id uuid,
  conversation_title text,
  conversation_status "inception-1-test".conversation_status,
  conversation_last_message_preview text,
  conversation_last_message_at timestamptz,
  conversation_created_at timestamptz,
  conversation_updated_at timestamptz
)
language plpgsql
as $$
declare
  v_session_id uuid;
  v_character "inception-1-test".characters%rowtype;
  v_conversation "inception-1-test".conversations%rowtype;
  v_sequence_no integer;
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
  into v_character
  from "inception-1-test".characters
  where slug = p_character_slug
    and is_active = true
    and deleted_at is null
  limit 1;

  if not found then
    result_status := 'character_not_found';
    return next;
    return;
  end if;

  insert into "inception-1-test".conversations (
    id, browser_session_id, character_id, title, last_message_preview, last_message_at
  )
  values (
    p_conversation_id, p_session_id, v_character.id, p_title, null, null
  )
  returning * into v_conversation;

  select "inception-1-test".next_timeline_sequence(p_conversation_id)
  into v_sequence_no;

  insert into "inception-1-test".timeline_events (
    id, conversation_id, browser_session_id, character_id, sequence_no, event_type, payload
  )
  values (
    p_event_id, p_conversation_id, p_session_id, v_character.id, v_sequence_no,
    'conversation_created', jsonb_build_object('kind', 'conversation_created', 'title', p_title)
  );

  result_status := 'created';
  conversation_id := v_conversation.id;
  conversation_browser_session_id := v_conversation.browser_session_id;
  conversation_character_id := v_conversation.character_id;
  conversation_title := v_conversation.title;
  conversation_status := v_conversation.status;
  conversation_last_message_preview := v_conversation.last_message_preview;
  conversation_last_message_at := v_conversation.last_message_at;
  conversation_created_at := v_conversation.created_at;
  conversation_updated_at := v_conversation.updated_at;
  return next;
end;
$$;
