import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ImageMcpContext {
  event_id: string;
  conversation_id: string;
  character_id: string;
  exp: number;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function signImageMcpContext(context: ImageMcpContext, secret: string): { encoded: string; signature: string } {
  const encoded = encodeBase64Url(JSON.stringify(context));
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return { encoded, signature };
}

export function verifyImageMcpContext(encoded: string | undefined, signature: string | undefined, secret: string): ImageMcpContext {
  if (!encoded || !signature) {
    throw new Error('Missing image MCP context signature');
  }

  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new Error('Invalid image MCP context signature');
  }

  const parsed = JSON.parse(decodeBase64Url(encoded)) as Partial<ImageMcpContext>;
  if (!parsed.event_id || !parsed.conversation_id || !parsed.character_id || typeof parsed.exp !== 'number') {
    throw new Error('Invalid image MCP context payload');
  }
  if (parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Expired image MCP context payload');
  }
  return parsed as ImageMcpContext;
}
