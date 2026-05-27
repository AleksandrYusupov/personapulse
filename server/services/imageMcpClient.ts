import { GoogleAuth } from 'google-auth-library';
import { mcpToTool } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppConfig } from '../config';
import { TimelineEventRow } from '../domain';
import { signImageMcpContext } from '../util/signedContext';

export interface ImageMcpToolSession {
  tools: unknown[];
  close: () => Promise<void>;
}

const googleAuth = new GoogleAuth();

export async function createImageMcpToolSession(config: AppConfig, event: TimelineEventRow): Promise<ImageMcpToolSession | null> {
  if (!config.imageMcpUrl || !config.imageMcpContextSigningSecret) {
    return null;
  }

  const context = signImageMcpContext(
    {
      event_id: event.id,
      conversation_id: event.conversation_id,
      character_id: event.character_id,
      exp: Math.floor(Date.now() / 1000) + 10 * 60,
    },
    config.imageMcpContextSigningSecret,
  );

  const headers: Record<string, string> = {
    'X-PersonaPulse-Context': context.encoded,
    'X-PersonaPulse-Signature': context.signature,
  };
  if (config.imageMcpLocalBearerToken && !config.imageMcpAudience) {
    headers.Authorization = `Bearer ${config.imageMcpLocalBearerToken}`;
  }

  const client = new Client({
    name: 'personapulse-character-agent',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.imageMcpUrl), {
    requestInit: { headers },
    fetch: createImageMcpFetch(config),
  });

  await client.connect(transport);

  return {
    tools: [mcpToTool(client) as unknown],
    close: async () => {
      try {
        await transport.terminateSession();
      } catch (_) {
        // Stateless servers can reject DELETE; closing the client is enough.
      }
      await client.close();
    },
  };
}

function createImageMcpFetch(config: AppConfig): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization') && config.imageMcpAudience) {
      const idTokenClient = await googleAuth.getIdTokenClient(config.imageMcpAudience);
      const token = await idTokenClient.idTokenProvider.fetchIdToken(config.imageMcpAudience);
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  };
}
