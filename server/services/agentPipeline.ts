import type { Sql } from 'postgres';
import { AppConfig } from '../config';
import { MessageRow, ProcessingJobRow, TimelineEventRow } from '../domain';
import { hashJson, newId } from '../util/crypto';
import { GeminiService } from './gemini';
import { createImageMcpToolSession } from './imageMcpClient';
import { buildMetricDelta, buildMetricSnapshot } from './metrics';
import { PromptRegistry, ResolvedPrompt } from './promptRegistry';
import { Repository } from './repository';
import { StorageService } from './storage';
import { validateCharacterOutput, validateMoodOutput } from './validation';

export class AgentPipeline {
  constructor(
    private readonly sql: Sql,
    private readonly config: AppConfig,
    private readonly repository: Repository,
    private readonly promptRegistry: PromptRegistry,
    private readonly gemini: GeminiService,
    private readonly storage: StorageService,
  ) {}

  async handleJob(job: ProcessingJobRow): Promise<void> {
    if (job.job_type === 'mood_detection') {
      await this.handleMoodDetection(job);
      return;
    }
    if (job.job_type === 'metric_detection') {
      await this.handleMetricDetection(job);
      return;
    }
    if (job.job_type === 'character_agent') {
      await this.handleCharacterAgent(job);
      return;
    }
    throw new Error(`Unsupported job type ${job.job_type}`);
  }

  private async handleMoodDetection(job: ProcessingJobRow): Promise<void> {
    const stageStarted = Date.now();
    const stageMs: Record<string, number> = {};

    let started = Date.now();
    const context = await this.repository.loadAnalysisJobContext(job.id);
    stageMs.context_load = Date.now() - started;
    const event = context?.event;
    if (!context?.is_current || !event) {
      await this.repository.markJobSuperseded(job.id);
      return;
    }

    started = Date.now();
    const prompt = await this.promptRegistry.resolve({ agentKey: 'mood_detector' });
    stageMs.prompt_resolve = Date.now() - started;

    const messages = context.messages ?? [];
    const compiledInput = {
      event,
      messages: messages.slice(-10).map(compactMessage),
      previous_mood: context.previous_mood,
    };

    started = Date.now();
    const output = validateMoodOutput(
      await this.gemini.generateJson({
        model: prompt.model,
        systemInstruction: prompt.systemPrompt,
        prompt: buildPrompt(prompt, compiledInput),
        responseSchema: prompt.responseSchema,
        temperature: numberFromConfig(prompt.modelConfig.temperature, 0.2),
        maxOutputTokens: numberFromConfig(prompt.modelConfig.maxOutputTokens, 2500),
      }),
      event.id,
    );
    stageMs.model = Date.now() - started;

    started = Date.now();
    const snapshot = buildMetricSnapshot({ event, messages, mood: output });
    const delta = buildMetricDelta(
      snapshot,
      context.previous_metric_snapshot ?? null,
      event.id,
      context.previous_metric_event_id ?? null,
    );
    stageMs.metric_calc = Date.now() - started;

    started = Date.now();
    const agentRunId = newId();
    await this.repository.commitAnalysisJobResult({
      jobId: job.id,
      agentRunId,
      moodDetectionId: newId(),
      metricSnapshotId: newId(),
      metricDeltaId: newId(),
      characterJobId: newId(),
      agentRun: buildAgentRunRecord(prompt, compiledInput),
      compiledInput,
      output,
      latencyMs: stageMs.model,
      metricSnapshot: snapshot,
      metricDelta: delta as any,
      previousMetricEventId: context.previous_metric_event_id ?? null,
      stageMs: { ...stageMs, total_before_commit: Date.now() - stageStarted },
    });
    stageMs.commit = Date.now() - started;
  }

