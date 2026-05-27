import { Character, DialogSession, Message } from '../types';

const SESSION_ID_KEY = 'personaPulse.sessionId';
const SESSION_SECRET_KEY = 'personaPulse.sessionSecret';

export interface BrowserSession {
  sessionId: string;
  sessionSecret: string;
}

export interface StreamEvent {
  event: string;
  data: unknown;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function readStoredSession(): BrowserSession | null {
  const sessionId = localStorage.getItem(SESSION_ID_KEY);
  const sessionSecret = localStorage.getItem(SESSION_SECRET_KEY);
  if (!sessionId || !sessionSecret) return null;
  return { sessionId, sessionSecret };
}

export function resetBrowserSession(): void {
  localStorage.removeItem(SESSION_ID_KEY);
  localStorage.removeItem(SESSION_SECRET_KEY);
}

export function isInvalidBrowserSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function writeStoredSession(session: BrowserSession): void {
  localStorage.setItem(SESSION_ID_KEY, session.sessionId);
  localStorage.setItem(SESSION_SECRET_KEY, session.sessionSecret);
}

async function createBrowserSession(): Promise<BrowserSession> {
  const response = await fetch('/api/v1/browser-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Version': 'personapulse-v1' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new ApiError(`Failed to create browser session: ${response.status}`, response.status);
  }
  const body = await response.json();
  const session = {
    sessionId: body.session_id,
    sessionSecret: body.session_secret,
  };
  writeStoredSession(session);
  return session;
}

async function verifyBrowserSession(session: BrowserSession): Promise<boolean> {
  const response = await fetch('/api/v1/browser-sessions/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: session.sessionId,
      session_secret: session.sessionSecret,
    }),
  });
  if (!response.ok) {
    throw new ApiError(`Failed to verify browser session: ${response.status}`, response.status);
  }
  const body = await response.json();
  return body?.valid === true;
}

export async function ensureBrowserSession(forceNew = false): Promise<BrowserSession> {
  if (forceNew) resetBrowserSession();
  const stored = readStoredSession();
  if (stored) {
    if (await verifyBrowserSession(stored)) return stored;
    resetBrowserSession();
  }
  return createBrowserSession();
}

function authHeaders(session: BrowserSession): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Session-Id': session.sessionId,
    'X-Session-Secret': session.sessionSecret,
  };
}

async function requestJson<T>(session: BrowserSession, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(session),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error ?? `Request failed: ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

export async function listCharacters(session: BrowserSession): Promise<Character[]> {
  const body = await requestJson<{ characters: Character[] }>(session, '/api/v1/characters');
  return body.characters;
}

export async function listConversations(session: BrowserSession, characterId: string): Promise<DialogSession[]> {
  const body = await requestJson<{ conversations: Array<Omit<DialogSession, 'messages'>> }>(
    session,
    `/api/v1/characters/${encodeURIComponent(characterId)}/conversations`,
  );
  return body.conversations.map((conversation) => ({ ...conversation, messages: [] }));
}

export async function createConversation(session: BrowserSession, characterId: string, title: string): Promise<DialogSession> {
  const body = await requestJson<{ conversation: Omit<DialogSession, 'messages'> }>(
    session,
    `/api/v1/characters/${encodeURIComponent(characterId)}/conversations`,
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    },
  );
  return { ...body.conversation, messages: [] };
}

export async function deleteConversation(session: BrowserSession, conversationId: string): Promise<void> {
  const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    headers: authHeaders(session),
  });
  if (!response.ok) throw new Error(`Failed to delete conversation: ${response.status}`);
}

export async function listMessages(session: BrowserSession, conversationId: string): Promise<Message[]> {
  const body = await requestJson<{ messages: Message[] }>(
    session,
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`,
  );
  return body.messages;
}

export async function sendMessage(
  session: BrowserSession,
  conversationId: string,
  text: string,
  clientMessageId: string = crypto.randomUUID(),
): Promise<{ message: Message; event_id: string | null; status: string }> {
  return requestJson(session, `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      client_message_id: clientMessageId,
      text,
    }),
  });
}

export async function setActiveDialog(session: BrowserSession, characterId: string, conversationId: string, visibilityState: DocumentVisibilityState): Promise<void> {
  const response = await fetch('/api/v1/active-dialog', {
    method: 'PUT',
    headers: authHeaders(session),
    body: JSON.stringify({ character_id: characterId, conversation_id: conversationId, visibility_state: visibilityState }),
  });
  if (!response.ok) throw new Error(`Failed to set active dialog: ${response.status}`);
}

export async function heartbeatActiveDialog(session: BrowserSession): Promise<void> {
  const response = await fetch('/api/v1/active-dialog/heartbeat', {
    method: 'POST',
    headers: authHeaders(session),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Failed active dialog heartbeat: ${response.status}`);
}

export async function clearActiveDialog(session: BrowserSession): Promise<void> {
  await fetch('/api/v1/active-dialog', {
    method: 'DELETE',
    headers: authHeaders(session),
    keepalive: true,
  });
}

export async function streamConversation(
  session: BrowserSession,
  conversationId: string,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/stream`, {
    headers: authHeaders(session),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open conversation stream: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseEvent(raw);
      if (parsed) onEvent(parsed);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function parseSseEvent(raw: string): StreamEvent | null {
  const lines = raw.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event: '));
  const dataLine = lines.find((line) => line.startsWith('data: '));
  if (!eventLine || !dataLine) return null;
  return {
    event: eventLine.slice(7),
    data: JSON.parse(dataLine.slice(6)),
  };
}
