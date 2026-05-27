import type { Sql } from 'postgres';
import { AppConfig } from '../config';
import { CharacterRow, ConversationRow, MessageRow, ProcessingJobRow, TimelineEventRow } from '../domain';
import { hashSessionSecret, hashText, newId, newSessionSecret } from '../util/crypto';
import { HttpError } from '../util/http';

interface FastUserMessageRow {
  result_status: 'accepted' | 'duplicate' | 'invalid_session' | 'conversation_not_found';
  result_event_id: string | null;
  message_id: string | null;
  message_conversation_id: string | null;
  message_browser_session_id: string | null;
  message_character_id: string | null;
  message_sender_type: MessageRow['sender_type'] | null;
  message_text: string | null;
  message_display_emotion: string | null;
  message_client_message_id: string | null;
  message_source_event_id: string | null;
  message_agent_run_id: string | null;
  message_created_at: string | null;
  message_deleted_at: string | null;
  message_metadata: Record<string, unknown> | null;
}

interface FastConversationRow {
  result_status: 'created' | 'invalid_session' | 'character_not_found';
  conversation_id: string | null;
  conversation_browser_session_id: string | null;
  conversation_character_id: string | null;
  conversation_title: string | null;
  conversation_status: ConversationRow['status'] | null;
  conversation_last_message_preview: string | null;
  conversation_last_message_at: string | null;
  conversation_created_at: string | null;
  conversation_updated_at: string | null;
}

interface FastConversationListRow extends Omit<FastConversationRow, 'result_status'> {
  result_status: 'ok' | 'empty' | 'invalid_session' | 'character_not_found';
}

interface EventFreshness {
  isCurrent: boolean;
  latestEventId: string | null;
  latestSequenceNo: number | null;
}

export interface AnalysisJobContext {
  is_current: boolean;
  job: ProcessingJobRow | null;
  event: TimelineEventRow | null;
  messages: MessageRow[];
  previous_mood: Record<string, any> | null;
  previous_metric_snapshot: Record<string, any> | null;
  previous_metric_event_id: string | null;
}

export interface CharacterJobContext {
  is_current: boolean;
  job: ProcessingJobRow | null;
  event: TimelineEventRow | null;
  messages: MessageRow[];
  mood: Record<string, any> | null;
  metric: Record<string, any> | null;
  delta: Record<string, any> | null;
  hypotheses: Record<string, any>[];
}

interface CommitResult {
  committed: boolean;
  event_id: string | null;
  character_job_id?: string | null;
  message_id?: string | null;
}

export class Repository {
  constructor(
    private readonly sql: Sql,
    private readonly config: AppConfig,
  ) {}

  async createBrowserSession(userAgent: string | undefined, clientVersion: string | undefined) {
    const id = newId();
    const secret = newSessionSecret();
    const secretHash = hashSessionSecret(secret, this.config.sessionSecretPepper);
    const userAgentHash = userAgent ? hashText(userAgent) : null;

    await this.sql`
      insert into "inception-1-test".browser_sessions (
        id, secret_hash, user_agent_hash, client_version
      )
      values (${id}, ${secretHash}, ${userAgentHash}, ${clientVersion ?? null})
    `;

    return { session_id: id, session_secret: secret, created_at: new Date().toISOString() };
  }

  async authenticate(sessionId: string | undefined, sessionSecret: string | undefined) {
    if (!sessionId || !sessionSecret) {
      throw new HttpError(401, 'Session headers are required');
    }

    const secretHash = hashSessionSecret(sessionSecret, this.config.sessionSecretPepper);
    const rows = await this.sql<{ id: string }[]>`
      update "inception-1-test".browser_sessions
      set last_seen_at = now()
      where id = ${sessionId}
        and secret_hash = ${secretHash}
        and revoked_at is null
      returning id
    `;

    const row = rows[0];
    if (!row) {
      throw new HttpError(401, 'Invalid browser session');
    }
    return { id: row.id };
  }

  async verifyBrowserSession(sessionId: string | undefined, sessionSecret: string | undefined): Promise<boolean> {
    if (!sessionId || !sessionSecret) return false;
    const secretHash = hashSessionSecret(sessionSecret, this.config.sessionSecretPepper);
    const rows = await this.sql<{ id: string }[]>`
      update "inception-1-test".browser_sessions
      set last_seen_at = now()
      where id = ${sessionId}
        and secret_hash = ${secretHash}
        and revoked_at is null
      returning id
    `;
    return Boolean(rows[0]);
  }

  async listCharacters(): Promise<CharacterRow[]> {
    return this.sql<CharacterRow[]>`
      select *
      from "inception-1-test".characters
      where is_active = true
        and deleted_at is null
      order by slug asc
    `;
  }

  async requireCharacterBySlug(slug: string): Promise<CharacterRow> {
    const rows = await this.sql<CharacterRow[]>`
      select *
      from "inception-1-test".characters
      where slug = ${slug}
        and is_active = true
        and deleted_at is null
      limit 1
    `;
    if (!rows[0]) {
      throw new HttpError(404, 'Character not found');
    }
    return rows[0];
  }

  async listConversations(sessionId: string | undefined, sessionSecret: string | undefined, characterSlug: string): Promise<ConversationRow[]> {
    if (!sessionId || !sessionSecret) {
      throw new HttpError(401, 'Session headers are required');
    }

    const secretHash = hashSessionSecret(sessionSecret, this.config.sessionSecretPepper);
    const rows = await this.sql<FastConversationListRow[]>`
      select *
      from "inception-1-test".list_conversations_fast(${sessionId}, ${secretHash}, ${characterSlug})
    `;

    const firstStatus = rows[0]?.result_status;
    if (firstStatus === 'invalid_session') {
      throw new HttpError(401, 'Invalid browser session');
    }
    if (firstStatus === 'character_not_found') {
      throw new HttpError(404, 'Character not found');
    }
    if (firstStatus === 'empty' || rows.length === 0) {
      return [];
    }

    return rows.map((row) => {
      if (!row.conversation_id || !row.conversation_browser_session_id || !row.conversation_character_id || !row.conversation_title || !row.conversation_status || !row.conversation_created_at || !row.conversation_updated_at) {
        throw new Error(`list_conversations_fast returned incomplete conversation for status ${row.result_status}`);
      }
      return {
        id: row.conversation_id,
        browser_session_id: row.conversation_browser_session_id,
        character_id: row.conversation_character_id,
        title: row.conversation_title,
        status: row.conversation_status,
        last_message_preview: row.conversation_last_message_preview,
        last_message_at: row.conversation_last_message_at,
        created_at: row.conversation_created_at,
        updated_at: row.conversation_updated_at,
      };
    });
  }