  private async handleMetricDetection(job: ProcessingJobRow): Promise<void> {
    const existing = await this.loadMetric(job.event_id);
    if (existing) {
      await this.repository.markJobSucceeded(job.id);
      return;
    }

    const event = await this.repository.getEvent(job.event_id);
    if (await this.discardIfStale(job, event)) return;

    const messages = await this.loadMessages(event.conversation_id, 40);
    const mood = await this.loadMood(event.id);
    if (!mood) {
      throw new Error(`Metric detection requires current mood for event ${event.id}`);
    }
    const snapshot = buildMetricSnapshot({ event, messages, mood });
    const previous = await this.loadPreviousMetricSnapshot(event);
    const delta = buildMetricDelta(snapshot, previous?.snapshot ?? null, event.id, previous?.event_id ?? null);
    if (await this.discardIfStale(job, event)) return;

    const committed = await this.sql.begin(async (tx) => {
      const freshness = await this.repository.getEventFreshness(job.id, event, { tx: tx as any });
      if (!freshness.isCurrent) return false;
      const markedSucceeded = await this.repository.markJobSucceeded(job.id, tx as any);
      if (!markedSucceeded) return false;

      await tx`
        insert into "inception-1-test".metric_snapshots (
          id, event_id, conversation_id, browser_session_id, character_id, snapshot, mood_source
        )
        values (
          ${newId()}, ${event.id}, ${event.conversation_id}, ${event.browser_session_id},
          ${event.character_id}, ${tx.json(snapshot)}, 'current_mood_detection'
        )
        on conflict (event_id) do update set
          snapshot = excluded.snapshot,
          mood_source = excluded.mood_source
      `;

      await tx`
        insert into "inception-1-test".metric_deltas (
          id, event_id, previous_event_id, conversation_id, delta
        )
        values (${newId()}, ${event.id}, ${previous?.event_id ?? null}, ${event.conversation_id}, ${tx.json(delta as any)})
        on conflict (event_id) do update set
          previous_event_id = excluded.previous_event_id,
          delta = excluded.delta
      `;
      return true;
    });

    if (!committed) {
      await this.discardIfStale(job, event);
      return;
    }
    await this.repository.enqueueCharacterJobIfReady(event.id, event.conversation_id);
  }

  private async handleCharacterAgent(job: ProcessingJobRow): Promise<void> {
    const stageStarted = Date.now();
    const stageMs: Record<string, number> = {};

    let started = Date.now();
    const context = await this.repository.loadCharacterJobContext(job.id);
    stageMs.context_load = Date.now() - started;
    const event = context?.event;
    if (!context?.is_current || !event) {
      await this.repository.markJobSuperseded(job.id);
      return;
    }

    started = Date.now();
    const prompt = await this.promptRegistry.resolve({ agentKey: 'character_agent', characterId: event.character_id });
    stageMs.prompt_resolve = Date.now() - started;

    const messages = context.messages ?? [];
    const mood = context.mood;
    const metric = context.metric;
    const delta = context.delta;
    if (!mood || !metric) {
      throw new Error(`character_agent requires mood and metrics for event ${event.id}`);
    }
    const hypotheses = context.hypotheses ?? [];
    const unansweredCharacterMessageCount = countUnansweredCharacterMessages(messages);
    const baseCompiledInput = {
      event,
      messages: messages.map(compactMessage),
      mood,
      metric,
      delta,
      hypotheses,
      unanswered_character_message_count: unansweredCharacterMessageCount,
      image_tool_unavailable: false,
    };

    started = Date.now();
    const modelResult = await this.runCharacterModel(prompt, baseCompiledInput, messages, event);
    const output = modelResult.output;
    const compiledInput = modelResult.compiledInput;
    stageMs.model = Date.now() - started;

    started = Date.now();
    const imageMedia = extractActionImageMedia(output);
    stageMs.image = Date.now() - started;

    started = Date.now();
    const agentRunId = newId();
    const silence = computeSilenceTimer(output, unansweredCharacterMessageCount, this.config);
    await this.repository.commitCharacterJobResult({
      jobId: job.id,
      agentRunId,
      messageId: newId(),
      mediaId: imageMedia ? newId() : null,
      hypothesisId: newId(),
      hypothesisEvaluationId: newId(),
      timerId: newId(),
      agentRun: buildAgentRunRecord(prompt, compiledInput),
      compiledInput,
      output,
      latencyMs: stageMs.model,
      imageMedia: imageMedia
        ? {
            bucket: imageMedia.bucket,
            path: imageMedia.path,
            mimeType: imageMedia.mimeType,
            altText: imageMedia.altText,
            prompt: imageMedia.prompt,
            width: imageMedia.width,
            height: imageMedia.height,
            provider: imageMedia.provider,
            model: imageMedia.model,
          }
        : null,
      pauseSeconds: silence.pauseSeconds,
      stopUntilUser: silence.stopUntilUser,
      stageMs: { ...stageMs, total_before_commit: Date.now() - stageStarted },
    });
    stageMs.commit = Date.now() - started;
  }

