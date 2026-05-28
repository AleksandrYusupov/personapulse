export interface BrowserSession {
  id: string;
}

export interface CharacterRow {
  id: string;
  slug: string;
  name: string;
  codename: string;
  role: string;
  short_desc: string;
  long_desc: string;
  avatar_storage_path: string | null;
  theme: Record<string, unknown>;
  status: string;
  traits: unknown[];
  specials: unknown[];
  suggested_prompts: string[];
}

export interface ConversationRow {
  id: string;
  browser_session_id: string;
  character_id: string;
  title: string;
  status: string;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  browser_session_id: string;
  character_id: string;
  sender_type: 'user' | 'character' | 'system';
  text: string | null;
  display_emotion: string | null;
  client_message_id: string | null;
  source_event_id: string | null;
  agent_run_id: string | null;
  created_at: string;
  deleted_at?: string | null;
  media?: MediaRow[];
  metadata?: Record<string, unknown>;
}

export interface MediaRow {
  id: string;
  message_id: string | null;
  media_type: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  generation_prompt?: string | null;
  provider?: string | null;
  created_at?: string;
}

export interface TimelineEventRow {
  id: string;
  conversation_id: string;
  browser_session_id: string;
  character_id: string;
  sequence_no: number;
  event_type: 'user_message_received' | 'silence_timeout' | 'conversation_created' | 'agent_message_committed' | 'timer_scheduled' | 'timer_cancelled';
  source_message_id: string | null;
  source_timer_id: string | null;
  payload: Record<string, unknown>;
  processing_status: 'active' | 'superseded';
  superseded_by_event_id: string | null;
  superseded_at: string | null;
  created_at: string;
}

export interface ProcessingJobRow {
  id: string;
  job_type: 'mood_detection' | 'metric_detection' | 'character_agent' | 'metrics_reconciliation';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'superseded';
  event_id: string;
  conversation_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  worker_pool: 'analysis' | 'response';
  queue_priority: number;
  available_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ConversationMetricSnapshotRow {
  event_id: string;
  snapshot: Record<string, any>;
  delta: Record<string, any> | null;
  created_at: string;
}
