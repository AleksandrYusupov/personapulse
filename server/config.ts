import dotenv from 'dotenv';

dotenv.config();

export type ProcessRole = 'api' | 'agent-worker' | 'silence-worker' | 'all';

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
  if (role === 'api' || role === 'agent-worker' || role === 'silence-worker' || role === 'all') {
    return role;
  }
  throw new Error(`Invalid PROCESS_ROLE: ${role}`);
}

export function loadConfig(): AppConfig {
  const schema = readRequired('SUPABASE_SCHEMA');
  if (schema !== 'inception-1-test') {
    throw new Error(`SUPABASE_SCHEMA must be exactly "inception-1-test"; got "${schema}"`);
  }

  return {
    nodeEnv: readOptional('NODE_ENV', 'development'),
    role: readRole(),
    port: readNumber('PORT', 3001),
    frontendOrigin: readOptional('FRONTEND_ORIGIN', 'http://localhost:3000'),
    supabaseUrl: readRequired('SUPABASE_URL'),
    supabaseServiceRoleKey: readRequired('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseSchema: 'inception-1-test',
    databaseUrl: process.env.SUPABASE_DATABASE_URL?.trim() || readRequired('DATABASE_URL'),
    geminiApiKey: readRequired('GEMINI_API_KEY'),
    adminApiToken: readRequired('ADMIN_API_TOKEN'),
    sessionSecretPepper: readRequired('SESSION_SECRET_PEPPER'),
    mediaBucket: readRequired('MEDIA_BUCKET'),
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
