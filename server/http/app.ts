import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { Request, Response } from 'express';
import { AppConfig } from '../config';
import { Repository } from '../services/repository';
import { StorageService } from '../services/storage';
import { asyncHandler, HttpError, optionalString, requireString } from '../util/http';
import { serializeCharacter, serializeConversation, serializeMessage } from './serializers';

interface AuthedRequest extends Request {
  sessionId: string;
}

export function createApp(config: AppConfig, repository: Repository, storage: StorageService) {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin && origin === config.frontendOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'false');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-Session-Secret, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true, schema: config.supabaseSchema });
  });

  app.post('/api/v1/browser-sessions', asyncHandler(async (req, res) => {
    const created = await repository.createBrowserSession(req.headers['user-agent'], req.headers['x-client-version'] as string | undefined);
    res.status(201).json(created);
  }));

  app.post('/api/v1/browser-sessions/verify', asyncHandler(async (req, res) => {
    const valid = await repository.verifyBrowserSession(
      typeof req.body?.session_id === 'string' ? req.body.session_id : undefined,
      typeof req.body?.session_secret === 'string' ? req.body.session_secret : undefined,
    );
    res.json({ valid });
  }));

  app.use('/api/v1', asyncHandler(async (req: Request, _res, next) => {
    const isFastMessagePost = req.method === 'POST' && /^\/conversations\/[^/]+\/messages$/.test(req.path);
    const isFastConversationPost = req.method === 'POST' && /^\/characters\/[^/]+\/conversations$/.test(req.path);
    const isFastConversationList = req.method === 'GET' && /^\/characters\/[^/]+\/conversations$/.test(req.path);
    if (req.path.startsWith('/admin') || isFastMessagePost || isFastConversationPost || isFastConversationList) {
      next();
      return;
    }
    const session = await repository.authenticate(
      req.header('X-Session-Id') ?? undefined,
      req.header('X-Session-Secret') ?? undefined,
    );
    (req as AuthedRequest).sessionId = session.id;
    next();
  }));

  app.get('/api/v1/characters', asyncHandler(async (_req: AuthedRequest, res) => {
    const characters = await repository.listCharacters();
    res.json({ characters: characters.map(serializeCharacter) });
  }));

  app.get('/api/v1/characters/:characterId/conversations', asyncHandler(async (req: Request, res) => {
    const conversations = await repository.listConversations(
      req.header('X-Session-Id') ?? undefined,
      req.header('X-Session-Secret') ?? undefined,
      req.params.characterId,
    );
    res.json({ conversations: conversations.map(serializeConversation) });
  }));

  app.post('/api/v1/characters/:characterId/conversations', asyncHandler(async (req: Request, res) => {
    const title = requireString(req.body?.title, 'title', 80);
    const conversation = await repository.createConversation(
      req.header('X-Session-Id') ?? undefined,
      req.header('X-Session-Secret') ?? undefined,
      req.params.characterId,
      title,
    );
    res.status(201).json({ conversation: serializeConversation(conversation) });
  }));

  app.delete('/api/v1/conversations/:conversationId', asyncHandler(async (req: AuthedRequest, res) => {
    await repository.deleteConversation(req.sessionId, req.params.conversationId);
    res.status(204).end();
  }));

  app.get('/api/v1/conversations/:conversationId/messages', asyncHandler(async (req: AuthedRequest, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);
    const messages = await repository.listMessages(req.sessionId, req.params.conversationId, limit);
    res.json({ messages: await Promise.all(messages.map((message) => serializeMessage(message, storage))) });
  }));

  app.post('/api/v1/conversations/:conversationId/messages', asyncHandler(async (req: Request, res) => {
    const clientMessageId = requireString(req.body?.client_message_id, 'client_message_id', 120);
    const text = requireString(req.body?.text, 'text', 4000);
    const result = await repository.postUserMessage(
      req.header('X-Session-Id') ?? undefined,
      req.header('X-Session-Secret') ?? undefined,
      req.params.conversationId,
      clientMessageId,
      text,
    );
    res.status(result.status === 'accepted' ? 202 : 200).json({
      message: await serializeMessage(result.message, storage),
      event_id: result.event_id,
      status: result.status,
    });
  }));

  app.put('/api/v1/active-dialog', asyncHandler(async (req: AuthedRequest, res) => {
    const characterId = requireString(req.body?.character_id, 'character_id', 120);
    const conversationId = requireString(req.body?.conversation_id, 'conversation_id', 120);
    const visibilityState = requireString(req.body?.visibility_state, 'visibility_state', 20);
    await repository.setActiveDialog(req.sessionId, characterId, conversationId, visibilityState);
    res.status(204).end();
  }));

  app.post('/api/v1/active-dialog/heartbeat', asyncHandler(async (req: AuthedRequest, res) => {
    await repository.heartbeatActiveDialog(req.sessionId);
    res.status(204).end();
  }));

  app.delete('/api/v1/active-dialog', asyncHandler(async (req: AuthedRequest, res) => {
    await repository.clearActiveDialog(req.sessionId);
    res.status(204).end();
  }));

  app.get('/api/v1/conversations/:conversationId/stream', asyncHandler(async (req: AuthedRequest, res) => {
    await repository.requireConversation(req.sessionId, req.params.conversationId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let lastMessageId: string | null = null;
    let lastBusyState: boolean | null = null;
    let lastTimerState: string | null = null;
    let closed = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let nextPollMs = 1500;

    const writeEvent = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const schedulePoll = () => {
      if (closed || pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void poll();
      }, nextPollMs);
    };

    const poll = async () => {
      try {
        const snapshot = await repository.getConversationStreamSnapshot(req.sessionId, req.params.conversationId, 100);
        nextPollMs = snapshot.agent_busy ? config.agentIdlePollMs : 1500;
        const messages = snapshot.messages;
        const unseen = lastMessageId
          ? messages.slice(messages.findIndex((message) => message.id === lastMessageId) + 1)
          : messages.slice(-1);
        for (const message of unseen) {
          lastMessageId = message.id;
          writeEvent('message.created', { message: await serializeMessage(message, storage) });
        }
        if (lastBusyState !== snapshot.agent_busy) {
          lastBusyState = snapshot.agent_busy;
          writeEvent(snapshot.agent_busy ? 'agent.typing_started' : 'agent.typing_finished', {
            conversation_id: req.params.conversationId,
          });
        }
        const timerState = JSON.stringify(snapshot.scheduled_timer ?? null);
        if (timerState !== lastTimerState) {
          lastTimerState = timerState;
          if (snapshot.scheduled_timer) writeEvent('timer.scheduled', snapshot.scheduled_timer);
        }
      } catch (error) {
        writeEvent('stream.error', { message: error instanceof Error ? error.message : 'stream poll failed' });
      } finally {
        schedulePoll();
      }
    };

    await poll();
    const heartbeat = setInterval(() => writeEvent('ping', { at: new Date().toISOString() }), 15000);

    req.on('close', () => {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(heartbeat);
    });
  }));

  app.use('/api/v1/admin', (req, res, next) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token !== config.adminApiToken) {
      res.status(401).json({ error: 'Invalid admin token' });
      return;
    }
    next();
  });

  app.get('/api/v1/admin/characters', asyncHandler(async (_req, res) => {
    const characters = await repository.listCharacters();
    res.json({ characters: characters.map(serializeCharacter) });
  }));

  app.post('/api/v1/admin/characters', asyncHandler(async (req, res) => {
    const character = await repository.adminCreateCharacter({
      slug: requireString(req.body?.slug, 'slug', 80),
      name: requireString(req.body?.name, 'name', 120),
      codename: requireString(req.body?.codename, 'codename', 120),
      role: requireString(req.body?.role, 'role', 160),
      shortDesc: requireString(req.body?.shortDesc, 'shortDesc', 500),
      longDesc: requireString(req.body?.longDesc, 'longDesc', 4000),
      avatarStoragePath: optionalString(req.body?.avatarStoragePath, 'avatarStoragePath', 500),
      theme: req.body?.theme ?? {},
      status: typeof req.body?.status === 'string' ? req.body.status : 'ONLINE',
      traits: Array.isArray(req.body?.traits) ? req.body.traits : [],
      specials: Array.isArray(req.body?.specials) ? req.body.specials : [],
      suggestedPrompts: Array.isArray(req.body?.suggestedPrompts) ? req.body.suggestedPrompts : [],
    });
    res.status(201).json({ character: serializeCharacter(character) });
  }));

  app.patch('/api/v1/admin/characters/:characterId', asyncHandler(async (req, res) => {
    const character = await repository.adminPatchCharacter(req.params.characterId, req.body ?? {});
    res.json({ character: serializeCharacter(character) });
  }));

  app.delete('/api/v1/admin/characters/:characterId', asyncHandler(async (req, res) => {
    await repository.adminDeleteCharacter(req.params.characterId);
    res.status(204).end();
  }));

  app.get('/api/v1/admin/agents', asyncHandler(async (_req, res) => {
    res.json({ agents: await repository.adminListAgents() });
  }));

  app.get('/api/v1/admin/prompt-bundles', asyncHandler(async (req, res) => {
    const agentKey = typeof req.query.agent_key === 'string' ? req.query.agent_key : null;
    const characterId = typeof req.query.character_id === 'string' && req.query.character_id ? req.query.character_id : null;
    res.json({ bundles: await repository.adminListPromptBundles(agentKey, characterId) });
  }));

  app.post('/api/v1/admin/prompt-bundles', asyncHandler(async (req, res) => {
    const bundle = await repository.adminCreatePromptBundle({
      agentKey: requireString(req.body?.agent_key, 'agent_key', 120),
      characterId: optionalString(req.body?.character_id, 'character_id', 120),
      bundleKey: requireString(req.body?.bundle_key, 'bundle_key', 120),
      environment: requireString(req.body?.environment, 'environment', 40),
      locale: requireString(req.body?.locale, 'locale', 20),
      description: optionalString(req.body?.description, 'description', 1000),
    });
    res.status(201).json({ bundle });
  }));

  app.get('/api/v1/admin/prompt-bundles/:bundleId/revisions', asyncHandler(async (req, res) => {
    res.json({ revisions: await repository.adminListPromptRevisions(req.params.bundleId) });
  }));

  app.post('/api/v1/admin/prompt-bundles/:bundleId/revisions', asyncHandler(async (req, res) => {
    const revision = await repository.adminCreateDraftRevision(req.params.bundleId, req.body ?? {});
    const validation = await repository.adminValidatePromptRevision(revision.id);
    res.status(201).json({ revision, validation });
  }));

  app.post('/api/v1/admin/prompt-revisions/:revisionId/validate', asyncHandler(async (req, res) => {
    res.json(await repository.adminValidatePromptRevision(req.params.revisionId));
  }));

  app.post('/api/v1/admin/prompt-revisions/:revisionId/activate', asyncHandler(async (req, res) => {
    const validation = await repository.adminValidatePromptRevision(req.params.revisionId);
    if (!validation.valid) {
      res.status(422).json(validation);
      return;
    }
    const revision = await repository.adminActivatePromptRevision(
      req.params.revisionId,
      typeof req.body?.activated_by === 'string' ? req.body.activated_by : 'admin',
      optionalString(req.body?.reason, 'reason', 1000),
    );
    res.json({ revision });
  }));

  app.post('/api/v1/admin/prompt-revisions/:revisionId/archive', asyncHandler(async (req, res) => {
    const revision = await repository.adminArchivePromptRevision(req.params.revisionId);
    res.json({ revision });
  }));

  app.post('/api/v1/admin/prompt-bundles/:bundleId/rollback', asyncHandler(async (req, res) => {
    const revision = await repository.adminRollbackPromptBundle(
      req.params.bundleId,
      typeof req.body?.activated_by === 'string' ? req.body.activated_by : 'admin',
    );
    res.json({ revision });
  }));

  app.get('/api/v1/admin/jobs/dead', asyncHandler(async (_req, res) => {
    res.json({ jobs: await repository.adminListDeadJobs() });
  }));

  app.post('/api/v1/admin/jobs/:jobId/retry', asyncHandler(async (req, res) => {
    const job = await repository.adminRetryJob(req.params.jobId);
    res.json({ job });
  }));

  app.get('/api/v1/admin/observability/summary', asyncHandler(async (_req, res) => {
    res.json(await repository.adminObservabilitySummary());
  }));

  app.get('/api/v1/admin/observability/latency', asyncHandler(async (_req, res) => {
    res.json(await repository.adminLatencyBreakdown());
  }));

  if (config.nodeEnv === 'production') {
    const staticDir = path.resolve(process.cwd(), 'dist');
    const indexFile = path.join(staticDir, 'index.html');

    app.use(express.static(staticDir, {
      index: false,
      maxAge: '1y',
      immutable: true,
    }));

    app.get('*', (_req, res, next) => {
      if (!existsSync(indexFile)) {
        next();
        return;
      }
      res.sendFile(indexFile);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
