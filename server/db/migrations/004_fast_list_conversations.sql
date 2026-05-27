create or replace function "inception-1-test".list_conversations_fast(
  p_session_id uuid,
  p_secret_hash text,
  p_character_slug text
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
  v_character_id uuid;
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

  select id
  into v_character_id
  from "inception-1-test".characters
  where slug = p_character_slug
    and is_active = true
    and deleted_at is null
  limit 1;

  if v_character_id is null then
    result_status := 'character_not_found';
    return next;
    return;
  end if;

  return query
    select
      'ok'::text,
      c.id,
      c.browser_session_id,
      c.character_id,
      c.title,
      c.status,
      c.last_message_preview,
      c.last_message_at,
      c.created_at,
      c.updated_at
    from "inception-1-test".conversations c
    where c.browser_session_id = p_session_id
      and c.character_id = v_character_id
      and c.status = 'active'
      and c.deleted_at is null
    order by coalesce(c.last_message_at, c.created_at) desc;

  if not found then
    result_status := 'empty';
    return next;
  end if;
end;
$$;