  async createConversation(
    sessionId: string | undefined,
    sessionSecret: string | undefined,
    characterSlug: string,
    title: string,
  ): Promise<ConversationRow> {
    if (!sessionId || !sessionSecret) {
      throw new HttpError(401, 'Session headers are required');
    }

    const secretHash = hashSessionSecret(sessionSecret, this.config.sessionSecretPepper);
    const [row] = await this.sql<FastConversationRow[]>`
      select *
      from "inception-1-test".create_conversation_fast(
        ${sessionId},
        ${secretHash},
        ${characterSlug},
        ${title},
        ${newId()},
        ${newId()}
      )
    `;

    if (!row) {
      throw new Error('create_conversation_fast returned no result');
    }
    if (row.result_status === 'invalid_session') {
      throw new HttpError(401, 'Invalid browser session');
    }
    if (row.result_status === 'character_not_found') {
      throw new HttpError(404, 'Character not found');
    }
    if (!row.conversation_id || !row.conversation_browser_session_id || !row.conversation_character_id || !row.conversation_title || !row.conversation_status || !row.conversation_created_at || !row.conversation_updated_at) {
      throw new Error(`create_conversation_fast returned incomplete conversation for status ${row.result_status}`);
    }

    return {
      id: row.conversation_id,
      browser_session_id: row.conversation_browser_session_id,
      character_id: row.conversation_character_id,
      title: row.conversation_title,
      status: row.conversation_status,
      last_message_preview: row.conversation_last_message_preview,
      last_message_at: row.conversation_last_message_at,
      created_at: row.conversation_created_at,
      updated_at: row.conversation_updated_at,
    };
  }

