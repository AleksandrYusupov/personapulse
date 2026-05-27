import type { Sql } from 'postgres';
import { Repository } from '../services/repository';
import { newId } from '../util/crypto';

interface SilenceTimerRow {
  id: string;
  browser_session_id: string;
  character_id: string;
  conversation_id: string;
  pause_seconds: number;
  scheduled_at: string;
  deadline_at: string | null;
}

export class SilenceWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sql: Sql,
    private readonly repository: Repository,
    private readonly workerId: string,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.sql<SilenceTimerRow[]>`
        select *
        from "inception-1-test".claim_due_silence_timer(${this.workerId})
      `;
      const timer = rows[0];
      if (!timer) return;
      await this.processTimer(timer);
    } catch (error) {
      console.error('silence-worker tick failed', error);
    } finally {
      this.running = false;
    }
  }

  private async processTimer(timer: SilenceTimerRow): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [conversation] = await tx<{ id: string }[]>`
        select id
        from "inception-1-test".conversations
        where id = ${timer.conversation_id}
          and status = 'active'
          and deleted_at is null
        for update
      `;
      if (!conversation) {
        await tx`
          update "inception-1-test".silence_timers
          set status = 'expired_stale',
              updated_at = now()
          where id = ${timer.id}
        `;
        return;
      }

      const [presence] = await tx<{ is_active: boolean }[]>`
        select exists(
          select 1
          from "inception-1-test".active_dialog_presence
          where browser_session_id = ${timer.browser_session_id}
            and character_id = ${timer.character_id}
            and conversation_id = ${timer.conversation_id}
            and expires_at > now()
        ) as is_active
      `;
      if (!presence?.is_active) {
        await tx`
          update "inception-1-test".silence_timers
          set status = 'expired_stale',
              updated_at = now()
          where id = ${timer.id}
        `;
        return;
      }

      const newerUserMessages = await tx<{ id: string }[]>`
        select id
        from "inception-1-test".messages
        where conversation_id = ${timer.conversation_id}
          and sender_type = 'user'
          and created_at > ${timer.scheduled_at}
        limit 1
      `;
      if (newerUserMessages[0]) {
        await tx`
          update "inception-1-test".silence_timers
          set status = 'cancelled_by_user_message',
              updated_at = now()
          where id = ${timer.id}
        `;
        return;
      }

      const [sequence] = await tx<{ sequence_no: number }[]>`
        select "inception-1-test".next_timeline_sequence(${timer.conversation_id}) as sequence_no
      `;
      const eventId = newId();
      await tx`
        insert into "inception-1-test".timeline_events (
          id, conversation_id, browser_session_id, character_id, sequence_no,
          event_type, source_timer_id, payload
        )
        values (
          ${eventId}, ${timer.conversation_id}, ${timer.browser_session_id}, ${timer.character_id},
          ${sequence.sequence_no}, 'silence_timeout', ${timer.id},
          ${tx.json({
            kind: 'silence_timeout',
            timer_id: timer.id,
            pause_seconds: timer.pause_seconds,
            scheduled_at: timer.scheduled_at,
            deadline_at: timer.deadline_at,
            actual_fired_at: new Date().toISOString(),
            active_presence_verified: true,
          })}
        )
      `;

      await this.repository.supersedeConversationWork(timer.conversation_id, eventId, sequence.sequence_no, tx as any);
      await this.repository.enqueueEventJobs(tx as any, eventId, timer.conversation_id);
    });
  }
}