  private async runCharacterModel(
    prompt: ResolvedPrompt,
    compiledInput: Record<string, unknown>,
    messages: MessageRow[],
    event: TimelineEventRow,
  ): Promise<{ output: Record<string, any>; compiledInput: Record<string, unknown> }> {
    let toolSession = null as Awaited<ReturnType<typeof createImageMcpToolSession>> | null;
    let input = compiledInput;
    try {
      toolSession = await createImageMcpToolSession(this.config, event);
    } catch (error) {
      console.error('image MCP unavailable before character generation', error);
      input = { ...compiledInput, image_tool_unavailable: true };
    }
    if (!toolSession) {
      input = { ...compiledInput, image_tool_unavailable: true };
    }

    try {
      const promptText = buildPrompt(prompt, input);
      const result = await this.gemini.generateJsonWithMetadata({
          model: prompt.model,
          systemInstruction: prompt.systemPrompt,
          prompt: promptText,
          contents: await buildMultimodalPromptContents(promptText, messages, this.storage, this.config),
          tools: toolSession?.tools,
          responseSchema: prompt.responseSchema,
          temperature: numberFromConfig(prompt.modelConfig.temperature, 0.65),
          maxOutputTokens: numberFromConfig(prompt.modelConfig.maxOutputTokens, 5000),
        });
      const output = validateCharacterOutput(
        mergeMcpMediaIntoCharacterOutput(result.value, result.automaticFunctionCallingHistory),
        event.id,
      );
      return { output, compiledInput: input };
    } catch (error) {
      if (!toolSession) throw error;
      console.error('character generation with image MCP failed; retrying without image tool', error);
      input = { ...compiledInput, image_tool_unavailable: true };
      const promptText = buildPrompt(prompt, input);
      const output = validateCharacterOutput(
        await this.gemini.generateJson({
          model: prompt.model,
          systemInstruction: prompt.systemPrompt,
          prompt: promptText,
          contents: await buildMultimodalPromptContents(promptText, messages, this.storage, this.config),
          responseSchema: prompt.responseSchema,
          temperature: numberFromConfig(prompt.modelConfig.temperature, 0.65),
          maxOutputTokens: numberFromConfig(prompt.modelConfig.maxOutputTokens, 5000),
        }),
        event.id,
      );
      return { output, compiledInput: input };
    } finally {
      if (toolSession) {
        await toolSession.close().catch(() => undefined);
      }
    }
  }

  private async discardIfStale(job: ProcessingJobRow, event: TimelineEventRow): Promise<boolean> {
    const freshness = await this.repository.getEventFreshness(job.id, event);
    if (freshness.isCurrent) return false;

    if (freshness.latestEventId && freshness.latestSequenceNo !== null && freshness.latestSequenceNo > event.sequence_no) {
      await this.repository.supersedeConversationWork(event.conversation_id, freshness.latestEventId, freshness.latestSequenceNo);
    }
    await this.repository.markJobSuperseded(job.id);
    return true;
  }

  private async loadMessages(conversationId: string, limit: number): Promise<MessageRow[]> {
    return this.sql<MessageRow[]>`
      select *
      from (
        select m.*
        from "inception-1-test".messages m
        where m.conversation_id = ${conversationId}
          and m.deleted_at is null
          and not exists (
            select 1
            from "inception-1-test".timeline_events e
            where e.id = m.source_event_id
              and e.processing_status = 'superseded'
          )
        order by created_at desc
        limit ${limit}
      ) recent
      order by created_at asc
    `;
  }

  private async loadPreviousMood(event: TimelineEventRow) {
    const rows = await this.sql<{ result: any }[]>`
      select md.result
      from "inception-1-test".mood_detections md
      join "inception-1-test".timeline_events e on e.id = md.event_id
      where md.conversation_id = ${event.conversation_id}
        and md.event_id <> ${event.id}
        and e.processing_status = 'active'
        and e.sequence_no < ${event.sequence_no}
      order by md.created_at desc
      limit 1
    `;
    return rows[0]?.result ?? null;
  }

  private async loadMood(eventId: string) {
    const rows = await this.sql<{ result: any }[]>`
      select result
      from "inception-1-test".mood_detections
      where event_id = ${eventId}
      limit 1
    `;
    return rows[0]?.result ?? null;
  }

  private async loadMetric(eventId: string) {
    const rows = await this.sql<{ snapshot: any }[]>`
      select snapshot
      from "inception-1-test".metric_snapshots
      where event_id = ${eventId}
      limit 1
    `;
    return rows[0]?.snapshot ?? null;
  }

