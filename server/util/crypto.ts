import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function newSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
