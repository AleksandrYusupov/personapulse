import { AppConfig } from '../config';
import { MediaRow } from '../domain';

export class StorageService {
  constructor(private readonly config: AppConfig) {}

  async createSignedUrl(media: MediaRow): Promise<string> {
    return this.createSignedUrlForPath(media.storage_bucket, media.storage_path);
  }

  async createSignedUrlForPath(bucket: string, path: string): Promise<string> {
    const result = await this.requestStorageJson<{ signedURL?: string; signedUrl?: string }>(
      `/object/sign/${encodePath(bucket)}/${encodeObjectPath(path)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60 * 10 }),
      },
    );
    const signedPath = result.signedUrl ?? result.signedURL;
    if (!signedPath) throw new Error('Failed to create signed media URL: missing signed URL');
    return signedPath.startsWith('http') ? signedPath : `${this.config.supabaseUrl.replace(/\/$/, '')}/storage/v1${signedPath}`;
  }

  async verifyMediaBucket(): Promise<void> {
    const buckets = await this.requestStorageJson<Array<{ name: string; public: boolean }>>('/bucket');
    const bucket = buckets.find((item) => item.name === this.config.mediaBucket);
    if (!bucket) {
      throw new Error(`Required Supabase Storage bucket "${this.config.mediaBucket}" does not exist`);
    }
    if (bucket.public) {
      throw new Error(`Supabase Storage bucket "${this.config.mediaBucket}" must be private`);
    }
  }

  async uploadGeneratedImage(input: {
    conversationId: string;
    eventId: string;
    data: Buffer;
    mimeType: string;
    pathPrefix?: string;
  }): Promise<{ bucket: string; path: string }> {
    const extension = input.mimeType === 'image/webp' ? 'webp' : input.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const path = input.pathPrefix
      ? `${input.pathPrefix}.${extension}`
      : `${input.conversationId}/${input.eventId}-${Date.now()}.${extension}`;
    await this.requestStorage(`/object/${encodePath(this.config.mediaBucket)}/${encodeObjectPath(path)}`, {
      method: 'POST',
      headers: {
        'Content-Type': input.mimeType,
        'x-upsert': 'false',
      },
      body: input.data,
    });

    return { bucket: this.config.mediaBucket, path };
  }

  async findGeneratedImageForEvent(conversationId: string, eventId: string): Promise<{ bucket: string; path: string; mimeType: string } | null> {
    const folder = `generated/${conversationId}/${eventId}`;
    const data = await this.requestStorageJson<Array<{ id?: string | null; name: string; metadata?: Record<string, unknown> }>>(
      `/object/list/${encodePath(this.config.mediaBucket)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefix: folder,
          limit: 1,
          offset: 0,
          sortBy: { column: 'created_at', order: 'asc' },
        }),
      },
    );

    const file = data?.find((item) => item.name && item.id);
    if (!file) return null;

    const metadata = (file as any).metadata ?? {};
    return {
      bucket: this.config.mediaBucket,
      path: `${folder}/${file.name}`,
      mimeType: typeof metadata.mimetype === 'string' ? metadata.mimetype : inferMimeType(file.name),
    };
  }

  async downloadObject(bucket: string, path: string): Promise<{ data: Buffer; mimeType: string }> {
    const response = await this.requestStorage(`/object/${encodePath(bucket)}/${encodeObjectPath(path)}`, {
      method: 'GET',
    });
    const arrayBuffer = await response.arrayBuffer();
    return {
      data: Buffer.from(arrayBuffer),
      mimeType: response.headers.get('content-type') ?? inferMimeType(path),
    };
  }

  async downloadMedia(media: MediaRow): Promise<{ data: Buffer; mimeType: string }> {
    return this.downloadObject(media.storage_bucket, media.storage_path);
  }

  private async requestStorageJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestStorage(path, init);
    return response.json() as Promise<T>;
  }

  private async requestStorage(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.config.supabaseUrl.replace(/\/$/, '')}/storage/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.supabaseServiceRoleKey}`,
        apikey: this.config.supabaseServiceRoleKey,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Supabase Storage request failed ${response.status}: ${body.slice(0, 500)}`);
    }
    return response;
  }
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function encodeObjectPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function inferMimeType(path: string): string {
  const lowered = path.toLowerCase();
  if (lowered.endsWith('.jpg') || lowered.endsWith('.jpeg')) return 'image/jpeg';
  if (lowered.endsWith('.webp')) return 'image/webp';
  if (lowered.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}