  private async loadMetricDelta(eventId: string) {
    const rows = await this.sql<{ delta: any }[]>`
      select delta
      from "inception-1-test".metric_deltas
      where event_id = ${eventId}
      limit 1
    `;
    return rows[0]?.delta ?? null;
  }

  private async loadPreviousMetricSnapshot(event: TimelineEventRow) {
    const rows = await this.sql<{ event_id: string; snapshot: any }[]>`
      select ms.event_id, ms.snapshot
      from "inception-1-test".metric_snapshots ms
      join "inception-1-test".timeline_events e on e.id = ms.event_id
      where ms.conversation_id = ${event.conversation_id}
        and ms.event_id <> ${event.id}
        and e.processing_status = 'active'
        and e.sequence_no < ${event.sequence_no}
      order by ms.created_at desc
      limit 1
    `;
    return rows[0] ?? null;
  }

  private async loadHypothesisMemory(event: TimelineEventRow) {
    return this.sql`
      select h.id, h.status, h.hypothesis_text, h.expected_reaction, h.success_criteria, h.selected_action, h.topic_label, h.mood_label, h.created_at
      from "inception-1-test".hypotheses h
      join "inception-1-test".timeline_events e on e.id = h.event_id
      where h.browser_session_id = ${event.browser_session_id}
        and h.character_id = ${event.character_id}
        and e.processing_status = 'active'
        and e.sequence_no < ${event.sequence_no}
      order by h.created_at desc
      limit 16
    `;
  }

  private async applyPreviousHypothesisAssessment(tx: any, output: Record<string, any>, event: TimelineEventRow, agentRunId: string) {
    const assessment = output.previous_hypothesis_assessment;
    if (!assessment?.hypothesis_id || assessment.assessment === 'not_applicable') return;
    const status = ['supported', 'refuted', 'inconclusive'].includes(assessment.assessment) ? assessment.assessment : 'inconclusive';
    const updated = await tx<{ id: string }[]>`
      update "inception-1-test".hypotheses
      set status = ${status},
          resolved_at = now()
      where id = ${assessment.hypothesis_id}
        and status = 'pending'
        and exists (
          select 1
          from "inception-1-test".timeline_events e
          where e.id = hypotheses.event_id
            and e.processing_status = 'active'
        )
      returning id
    `;
    if (!updated[0]) return;

    await tx`
      insert into "inception-1-test".hypothesis_evaluations (
        id, hypothesis_id, event_id, agent_run_id, assessment, evidence, confidence
      )
      values (
        ${newId()}, ${assessment.hypothesis_id}, ${event.id}, ${agentRunId},
        ${status}, ${String(assessment.evidence ?? '').slice(0, 2000)}, ${Number(assessment.confidence ?? 0)}
      )
    `;
  }

  private async persistSelectedHypothesis(tx: any, output: Record<string, any>, event: TimelineEventRow, agentRunId: string, mood: Record<string, any> | null) {
    const selected = output.selected_hypothesis;
    const text = String(selected.hypothesis_text ?? selected.hypothesis ?? '').trim();
    if (!text) throw new Error('selected_hypothesis.hypothesis_text is required');

    await tx`
      insert into "inception-1-test".hypotheses (
        id, browser_session_id, character_id, conversation_id, event_id, agent_run_id,
        status, hypothesis_text, expected_reaction, success_criteria, selected_action,
        topic_label, mood_label
      )
      values (
        ${newId()}, ${event.browser_session_id}, ${event.character_id}, ${event.conversation_id},
        ${event.id}, ${agentRunId}, 'pending', ${text},
        ${tx.json(selected.expected_user_reaction ?? {})},
        ${tx.json(selected.success_criteria ?? {})},
        ${output.action.type},
        ${mood?.current_topic?.label ?? null},
        ${mood?.current_user_mood?.label ?? null}
      )
    `;
  }

}

function buildPrompt(prompt: ResolvedPrompt, runtimeInput: unknown): string {
  return [
    prompt.developerPrompt,
    prompt.contextBuilderInstructions,
    prompt.outputContractInstructions,
    'Runtime context JSON:',
    JSON.stringify(runtimeInput),
  ].join('\n\n');
}

