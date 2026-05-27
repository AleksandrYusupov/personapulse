import dotenv from 'dotenv';

dotenv.config();

export type ProcessRole = 'api' | 'agent-worker' | 'silence-worker' | 'image-mcp' | 'all';

export interface AppConfig {
  nodeEnv: string;
  role: ProcessRole;
  port: number;
  frontendOrigin: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseSchema: 'inception-1-test';
  databaseUrl: string;
  geminiApiKey: string;
  adminApiToken: string;
  sessionSecretPepper: string;
  mediaBucket: string;
  imageMcpUrl: string | null;
  imageMcpAudience: string | null;
  imageMcpLocalBearerToken: string | null;
  imageMcpContextSigningSecret: string | null;
  agentMultimodalImageLimit: number;
  agentMultimodalImageByteBudget: number;
  silenceNormalMinSeconds: number;
  silenceNormalMaxSeconds: number;
  silenceDefaultSeconds: number;
  silenceIgnoredPauseSeconds: number;
  silenceAbsoluteMaxSeconds: number;
  promptCacheMaxAgeMs: number;
  activeDialogTtlSeconds: number;
  agentAnalysisConcurrency: number;
  agentResponseConcurrency: number;
  agentIdlePollMs: number;
}

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function readOptional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a finite number`);
  }
  return value;
}

function readRole(): ProcessRole {
  const role = readOptional('PROCESS_ROLE', 'api');
  if (role === 'api' || role === 'agent-worker' || role === 'silence-worker' || role === 'image-mcp' || role === 'all') {
    return role;
  }
  throw new Error(`Invalid PROCESS_ROLE: ${role}`);
}

function readOptionalNullable(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function inferImageMcpAudience(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function loadConfig(): AppConfig {
  const schema = readRequired('SUPABASE_SCHEMA');
  if (schema !== 'inception-1-test') {
    throw new Error(`SUPABASE_SCHEMA must be exactly "inception-1-test"; got "${schema}"`);
  }
  const role = readRole();
  const imageMcpUrl = readOptionalNullable('IMAGE_MCP_URL');

  return {
    nodeEnv: readOptional('NODE_ENV', 'development'),
    role,
    port: readNumber('PORT', 3001),
    frontendOrigin: readOptional('FRONTEND_ORIGIN', 'http://localhost:3000'),
    supabaseUrl: readRequired('SUPABASE_URL'),
    supabaseServiceRoleKey: readRequired('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseSchema: 'inception-1-test',
    databaseUrl: process.env.SUPABASE_DATABASE_URL?.trim() || readRequired('DATABASE_URL'),
    geminiApiKey: readRequired('GEMINI_API_KEY'),
    adminApiToken: role === 'image-mcp' ? readOptional('ADMIN_API_TOKEN', '') : readRequired('ADMIN_API_TOKEN'),
    sessionSecretPepper: role === 'image-mcp' ? readOptional('SESSION_SECRET_PEPPER', '') : readRequired('SESSION_SECRET_PEPPER'),
    mediaBucket: readRequired('MEDIA_BUCKET'),
    imageMcpUrl,
    imageMcpAudience: readOptionalNullable('IMAGE_MCP_AUDIENCE') ?? inferImageMcpAudience(imageMcpUrl),
    imageMcpLocalBearerToken: readOptionalNullable('IMAGE_MCP_LOCAL_BEARER_TOKEN'),
    imageMcpContextSigningSecret: readOptionalNullable('IMAGE_MCP_CONTEXT_SIGNING_SECRET'),
    agentMultimodalImageLimit: Math.max(0, Math.floor(readNumber('AGENT_MULTIMODAL_IMAGE_LIMIT', 6))),
    agentMultimodalImageByteBudget: Math.max(0, Math.floor(readNumber('AGENT_MULTIMODAL_IMAGE_BYTE_BUDGET', 12 * 1024 * 1024))),
    silenceNormalMinSeconds: Math.max(1, Math.floor(readNumber('SILENCE_NORMAL_MIN_SECONDS', 5))),
    silenceNormalMaxSeconds: Math.max(1, Math.floor(readNumber('SILENCE_NORMAL_MAX_SECONDS', 10))),
    silenceDefaultSeconds: Math.max(1, Math.floor(readNumber('SILENCE_DEFAULT_SECONDS', 7))),
    silenceIgnoredPauseSeconds: Math.max(1, Math.floor(readNumber('SILENCE_IGNORED_PAUSE_SECONDS', 180))),
    silenceAbsoluteMaxSeconds: Math.max(1, Math.floor(readNumber('SILENCE_ABSOLUTE_MAX_SECONDS', 300))),
    promptCacheMaxAgeMs: readNumber('PROMPT_CACHE_MAX_AGE_MS', 300000),
    activeDialogTtlSeconds: readNumber('ACTIVE_DIALOG_TTL_SECONDS', 45),
    agentAnalysisConcurrency: Math.max(1, Math.floor(readNumber('AGENT_ANALYSIS_CONCURRENCY', 4))),
    agentResponseConcurrency: Math.max(1, Math.floor(readNumber('AGENT_RESPONSE_CONCURRENCY', 2))),
    agentIdlePollMs: Math.max(50, Math.floor(readNumber('AGENT_IDLE_POLL_MS', 250))),
  };
}

export function loadMigrationConfig(): Pick<AppConfig, 'databaseUrl' | 'supabaseSchema'> {
  const schema = readRequired('SUPABASE_SCHEMA');
  if (schema !== 'inception-1-test') {
    throw new Error(`SUPABASE_SCHEMA must be exactly "inception-1-test"; got "${schema}"`);
  }

  return {
    databaseUrl: process.env.SUPABASE_DATABASE_URL?.trim() || readRequired('DATABASE_URL'),
    supabaseSchema: 'inception-1-test',
  };
}
