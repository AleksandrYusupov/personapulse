import { createServer } from 'node:http';
import { loadConfig } from './config';
import { createSql } from './db/postgres';
import { createApp } from './http/app';
import { createImageMcpApp } from './mcp/imageMcpApp';
import { AgentPipeline } from './services/agentPipeline';
import { GeminiService } from './services/gemini';
import { PromptRegistry } from './services/promptRegistry';
import { Repository } from './services/repository';
import { StorageService } from './services/storage';
import { AgentWorker } from './workers/agentWorker';
import { SilenceWorker } from './workers/silenceWorker';

const config = loadConfig();
const sql = createSql(config.databaseUrl);
const repository = new Repository(sql, config);
const storage = new StorageService(config);
const gemini = new GeminiService(config);
const promptRegistry = config.role === 'image-mcp' ? null : new PromptRegistry(sql, config.promptCacheMaxAgeMs);
const pipeline = promptRegistry ? new AgentPipeline(sql, config, repository, promptRegistry, gemini, storage) : null;

await repository.verifyDatabaseReady();
await storage.verifyMediaBucket();
if (promptRegistry) {
  await promptRegistry.verifyRequiredPrompts();
  promptRegistry.startRealtimeInvalidation({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    schema: config.supabaseSchema,
  });
}

const workerId = `${config.role}-${process.pid}`;
const startedWorkers: Array<{ stop: () => void }> = [];

if (config.role === 'api' || config.role === 'all') {
  const app = createApp(config, repository, storage);
  const server = createServer(app);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`PersonaPulse listening on ${config.port}`);
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}

if (config.role === 'agent-worker' || config.role === 'all') {
  if (!pipeline) throw new Error('Agent worker requires prompt registry');
  const analysisWorker = new AgentWorker(
    repository,
    pipeline,
    `${workerId}:analysis`,
    'analysis',
    config.agentAnalysisConcurrency,
    config.agentIdlePollMs,
  );
  analysisWorker.start();
  startedWorkers.push(analysisWorker);

  const responseWorker = new AgentWorker(
    repository,
    pipeline,
    `${workerId}:response`,
    'response',
    config.agentResponseConcurrency,
    config.agentIdlePollMs,
  );
  responseWorker.start();
  startedWorkers.push(responseWorker);
  console.log(
    `PersonaPulse agent-workers started: analysis=${config.agentAnalysisConcurrency}, response=${config.agentResponseConcurrency}`,
  );
}

if (config.role === 'image-mcp') {
  const app = createImageMcpApp(config, repository, storage, gemini);
  const server = createServer(app);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`PersonaPulse image MCP listening on ${config.port}`);
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}

if (config.role === 'silence-worker' || config.role === 'all') {
  const worker = new SilenceWorker(sql, repository, `${workerId}:silence`);
  worker.start();
  startedWorkers.push(worker);
  console.log('PersonaPulse silence-worker started');
}

async function shutdown() {
  for (const worker of startedWorkers) worker.stop();
  promptRegistry?.stopRealtimeInvalidation();
  await sql.end({ timeout: 5 });
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
