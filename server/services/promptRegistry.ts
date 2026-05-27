import { createClient } from '@supabase/supabase-js';
import type { Sql } from 'postgres';
import { hashJson } from '../util/crypto';

export interface ResolvedPrompt {
  registryVersion: number;
  bundleId: string;
  revisionId: string;
  contentHash: string;
  agentKey: string;
  model: string;
  systemPrompt: string;
  developerPrompt: string;
  contextBuilderInstructions: string;
  outputContractInstructions: string;
  toolPolicy: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
  responseSchema: unknown;
  safetyPolicy: Record<string, unknown>;
}

export class PromptRegistry {
  private realtimeChannel: ReturnType<ReturnType<typeof createClient>['channel']> | null = null;
  private readonly cache = new Map<string, { expiresAt: number; prompt: ResolvedPrompt }>();

  constructor(
    private readonly sql: Sql,
    private readonly cacheMaxAgeMs = 0,
  ) {}

  async resolve(input: {
    agentKey: string;
    characterId?: string | null;
    environment?: string;
    locale?: string;
  }): Promise<ResolvedPrompt> {
    const environment = input.environment ?? 'production';
    const locale = input.locale ?? 'any';
    const cacheKey = this.buildCacheKey(input.agentKey, input.characterId ?? null, environment, locale);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.prompt;
    }

    const registryRows = await this.sql<{ version: string }[]>`
      select version::text as version
      from "inception-1-test".prompt_registry_versions
      where id = 1
    `;
    const registryVersion = Number(registryRows[0]?.version);
    if (!Number.isFinite(registryVersion)) {
      throw new Error('Prompt registry version row is missing');
    }

    const rows = await this.sql<any[]>`
      select
        b.id as bundle_id,
        r.id as revision_id,
        r.content_hash,
        d.agent_key,
        d.default_model,
        r.system_prompt,
        r.developer_prompt,
        r.context_builder_instructions,
        r.output_contract_instructions,
        r.tool_policy,
        r.model_config,
        r.response_schema,
        r.safety_policy
      from "inception-1-test".agent_definitions d
      join "inception-1-test".agent_prompt_bundles b on b.agent_definition_id = d.id
      join "inception-1-test".agent_prompt_revisions r on r.bundle_id = b.id
      where d.agent_key = ${input.agentKey}
        and d.is_active = true
        and b.is_active = true
        and r.status = 'active'
        and b.environment = ${environment}
        and (
          (b.character_id = ${input.characterId ?? null} and b.locale = ${locale})
          or (b.character_id = ${input.characterId ?? null} and b.locale = 'any')
          or (b.character_id is null and b.locale = ${locale})
          or (b.character_id is null and b.locale = 'any')
        )
      order by
        case
          when b.character_id = ${input.characterId ?? null} and b.locale = ${locale} then 1
          when b.character_id = ${input.characterId ?? null} and b.locale = 'any' then 2
          when b.character_id is null and b.locale = ${locale} then 3
          else 4
        end
      limit 1
    `;

    const row = rows[0];
    if (!row) {
      throw new Error(`Active prompt not found for agent ${input.agentKey}`);
    }
    if (input.agentKey === 'character_agent' && !input.characterId) {
      throw new Error('character_agent prompt requires character_id');
    }

    const modelConfig = row.model_config ?? {};
    const model = typeof modelConfig.model === 'string' ? modelConfig.model : row.default_model;
    const resolved = {
      registryVersion,
      bundleId: row.bundle_id,
      revisionId: row.revision_id,
      contentHash: row.content_hash ?? hashJson(row),
      agentKey: row.agent_key,
      model,
      systemPrompt: row.system_prompt,
      developerPrompt: row.developer_prompt,
      contextBuilderInstructions: row.context_builder_instructions,
      outputContractInstructions: row.output_contract_instructions,
      toolPolicy: row.tool_policy ?? {},
      modelConfig,
      responseSchema: row.response_schema,
      safetyPolicy: row.safety_policy ?? {},
    };
    if (this.cacheMaxAgeMs > 0) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheMaxAgeMs, prompt: resolved });
    }
    return resolved;
  }

  async verifyRequiredPrompts(): Promise<void> {
    await this.resolve({ agentKey: 'mood_detector' });
    await this.resolve({ agentKey: 'metric_detector' });
    await this.resolve({ agentKey: 'safety_guard' });

    const characters = await this.sql<{ id: string; slug: string }[]>`
      select id, slug
      from "inception-1-test".characters
      where is_active = true
        and deleted_at is null
    `;
    if (!characters.length) {
      throw new Error('No active characters are seeded');
    }
    for (const character of characters) {
      await this.resolve({ agentKey: 'character_agent', characterId: character.id });
    }
  }

  startRealtimeInvalidation(input: { supabaseUrl: string; serviceRoleKey: string; schema: 'inception-1-test' }): void {
    if (typeof WebSocket === 'undefined') {
      console.warn('Prompt Registry realtime invalidation disabled: WebSocket is unavailable in this Node.js runtime.');
      return;
    }

    const client = createClient(input.supabaseUrl, input.serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      db: {
        schema: input.schema,
      },
    });

    this.realtimeChannel = client
      .channel('prompt-registry-invalidation')
      .on('postgres_changes', { event: '*', schema: input.schema, table: 'agent_prompt_revisions' }, (payload) => {
        this.clearCache();
        console.log('prompt_cache_invalidated', { table: 'agent_prompt_revisions', event: payload.eventType });
      })
      .on('postgres_changes', { event: '*', schema: input.schema, table: 'agent_prompt_bundles' }, (payload) => {
        this.clearCache();
        console.log('prompt_cache_invalidated', { table: 'agent_prompt_bundles', event: payload.eventType });
      })
      .on('postgres_changes', { event: '*', schema: input.schema, table: 'prompt_registry_versions' }, (payload) => {
        this.clearCache();
        console.log('prompt_cache_invalidated', { table: 'prompt_registry_versions', event: payload.eventType });
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('Prompt Registry realtime subscription failed; per-run DB resolution remains authoritative');
        }
      });
  }

  stopRealtimeInvalidation(): void {
    if (this.realtimeChannel) {
      void this.realtimeChannel.unsubscribe();
      this.realtimeChannel = null;
    }
  }

  private buildCacheKey(agentKey: string, characterId: string | null, environment: string, locale: string): string {
    return [agentKey, characterId ?? '', environment, locale].join(':');
  }

  private clearCache(): void {
    this.cache.clear();
  }
}
