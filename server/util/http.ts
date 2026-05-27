import { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: T, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export function requireString(value: unknown, field: string, maxLength = 4000): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, `${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalString(value: unknown, field: string, maxLength = 4000): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, maxLength);
}