  async deleteConversation(sessionId: string, conversationId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const conversations = await tx<{ id: string }[]>`
        update "inception-1-test".conversations
        set status = 'deleted',
            deleted_at = now(),
            updated_at = now()
        where id = ${conversationId}
          and browser_session_id = ${sessionId}
          and status <> 'deleted'
        returning id
      `;
      if (!conversations[0]) {
        throw new HttpError(404, 'Conversation not found');
      }

      await tx`
        update "inception-1-test".silence_timers
        set status = 'cancelled_by_agent',
            updated_at = now()
        where conversation_id = ${conversationId}
          and status in ('scheduled', 'paused_inactive')
      `;

      await tx`
        delete from "inception-1-test".active_dialog_presence
        where browser_session_id = ${sessionId}
          and conversation_id = ${conversationId}
      `;
    });
  }

  async requireConversation(sessionId: string, conversationId: string): Promise<ConversationRow> {
    const rows = await this.sql<ConversationRow[]>`
      select *
      from "inception-1-test".conversations
      where id = ${conversationId}
        and browser_session_id = ${sessionId}
        and status = 'active'
        and deleted_at is null
      limit 1
    `;
    if (!rows[0]) {
      throw new HttpError(404, 'Conversation not found');
    }
    return rows[0];
  }

  async listMessages(sessionId: string, conversationId: string, limit: number): Promise<MessageRow[]> {
    await this.requireConversation(sessionId, conversationId);
    const messages = await this.sql<MessageRow[]>`
      select m.*
      from "inception-1-test".messages m
      where m.conversation_id = ${conversationId}
        and m.browser_session_id = ${sessionId}
        and m.deleted_at is null
        and not exists (
          select 1
          from "inception-1-test".timeline_events e
          where e.id = m.source_event_id
            and e.processing_status = 'superseded'
        )
      order by created_at asc
      limit ${limit}
    `;

    if (!messages.length) return messages;

    const mediaRows = await this.sql`
      select *
      from "inception-1-test".message_media
      where message_id in ${this.sql(messages.map((message) => message.id))}
      order by created_at asc
    `;
    const mediaByMessage = new Map<string, any[]>();
    for (const media of mediaRows as any[]) {
      if (!media.message_id) continue;
      const bucket = mediaByMessage.get(media.message_id) ?? [];
      bucket.push(media);
      mediaByMessage.set(media.message_id, bucket);
    }

    return messages.map((message) => ({ ...message, media: mediaByMessage.get(message.id) ?? [] }));
  }

  async postUserMessage(
    sessionId: string | undefined,
    sessionSecret: string | undefined,
    conversationId: string,
    clientMessageId: string,
    text: string,
  ) {
    if (!sessionId || !sessionSecret) {
      throw new HttpError(401, 'Session headers are required');
    }

    const secretHash = hashSessionSecret(sessionSecret, this.config.sessionSecretPepper);
    const [row] = await this.sql<FastUserMessageRow[]>`
      select *
      from "inception-1-test".post_user_message_fast(
        ${sessionId},
        ${secretHash},
        ${conversationId},
        ${clientMessageId},
        ${text},
        ${newId()},
        ${newId()},
        ${newId()},
        ${newId()}
      )
    `;

    if (!row) {
      throw new Error('post_user_message_fast returned no result');
    }
    if (row.result_status === 'invalid_session') {
      throw new HttpError(401, 'Invalid browser session');
    }
    if (row.result_status === 'conversation_not_found') {
      throw new HttpError(404, 'Conversation not found');
    }
    if (!row.message_id || !row.message_conversation_id || !row.message_browser_session_id || !row.message_character_id || !row.message_sender_type || !row.message_created_at) {
      throw new Error(`post_user_message_fast returned incomplete message for status ${row.result_status}`);
    }

    const message: MessageRow = {
      id: row.message_id,
      conversation_id: row.message_conversation_id,
      browser_session_id: row.message_browser_session_id,
      character_id: row.message_character_id,
      sender_type: row.message_sender_type,
      text: row.message_text,
      display_emotion: row.message_display_emotion,
      client_message_id: row.message_client_message_id,
      source_event_id: row.message_source_event_id,
      agent_run_id: row.message_agent_run_id,
      created_at: row.message_created_at,
      deleted_at: row.message_deleted_at,
      metadata: row.message_metadata ?? {},
      media: [],
    };

    return {
      message,
      event_id: row.result_event_id,
      status: row.result_status as 'accepted' | 'duplicate',
    };
  }

  async setActiveDialog(sessionId: string, characterSlug: string, conversationId: string, visibilityState: string): Promise<void> {
    const character = await this.requireCharacterBySlug(characterSlug);
    await this.requireConversation(sessionId, conversationId);
    const ttl = `${this.config.activeDialogTtlSeconds} seconds`;

    await this.sql.begin(async (tx) => {
      await tx`
        insert into "inception-1-test".active_dialog_presence (
          browser_session_id, character_id, conversation_id, visibility_state, last_heartbeat_at, expires_at, updated_at
        )
        values (
          ${sessionId}, ${character.id}, ${conversationId}, ${visibilityState}, now(), now() + ${ttl}::interval, now()
        )
        on conflict (browser_session_id) do update set
          character_id = excluded.character_id,
          conversation_id = excluded.conversation_id,
          visibility_state = excluded.visibility_state,
          last_heartbeat_at = now(),
          expires_at = now() + ${ttl}::interval,
          updated_at = now()
      `;

      await tx`
        update "inception-1-test".silence_timers
        set status = 'paused_inactive',
            remaining_ms = greatest(0, floor(extract(epoch from (deadline_at - now())) * 1000))::integer,
            paused_at = now(),
            deadline_at = null,
            updated_at = now()
        where browser_session_id = ${sessionId}
          and status = 'scheduled'
          and conversation_id <> ${conversationId}
      `;

      await tx`
        update "inception-1-test".silence_timers
        set status = 'scheduled',
            deadline_at = now() + (coalesce(remaining_ms, pause_seconds * 1000) || ' milliseconds')::interval,
            remaining_ms = null,
            paused_at = null,
            updated_at = now()
        where browser_session_id = ${sessionId}
          and conversation_id = ${conversationId}
          and status = 'paused_inactive'
      `;
    });
  }

  async heartbeatActiveDialog(sessionId: string): Promise<void> {
    const ttl = `${this.config.activeDialogTtlSeconds} seconds`;
    const rows = await this.sql<{ browser_session_id: string }[]>`
      update "inception-1-test".active_dialog_presence
      set last_heartbeat_at = now(),
          expires_at = now() + ${ttl}::interval,
          updated_at = now()
      where browser_session_id = ${sessionId}
      returning browser_session_id
    `;
    if (!rows[0]) return;
  }

  async clearActiveDialog(sessionId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ conversation_id: string }[]>`
        delete from "inception-1-test".active_dialog_presence
        where browser_session_id = ${sessionId}
        returning conversation_id
      `;
      const active = rows[0];
      if (!active) return;

      await tx`
        update "inception-1-test".silence_timers
        set status = 'paused_inactive',
            remaining_ms = greatest(0, floor(extract(epoch from (deadline_at - now())) * 1000))::integer,
            paused_at = now(),
            deadline_at = null,
            updated_at = now()
        where browser_session_id = ${sessionId}
          and conversation_id = ${active.conversation_id}
          and status = 'scheduled'
      `;
    });
  }

  async enqueueEventJobs(tx: any, eventId: string, conversationId: string): Promise<void> {
    await tx`
      insert into "inception-1-test".processing_jobs (
        id, job_type, event_id, conversation_id, idempotency_key, worker_pool, queue_priority
      )
      values (
        ${newId()}, 'mood_detection', ${eventId}, ${conversationId}, ${`mood_detection:${eventId}`},
        'analysis', 10
      )
      on conflict (idempotency_key) do nothing
    `;
    await tx`select pg_notify('personapulse_jobs_analysis', ${eventId}::text)`;
  }

  async claimJob(workerId: string, workerPool: ProcessingJobRow['worker_pool']): Promise<ProcessingJobRow | null> {
    const rows = await this.sql<ProcessingJobRow[]>`
      select *
      from "inception-1-test".claim_processing_job(${workerId}, ${workerPool})
    `;
    return rows[0] ?? null;
  }

  async listenForJobNotifications(
    workerPool: ProcessingJobRow['worker_pool'],
    onNotify: () => void,
  ): Promise<() => Promise<void>> {
    const channel = `personapulse_jobs_${workerPool}`;
    const listener = await (this.sql as any).listen(channel, () => {
      onNotify();
    }, () => {
      onNotify();
    });
    return () => listener.unlisten();
  }

  async loadAnalysisJobContext(jobId: string): Promise<AnalysisJobContext | null> {
    const rows = await this.sql<AnalysisJobContext[]>`
      select *
      from "inception-1-test".load_analysis_job_context(${jobId})
    `;
    return rows[0] ?? null;
  }

  async commitAnalysisJobResult(input: {
    jobId: string;
    agentRunId: string;
    moodDetectionId: string;
    metricSnapshotId: string;
    metricDeltaId: string;
    characterJobId: string;
    agentRun: Record<string, unknown>;
    compiledInput: Record<string, unknown>;
    output: Record<string, unknown>;
    latencyMs: number;
    metricSnapshot: Record<string, unknown>;
    metricDelta: Record<string, unknown>;
    previousMetricEventId: string | null;
    stageMs: Record<string, number>;
  }): Promise<CommitResult> {
    const [row] = await this.sql<CommitResult[]>`
      select *
      from "inception-1-test".commit_analysis_job_result(
        ${input.jobId},
        ${input.agentRunId},
        ${input.moodDetectionId},
        ${input.metricSnapshotId},
        ${input.metricDeltaId},
        ${input.characterJobId},
        ${this.sql.json(input.agentRun as any)},
        ${this.sql.json(input.compiledInput as any)},
        ${this.sql.json(input.output as any)},
        ${input.latencyMs},
        ${this.sql.json(input.metricSnapshot as any)},
        ${this.sql.json(input.metricDelta as any)},
        ${input.previousMetricEventId},
        ${this.sql.json(input.stageMs as any)}
      )
    `;
    return row ?? { committed: false, event_id: null, character_job_id: null };
  }

  async loadCharacterJobContext(jobId: string): Promise<CharacterJobContext | null> {
    const rows = await this.sql<CharacterJobContext[]>`
      select *
      from "inception-1-test".load_character_job_context(${jobId})
    `;
    return rows[0] ?? null;
  }

  async commitCharacterJobResult(input: {
    jobId: string;
    agentRunId: string;
    messageId: string;
    mediaId: string | null;
    hypothesisId: string;
    hypothesisEvaluationId: string;
    timerId: string;
    agentRun: Record<string, unknown>;
    compiledInput: Record<string, unknown>;
    output: Record<string, unknown>;
    latencyMs: number;
    imageMedia: Record<string, unknown> | null;
    pauseSeconds: number;
    stageMs: Record<string, number>;
  }): Promise<CommitResult> {
    const [row] = await this.sql<CommitResult[]>`
      select *
      from "inception-1-test".commit_character_job_result(
        ${input.jobId},
        ${input.agentRunId},
        ${input.messageId},
        ${input.mediaId},
        ${input.hypothesisId},
        ${input.hypothesisEvaluationId},
        ${input.timerId},
        ${this.sql.json(input.agentRun as any)},
        ${this.sql.json(input.compiledInput as any)},
        ${this.sql.json(input.output as any)},
        ${input.latencyMs},
        ${input.imageMedia ? this.sql.json(input.imageMedia as any) : null},
        ${input.pauseSeconds},
        ${this.sql.json(input.stageMs as any)}
      )
    `;
    return row ?? { committed: false, event_id: null, message_id: null };
  }

  async getEventFreshness(
    jobId: string,
    event: TimelineEventRow,
    options: { tx?: any; lockConversation?: boolean } = {},
  ): Promise<EventFreshness> {
    const db = options.tx ?? this.sql;
    if (options.lockConversation) {
      await db`
        select id
        from "inception-1-test".conversations
        where id = ${event.conversation_id}
        for update
      `;
    }

    const [row] = await db<{ is_current: boolean; latest_event_id: string | null; latest_sequence_no: number | null }[]>`
      with latest_actionable as (
        select id, sequence_no
        from "inception-1-test".timeline_events
        where conversation_id = ${event.conversation_id}
          and event_type in ('user_message_received', 'silence_timeout')
        order by sequence_no desc
        limit 1
      )
      select
        exists(
          select 1
          from "inception-1-test".processing_jobs j
          join "inception-1-test".timeline_events e on e.id = j.event_id
          where j.id = ${jobId}
            and j.event_id = ${event.id}
            and j.status = 'running'
            and e.processing_status = 'active'
            and not exists (
              select 1
              from "inception-1-test".timeline_events newer
              where newer.conversation_id = e.conversation_id
                and newer.sequence_no > e.sequence_no
                and newer.event_type in ('user_message_received', 'silence_timeout')
            )
        ) as is_current,
        (select id::text from latest_actionable) as latest_event_id,
        (select sequence_no from latest_actionable) as latest_sequence_no
    `;

    return {
      isCurrent: row?.is_current === true,
      latestEventId: row?.latest_event_id ?? null,
      latestSequenceNo: row?.latest_sequence_no ?? null,
    };
  }

  async supersedeConversationWork(
    conversationId: string,
    latestEventId: string,
    latestSequenceNo: number,
    tx?: any,
  ): Promise<void> {
    const db = tx ?? this.sql;
    await db`
      select "inception-1-test".supersede_conversation_work(${conversationId}, ${latestEventId}, ${latestSequenceNo})
    `;
  }

  async markJobSucceeded(jobId: string, tx?: any): Promise<boolean> {
    const db = tx ?? this.sql;
    const rows = await db<{ id: string }[]>`
      update "inception-1-test".processing_jobs
      set status = 'succeeded',
          finished_at = now(),
          updated_at = now(),
          last_error = null,
          locked_at = null,
          locked_by = null
      where id = ${jobId}
        and status = 'running'
      returning id
    `;
    return Boolean(rows[0]);
  }

  async markJobSuperseded(jobId: string, tx?: any): Promise<boolean> {
    const db = tx ?? this.sql;
    const rows = await db<{ id: string }[]>`
      update "inception-1-test".processing_jobs
      set status = 'superseded',
          finished_at = now(),
          updated_at = now(),
          last_error = null,
          locked_at = null,
          locked_by = null
      where id = ${jobId}
        and status in ('queued', 'running', 'failed')
      returning id
    `;
    return Boolean(rows[0]);
  }

  async markJobFailed(job: ProcessingJobRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const shouldDeadLetter = job.attempt >= job.max_attempts;
    const delaySeconds = job.attempt <= 1 ? 2 : job.attempt === 2 ? 8 : 30;
    await this.sql`
      update "inception-1-test".processing_jobs
      set status = ${shouldDeadLetter ? 'dead' : 'failed'},
          last_error = ${message.slice(0, 4000)},
          available_at = now() + (${delaySeconds} || ' seconds')::interval,
          finished_at = case when ${shouldDeadLetter} then now() else finished_at end,
          updated_at = now(),
          locked_at = null,
          locked_by = null
      where id = ${job.id}
        and status = 'running'
    `;
  }

  async getEvent(eventId: string): Promise<TimelineEventRow> {
    const rows = await this.sql<TimelineEventRow[]>`
      select *
      from "inception-1-test".timeline_events
      where id = ${eventId}
    `;
    if (!rows[0]) throw new Error(`Event not found: ${eventId}`);
    return rows[0];
  }

  async enqueueCharacterJobIfReady(eventId: string, conversationId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        select id
        from "inception-1-test".conversations
        where id = ${conversationId}
        for update
      `;

      const [state] = await tx<{ has_mood: boolean; has_metrics: boolean; is_current: boolean }[]>`
        select
          exists(select 1 from "inception-1-test".mood_detections where event_id = ${eventId}) as has_mood,
          exists(select 1 from "inception-1-test".metric_snapshots where event_id = ${eventId}) as has_metrics,
          exists(
            select 1
            from "inception-1-test".timeline_events e
            where e.id = ${eventId}
              and e.conversation_id = ${conversationId}
              and e.processing_status = 'active'
              and not exists (
                select 1
                from "inception-1-test".timeline_events newer
                where newer.conversation_id = e.conversation_id
                  and newer.sequence_no > e.sequence_no
                  and newer.event_type in ('user_message_received', 'silence_timeout')
              )
          ) as is_current
      `;
      if (!state?.has_mood || !state?.has_metrics || !state.is_current) return;

      await tx`
        insert into "inception-1-test".processing_jobs (
          id, job_type, event_id, conversation_id, idempotency_key, worker_pool, queue_priority
        )
        values (
          ${newId()}, 'character_agent', ${eventId}, ${conversationId}, ${`character_agent:${eventId}`},
          'response', 0
        )
        on conflict (idempotency_key) do nothing
      `;
      await tx`select pg_notify('personapulse_jobs_response', ${eventId}::text)`;
    });
  }

  async adminCreateCharacter(input: {
    slug: string;
    name: string;
    codename: string;
    role: string;
    shortDesc: string;
    longDesc: string;
    avatarStoragePath: string | null;
    theme: unknown;
    status: string;
    traits: unknown;
    specials: unknown;
    suggestedPrompts: unknown;
  }) {
    const [row] = await this.sql<CharacterRow[]>`
      insert into "inception-1-test".characters (
        id, slug, name, codename, role, short_desc, long_desc, avatar_storage_path,
        theme, status, traits, specials, suggested_prompts, is_active
      )
      values (
        ${newId()}, ${input.slug}, ${input.name}, ${input.codename}, ${input.role},
        ${input.shortDesc}, ${input.longDesc}, ${input.avatarStoragePath}, ${this.sql.json(input.theme as any)},
        ${input.status}, ${this.sql.json(input.traits as any)}, ${this.sql.json(input.specials as any)},
        ${this.sql.json(input.suggestedPrompts as any)}, true
      )
      returning *
    `;
    return row;
  }

  async adminPatchCharacter(slug: string, patch: Record<string, unknown>) {
    const existing = await this.requireCharacterBySlug(slug);
    const [row] = await this.sql<CharacterRow[]>`
      update "inception-1-test".characters
      set name = ${String(patch.name ?? existing.name)},
          codename = ${String(patch.codename ?? existing.codename)},
          role = ${String(patch.role ?? existing.role)},
          short_desc = ${String(patch.shortDesc ?? existing.short_desc)},
          long_desc = ${String(patch.longDesc ?? existing.long_desc)},
          avatar_storage_path = ${patch.avatarStoragePath === undefined ? existing.avatar_storage_path : String(patch.avatarStoragePath ?? '')},
          theme = ${this.sql.json((patch.theme ?? existing.theme) as any)},
          status = ${String(patch.status ?? existing.status)},
          traits = ${this.sql.json((patch.traits ?? existing.traits) as any)},
          specials = ${this.sql.json((patch.specials ?? existing.specials) as any)},
          suggested_prompts = ${this.sql.json((patch.suggestedPrompts ?? existing.suggested_prompts) as any)},
          is_active = ${patch.isActive === undefined ? true : Boolean(patch.isActive)},
          updated_at = now()
      where id = ${existing.id}
      returning *
    `;
    return row;
  }

  async adminDeleteCharacter(slug: string): Promise<void> {
    await this.sql`
      update "inception-1-test".characters
      set is_active = false,
          deleted_at = now(),
          updated_at = now()
      where slug = ${slug}
    `;
  }

  async adminListAgents() {
    return this.sql`
      select *
      from "inception-1-test".agent_definitions
      order by agent_key asc
    `;
  }

  async adminListPromptBundles(agentKey: string | null, characterId: string | null) {
    return this.sql`
      select b.*, d.agent_key
      from "inception-1-test".agent_prompt_bundles b
      join "inception-1-test".agent_definitions d on d.id = b.agent_definition_id
      where (${agentKey}::text is null or d.agent_key = ${agentKey})
        and (${characterId}::uuid is null or b.character_id = ${characterId})
      order by d.agent_key asc, b.environment asc, b.locale asc, b.bundle_key asc
    `;
  }

  async adminCreatePromptBundle(input: {
    agentKey: string;
    characterId: string | null;
    bundleKey: string;
    environment: string;
    locale: string;
    description: string | null;
  }) {
    const [definition] = await this.sql<{ id: string }[]>`
      select id
      from "inception-1-test".agent_definitions
      where agent_key = ${input.agentKey}
      limit 1
    `;
    if (!definition) throw new HttpError(404, 'Agent definition not found');

    const [row] = await this.sql`
      insert into "inception-1-test".agent_prompt_bundles (
        id, agent_definition_id, character_id, bundle_key, environment, locale, description, is_active
      )
      values (
        ${newId()}, ${definition.id}, ${input.characterId}, ${input.bundleKey},
        ${input.environment}, ${input.locale}, ${input.description}, true
      )
      returning *
    `;
    return row;
  }

  async adminListPromptRevisions(bundleId: string) {
    return this.sql`
      select *
      from "inception-1-test".agent_prompt_revisions
      where bundle_id = ${bundleId}
      order by revision_no desc
    `;
  }

  async adminCreateDraftRevision(bundleId: string, input: Record<string, any>) {
    const [counter] = await this.sql<{ revision_no: number }[]>`
      select coalesce(max(revision_no), 0) + 1 as revision_no
      from "inception-1-test".agent_prompt_revisions
      where bundle_id = ${bundleId}
    `;
    const content = {
      system_prompt: String(input.system_prompt ?? ''),
      developer_prompt: String(input.developer_prompt ?? ''),
      context_builder_instructions: String(input.context_builder_instructions ?? ''),
      output_contract_instructions: String(input.output_contract_instructions ?? ''),
      tool_policy: input.tool_policy ?? {},
      model_config: input.model_config ?? {},
      response_schema: input.response_schema ?? null,
      safety_policy: input.safety_policy ?? {},
    };
    const [row] = await this.sql`
      insert into "inception-1-test".agent_prompt_revisions (
        id, bundle_id, revision_no, status, system_prompt, developer_prompt,
        context_builder_instructions, output_contract_instructions, tool_policy,
        model_config, response_schema, safety_policy, metadata, content_hash,
        created_by, change_note
      )
      values (
        ${newId()}, ${bundleId}, ${counter.revision_no}, 'draft', ${content.system_prompt},
        ${content.developer_prompt}, ${content.context_builder_instructions},
        ${content.output_contract_instructions}, ${this.sql.json(content.tool_policy)},
        ${this.sql.json(content.model_config)}, ${content.response_schema ? this.sql.json(content.response_schema) : null},
        ${this.sql.json(content.safety_policy)}, ${this.sql.json(input.metadata ?? {})},
        ${hashText(JSON.stringify(content))}, ${String(input.created_by ?? 'admin')},
        ${String(input.change_note ?? '')}
      )
      returning *
    `;
    return row;
  }

  async adminValidatePromptRevision(revisionId: string) {
    const [revision] = await this.sql<any[]>`
      select r.*, d.agent_key, b.character_id
      from "inception-1-test".agent_prompt_revisions r
      join "inception-1-test".agent_prompt_bundles b on b.id = r.bundle_id
      join "inception-1-test".agent_definitions d on d.id = b.agent_definition_id
      where r.id = ${revisionId}
      limit 1
    `;
    if (!revision) throw new HttpError(404, 'Prompt revision not found');
    const errors: string[] = [];
    if (!revision.system_prompt?.trim()) errors.push('system_prompt is required');
    if (['character_agent', 'mood_detector', 'safety_guard'].includes(revision.agent_key) && !revision.developer_prompt?.trim()) {
      errors.push('developer_prompt is required');
    }
    if (!revision.context_builder_instructions?.trim()) errors.push('context_builder_instructions is required');
    if (!revision.output_contract_instructions?.trim()) errors.push('output_contract_instructions is required');
    if (revision.agent_key === 'character_agent' && !revision.character_id) {
      errors.push('character_agent prompt must be character-scoped');
    }
    if (!revision.model_config?.model && revision.agent_key !== 'metric_detector') {
      errors.push('model_config.model is required');
    }
    if (revision.response_schema !== null && typeof revision.response_schema !== 'object') {
      errors.push('response_schema must be a JSON object when present');
    }
    if (revision.agent_key === 'character_agent') {
      const allowedTools = new Set(['generate_image']);
      for (const key of Object.keys(revision.tool_policy ?? {})) {
        if (!allowedTools.has(key)) errors.push(`tool_policy contains unsupported tool ${key}`);
      }
      if (!JSON.stringify(revision.safety_policy ?? {}).includes('silence')) {
        errors.push('character_agent safety_policy must include silence policy');
      }
      if (!/json/i.test(revision.output_contract_instructions)) {
        errors.push('character_agent output_contract_instructions must require JSON output');
      }
    }
    if (revision.system_prompt.length > 40000) errors.push('system_prompt exceeds 40000 characters');
    if (revision.developer_prompt.length > 40000) errors.push('developer_prompt exceeds 40000 characters');
    return { valid: errors.length === 0, errors, revision_id: revisionId };
  }

  async adminActivatePromptRevision(revisionId: string, actor: string, reason: string | null) {
    return this.sql.begin(async (tx) => {
      const [revision] = await tx<{ id: string; bundle_id: string }[]>`
        select id, bundle_id
        from "inception-1-test".agent_prompt_revisions
        where id = ${revisionId}
        for update
      `;
      if (!revision) throw new HttpError(404, 'Prompt revision not found');

      const [previous] = await tx<{ id: string }[]>`
        select id
        from "inception-1-test".agent_prompt_revisions
        where bundle_id = ${revision.bundle_id}
          and status = 'active'
        limit 1
      `;
      await tx`
        update "inception-1-test".agent_prompt_revisions
        set status = 'archived',
            archived_at = now()
        where bundle_id = ${revision.bundle_id}
          and status = 'active'
      `;
      const [activated] = await tx`
        update "inception-1-test".agent_prompt_revisions
        set status = 'active',
            activated_at = now(),
            archived_at = null
        where id = ${revisionId}
        returning *
      `;
      await tx`
        insert into "inception-1-test".agent_prompt_activation_log (
          id, bundle_id, previous_revision_id, new_revision_id, activated_by, reason
        )
        values (${newId()}, ${revision.bundle_id}, ${previous?.id ?? null}, ${revisionId}, ${actor}, ${reason})
      `;
      await tx`
        update "inception-1-test".prompt_registry_versions
        set version = version + 1,
            updated_at = now(),
            updated_by = ${actor}
        where id = 1
      `;
      return activated;
    });
  }

  async adminArchivePromptRevision(revisionId: string) {
    const [row] = await this.sql`
      update "inception-1-test".agent_prompt_revisions
      set status = 'archived',
          archived_at = now()
      where id = ${revisionId}
        and status <> 'active'
      returning *
    `;
    return row;
  }

  async adminRollbackPromptBundle(bundleId: string, actor: string) {
    const rows = await this.sql<{ id: string }[]>`
      select id
      from "inception-1-test".agent_prompt_revisions
      where bundle_id = ${bundleId}
        and status in ('archived', 'rollback')
      order by activated_at desc nulls last, revision_no desc
      limit 1
    `;
    if (!rows[0]) throw new HttpError(404, 'No rollback revision found');
    return this.adminActivatePromptRevision(rows[0].id, actor, 'rollback');
  }

  async adminListDeadJobs() {
    return this.sql`
      select *
      from "inception-1-test".processing_jobs
      where status = 'dead'
      order by updated_at desc
      limit 100
    `;
  }

  async adminRetryJob(jobId: string) {
    const [row] = await this.sql`
      update "inception-1-test".processing_jobs
      set status = 'queued',
          attempt = 0,
          available_at = now(),
          started_at = null,
          finished_at = null,
          locked_at = null,
          locked_by = null,
          last_error = null,
          updated_at = now()
      where id = ${jobId}
        and status in ('dead', 'failed', 'queued')
      returning *
    `;
    if (!row) throw new HttpError(404, 'Retryable job not found');
    return row;
  }

  async adminObservabilitySummary() {
    const [jobs] = await this.sql`
      select
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where status = 'dead')::int as dead,
        count(*) filter (where status = 'superseded')::int as superseded,
        count(*) filter (where status = 'succeeded')::int as succeeded
      from "inception-1-test".processing_jobs
    `;
    const [timers] = await this.sql`
      select
        count(*) filter (where status = 'scheduled')::int as scheduled,
        count(*) filter (where status = 'paused_inactive')::int as paused_inactive,
        count(*) filter (where status = 'fired')::int as fired,
        count(*) filter (where status = 'cancelled_by_user_message')::int as cancelled_by_user_message
      from "inception-1-test".silence_timers
    `;
    const [agents] = await this.sql`
      select
        count(*)::int as runs,
        count(*) filter (where status = 'succeeded')::int as succeeded,
        count(*) filter (where status <> 'succeeded')::int as non_succeeded,
        percentile_cont(0.95) within group (order by latency_ms)::int as latency_p95_ms
      from "inception-1-test".agent_runs
      where created_at > now() - interval '24 hours'
    `;
    const [registry] = await this.sql`
      select version::text, updated_at, updated_by
      from "inception-1-test".prompt_registry_versions
      where id = 1
    `;
    return { jobs, timers, agents_24h: agents, prompt_registry: registry };
  }

  async adminLatencyBreakdown() {
    const jobBreakdown = await this.sql`
      select
        job_type,
        worker_pool,
        count(*)::int as jobs,
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where status = 'dead')::int as dead,
        count(*) filter (where status = 'superseded')::int as superseded,
        percentile_cont(0.5) within group (
          order by extract(epoch from (coalesce(started_at, locked_at, updated_at) - created_at)) * 1000
        )::int as queue_p50_ms,
        percentile_cont(0.95) within group (
          order by extract(epoch from (coalesce(started_at, locked_at, updated_at) - created_at)) * 1000
        )::int as queue_p95_ms,
        percentile_cont(0.5) within group (
          order by extract(epoch from (coalesce(finished_at, updated_at) - coalesce(started_at, locked_at, created_at))) * 1000
        )::int as run_p50_ms,
        percentile_cont(0.95) within group (
          order by extract(epoch from (coalesce(finished_at, updated_at) - coalesce(started_at, locked_at, created_at))) * 1000
        )::int as run_p95_ms,
        percentile_cont(0.5) within group (
          order by extract(epoch from (coalesce(finished_at, updated_at) - created_at)) * 1000
        )::int as total_p50_ms,
        percentile_cont(0.95) within group (
          order by extract(epoch from (coalesce(finished_at, updated_at) - created_at)) * 1000
        )::int as total_p95_ms
      from "inception-1-test".processing_jobs
      where created_at > now() - interval '24 hours'
      group by job_type, worker_pool
      order by worker_pool asc, job_type asc
    `;

    const modelBreakdown = await this.sql`
      select
        agent_key,
        model,
        count(*)::int as runs,
        percentile_cont(0.5) within group (order by latency_ms)::int as model_p50_ms,
        percentile_cont(0.95) within group (order by latency_ms)::int as model_p95_ms,
        max(latency_ms)::int as model_max_ms
      from "inception-1-test".agent_runs
      where created_at > now() - interval '24 hours'
      group by agent_key, model
      order by agent_key asc, model asc
    `;

    const visibleResponseBreakdown = await this.sql`
      select
        e.event_type,
        e.conversation_id,
        count(*)::int as samples,
        percentile_cont(0.5) within group (order by extract(epoch from (m.created_at - e.created_at)) * 1000)::int as visible_p50_ms,
        percentile_cont(0.95) within group (order by extract(epoch from (m.created_at - e.created_at)) * 1000)::int as visible_p95_ms,
        max(extract(epoch from (m.created_at - e.created_at)) * 1000)::int as visible_max_ms,
        max(e.created_at) as latest_event_at
      from "inception-1-test".timeline_events e
      join "inception-1-test".messages m
        on m.source_event_id = e.id
       and m.sender_type = 'character'
      where e.created_at > now() - interval '24 hours'
        and e.event_type in ('user_message_received', 'silence_timeout')
        and e.processing_status = 'active'
      group by e.event_type, e.conversation_id
      order by latest_event_at desc
      limit 50
    `;

    const recentEvents = await this.sql`
      select
        e.id as event_id,
        e.event_type,
        e.processing_status,
        e.conversation_id,
        e.created_at,
        round(extract(epoch from (m.created_at - e.created_at)) * 1000)::int as visible_response_ms,
        (
          select jsonb_object_agg(
            j.job_type,
            jsonb_build_object(
              'status', j.status,
              'worker_pool', j.worker_pool,
              'queue_ms', round(extract(epoch from (coalesce(j.started_at, j.locked_at, j.updated_at) - j.created_at)) * 1000)::int,
              'run_ms', round(extract(epoch from (coalesce(j.finished_at, j.updated_at) - coalesce(j.started_at, j.locked_at, j.created_at))) * 1000)::int,
              'total_job_ms', round(extract(epoch from (coalesce(j.finished_at, j.updated_at) - j.created_at)) * 1000)::int,
              'stage_ms', j.payload->'stage_ms'
            )
          )
          from "inception-1-test".processing_jobs j
          where j.event_id = e.id
        ) as jobs,
        (
          select jsonb_object_agg(ar.agent_key, ar.latency_ms)
          from "inception-1-test".agent_runs ar
          where ar.event_id = e.id
        ) as model_ms
      from "inception-1-test".timeline_events e
      left join "inception-1-test".messages m
        on m.source_event_id = e.id
       and m.sender_type = 'character'
      where e.created_at > now() - interval '24 hours'
        and e.event_type in ('user_message_received', 'silence_timeout')
      order by e.created_at desc
      limit 25
    `;

    return {
      job_breakdown_24h: jobBreakdown,
      model_breakdown_24h: modelBreakdown,
      visible_response_by_conversation_24h: visibleResponseBreakdown,
      recent_events: recentEvents,
    };
  }

  async getConversationPipelineState(conversationId: string) {
    const [state] = await this.sql`
      select
        exists(
          select 1
          from "inception-1-test".processing_jobs j
          join "inception-1-test".timeline_events e on e.id = j.event_id
          where j.conversation_id = ${conversationId}
            and j.status in ('queued', 'running')
            and j.job_type in ('mood_detection', 'metric_detection', 'character_agent')
            and e.processing_status = 'active'
            and not exists (
              select 1
              from "inception-1-test".timeline_events newer
              where newer.conversation_id = e.conversation_id
                and newer.sequence_no > e.sequence_no
                and newer.event_type in ('user_message_received', 'silence_timeout')
            )
        ) as agent_busy,
        (
          select jsonb_build_object('pause_seconds', pause_seconds, 'deadline_at', deadline_at)
          from "inception-1-test".silence_timers
          where conversation_id = ${conversationId}
            and status = 'scheduled'
          order by created_at desc
          limit 1
        ) as scheduled_timer
    `;
    return state as { agent_busy: boolean; scheduled_timer: unknown | null };
  }

  async getConversationStreamSnapshot(sessionId: string, conversationId: string, limit: number) {
    const [snapshot] = await this.sql<{ messages: MessageRow[] | null; agent_busy: boolean; scheduled_timer: unknown | null }[]>`
      select
        (
          select coalesce(
            jsonb_agg(
              to_jsonb(recent) ||
              jsonb_build_object(
                'media',
                coalesce(
                  (
                    select jsonb_agg(to_jsonb(media_rows) order by media_rows.created_at asc)
                    from "inception-1-test".message_media media_rows
                    where media_rows.message_id = recent.id
                  ),
                  '[]'::jsonb
                )
              )
              order by recent.created_at asc
            ),
            '[]'::jsonb
          )
          from (
            select *
            from (
              select m.*
              from "inception-1-test".messages m
              where m.conversation_id = ${conversationId}
                and m.browser_session_id = ${sessionId}
                and m.deleted_at is null
                and not exists (
                  select 1
                  from "inception-1-test".timeline_events e
                  where e.id = m.source_event_id
                    and e.processing_status = 'superseded'
                )
              order by created_at desc
              limit ${limit}
            ) recent_desc
            order by created_at asc
          ) recent
        ) as messages,
        exists(
          select 1
          from "inception-1-test".processing_jobs j
          join "inception-1-test".timeline_events e on e.id = j.event_id
          where j.conversation_id = ${conversationId}
            and j.status in ('queued', 'running')
            and j.job_type in ('mood_detection', 'metric_detection', 'character_agent')
            and e.processing_status = 'active'
            and not exists (
              select 1
              from "inception-1-test".timeline_events newer
              where newer.conversation_id = e.conversation_id
                and newer.sequence_no > e.sequence_no
                and newer.event_type in ('user_message_received', 'silence_timeout')
            )
        ) as agent_busy,
        (
          select jsonb_build_object('pause_seconds', pause_seconds, 'deadline_at', deadline_at)
          from "inception-1-test".silence_timers
          where conversation_id = ${conversationId}
            and status = 'scheduled'
          order by created_at desc
          limit 1
        ) as scheduled_timer
    `;
    return {
      messages: snapshot?.messages ?? [],
      agent_busy: snapshot?.agent_busy === true,
      scheduled_timer: snapshot?.scheduled_timer ?? null,
    };
  }

  async verifyDatabaseReady(): Promise<void> {
    const requiredTables = [
      'browser_sessions',
      'characters',
      'conversations',
      'messages',
      'timeline_events',
      'processing_jobs',
      'mood_detections',
      'metric_snapshots',
      'metric_deltas',
      'agent_runs',
      'hypotheses',
      'silence_timers',
      'agent_definitions',
      'agent_prompt_bundles',
      'agent_prompt_revisions',
      'prompt_registry_versions',
    ];
    const rows = await this.sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'inception-1-test'
        and table_name in ${this.sql(requiredTables)}
    `;
    const existing = new Set(rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !existing.has(table));
    if (missing.length > 0) {
      throw new Error(`Missing required database tables in schema "inception-1-test": ${missing.join(', ')}`);
    }

    const [migration] = await this.sql<{ count: number }[]>`
      select count(*)::int as count
      from "inception-1-test".schema_migrations
    `;
    if (!migration || migration.count < 1) {
      throw new Error('No applied migrations recorded in "inception-1-test".schema_migrations');
    }
  }
}