function compactMessage(message: MessageRow) {
  return {
    message_id: message.id,
    sender: message.sender_type,
    timestamp: message.created_at,
    text: message.text,
    display_emotion: message.display_emotion,
    media: (message.media ?? []).map((media) => ({
      id: media.id,
      type: media.media_type,
      storage_bucket: media.storage_bucket,
      storage_path: media.storage_path,
      mime_type: media.mime_type,
      width: media.width,
      height: media.height,
      alt_text: media.alt_text,
      generation_prompt: media.generation_prompt ?? null,
      provider: media.provider ?? null,
      created_at: media.created_at ?? null,
    })),
  };
}

function numberFromConfig(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildAgentRunRecord(prompt: ResolvedPrompt, compiledInput: unknown): Record<string, unknown> {
  const compiledPromptHash = hashJson({
    system: prompt.systemPrompt,
    input: compiledInput,
  });
  return {
    agent_key: prompt.agentKey,
    model: prompt.model,
    prompt_revision_ids: [prompt.revisionId],
    primary_prompt_revision_id: prompt.revisionId,
    prompt_registry_version: prompt.registryVersion,
    prompt_content_hash: prompt.contentHash,
    compiled_prompt_hash: compiledPromptHash,
    input_summary: { context_hash: hashJson(compiledInput) },
  };
}

async function buildMultimodalPromptContents(
  promptText: string,
  messages: MessageRow[],
  storage: StorageService,
  config: AppConfig,
): Promise<unknown[]> {
  const candidates: Array<{ message: MessageRow; media: NonNullable<MessageRow['media']>[number] }> = [];
  for (const message of [...messages].reverse()) {
    for (const media of [...(message.media ?? [])].reverse()) {
      if (media.media_type === 'image') {
        candidates.push({ message, media });
      }
    }
  }

  const selected: unknown[] = [];
  let usedBytes = 0;
  for (const candidate of candidates) {
    if (selected.length / 2 >= config.agentMultimodalImageLimit) break;
    try {
      const downloaded = await storage.downloadMedia(candidate.media);
      if (usedBytes + downloaded.data.length > config.agentMultimodalImageByteBudget) continue;
      usedBytes += downloaded.data.length;
      selected.unshift({
        inlineData: {
          mimeType: downloaded.mimeType,
          data: downloaded.data.toString('base64'),
        },
      });
      selected.unshift({
        text: `Recent chat image context. message_id=${candidate.message.id}; sender=${candidate.message.sender_type}; timestamp=${candidate.message.created_at}; alt=${candidate.media.alt_text ?? ''}; prompt=${candidate.media.generation_prompt ?? ''}`,
      });
    } catch (error) {
      console.error('failed to attach multimodal image context', {
        media_id: candidate.media.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return [...selected, { text: promptText }];
}

function countUnansweredCharacterMessages(messages: MessageRow[]): number {
  let count = 0;
  for (const message of [...messages].reverse()) {
    if (message.sender_type === 'user') break;
    if (message.sender_type === 'character') count += 1;
  }
  return count;
}

function extractActionImageMedia(output: Record<string, any>) {
  const media = output.action?.media;
  if (!media || media.ok !== true) return null;
  const bucket = media.storage_bucket ?? media.bucket;
  const path = media.storage_path ?? media.path;
  if (typeof bucket !== 'string' || typeof path !== 'string') return null;
  return {
    bucket,
    path,
    mimeType: typeof media.mime_type === 'string' ? media.mime_type : media.mimeType ?? 'image/png',
    altText: typeof media.alt_text === 'string' ? media.alt_text : media.altText ?? 'Generated PersonaPulse image',
    prompt: typeof media.generation_prompt === 'string' ? media.generation_prompt : media.prompt ?? null,
    width: typeof media.width === 'number' ? media.width : null,
    height: typeof media.height === 'number' ? media.height : null,
    provider: typeof media.provider === 'string' ? media.provider : 'gemini',
    model: typeof media.model === 'string' ? media.model : null,
  };
}

function mergeMcpMediaIntoCharacterOutput(value: unknown, automaticFunctionCallingHistory: unknown[]): unknown {
  const output = value as Record<string, any>;
  if (!output || typeof output !== 'object' || !output.action || typeof output.action !== 'object') return value;

  const media = extractSuccessfulImageToolMedia(automaticFunctionCallingHistory);
  if (!media) return value;

  const action = output.action as Record<string, any>;
  if (!['send_image', 'send_text_image', 'send_text'].includes(action.type)) return value;
  const currentMedia = action.media;
  if (!currentMedia || typeof currentMedia !== 'object' || currentMedia.ok !== true) {
    action.media = media;
  }

  if (action.type === 'send_text') {
    action.type = 'send_text_image';
  }

  return output;
}

function extractSuccessfulImageToolMedia(automaticFunctionCallingHistory: unknown[]): Record<string, any> | null {
  for (const content of [...automaticFunctionCallingHistory].reverse()) {
    const parts = Array.isArray((content as any)?.parts) ? (content as any).parts : [];
    for (const part of [...parts].reverse()) {
      const functionResponse = (part as any)?.functionResponse ?? (part as any)?.function_response;
      if (functionResponse?.name !== 'generate_personapulse_image') continue;
      const media = extractStructuredImageToolResult(functionResponse.response);
      if (media) return media;
    }
  }
  return null;
}

function extractStructuredImageToolResult(response: unknown): Record<string, any> | null {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, any>;
  const direct = normalizeImageToolMedia(record);
  if (direct) return direct;

  const structured = normalizeImageToolMedia(record.structuredContent ?? record.structured_content);
  if (structured) return structured;

  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    if ((item as any)?.type !== 'text' || typeof (item as any).text !== 'string') continue;
    try {
      const parsed = JSON.parse((item as any).text);
      const parsedMedia = normalizeImageToolMedia(parsed);
      if (parsedMedia) return parsedMedia;
    } catch (_) {
      // MCP text content can be human-readable; only JSON tool payloads are useful here.
    }
  }

  return null;
}

function normalizeImageToolMedia(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object') return null;
  const media = value as Record<string, any>;
  const bucket = media.storage_bucket ?? media.bucket;
  const path = media.storage_path ?? media.path;
  if (media.ok !== true || typeof bucket !== 'string' || !bucket.trim() || typeof path !== 'string' || !path.trim()) {
    return null;
  }
  return {
    ...media,
    ok: true,
    storage_bucket: bucket,
    storage_path: path,
  };
}

function computeSilenceTimer(
  output: Record<string, any>,
  unansweredCharacterMessageCount: number,
  config: AppConfig,
): { pauseSeconds: number; stopUntilUser: boolean } {
  if (output.silence_timer?.stop_until_user === true || unansweredCharacterMessageCount >= 7) {
    return { pauseSeconds: config.silenceDefaultSeconds, stopUntilUser: true };
  }

  const requested = Number(output.silence_timer?.pause_seconds);
  const fallback = config.silenceDefaultSeconds;
  const rounded = Number.isFinite(requested) ? Math.round(requested) : fallback;
  const normalMax = Math.max(config.silenceNormalMinSeconds, config.silenceNormalMaxSeconds);
  let pauseSeconds = Math.max(config.silenceNormalMinSeconds, Math.min(normalMax, rounded));

  if (unansweredCharacterMessageCount >= 4) {
    pauseSeconds = Math.max(pauseSeconds, config.silenceIgnoredPauseSeconds);
  }

  return {
    pauseSeconds: Math.min(config.silenceAbsoluteMaxSeconds, pauseSeconds),
    stopUntilUser: false,
  };
}

async function insertAgentRun(tx: any, input: {
  id: string;
  prompt: ResolvedPrompt;
  event: TimelineEventRow;
  job: ProcessingJobRow;
  status: string;
  compiledInput: unknown;
  output: unknown;
  latencyMs: number;
}) {
  const compiledPromptHash = hashJson({
    system: input.prompt.systemPrompt,
    input: input.compiledInput,
  });
  await tx`
    insert into "inception-1-test".agent_runs (
      id, agent_key, event_id, job_id, conversation_id, character_id, model, status,
      prompt_revision_ids, primary_prompt_revision_id, prompt_registry_version,
      prompt_content_hash, compiled_prompt_hash, input_summary, output_validated,
      latency_ms, finished_at
    )
    values (
      ${input.id}, ${input.prompt.agentKey}, ${input.event.id}, ${input.job.id},
      ${input.event.conversation_id}, ${input.event.character_id}, ${input.prompt.model}, ${input.status},
      ${tx.json([input.prompt.revisionId])}, ${input.prompt.revisionId},
      ${input.prompt.registryVersion}, ${input.prompt.contentHash}, ${compiledPromptHash},
      ${tx.json({ context_hash: hashJson(input.compiledInput) })}, ${tx.json(input.output as any)},
      ${input.latencyMs}, now()
    )
  `;
}
