import { createClient } from '@supabase/supabase-js';
import { AppConfig } from '../config';
import { MediaRow } from '../domain';

export class StorageService {
  private readonly supabase;

  constructor(private readonly config: AppConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      db: {
        schema: config.supabaseSchema,
      },
    });
  }

  async createSignedUrl(media: MediaRow): Promise<string> {
    const { data, error } = await this.supabase
      .storage
      .from(media.storage_bucket)
      .createSignedUrl(media.storage_path, 60 * 10);

    if (error || !data?.signedUrl) {
      throw new Error(`Failed to create signed media URL: ${error?.message ?? 'unknown storage error'}`);
    }
    return data.signedUrl;
  }

  async verifyMediaBucket(): Promise<void> {
    const { data, error } = await this.supabase.storage.listBuckets();
    if (error) {
      throw new Error(`Unable to verify Supabase Storage buckets: ${error.message}`);
    }
    const bucket = data.find((item) => item.name === this.config.mediaBucket);
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
  }): Promise<{ bucket: string; path: string }> {
    const extension = input.mimeType === 'image/webp' ? 'webp' : 'png';
    const path = `${input.conversationId}/${input.eventId}-${Date.now()}.${extension}`;
    const { error } = await this.supabase
      .storage
      .from(this.config.mediaBucket)
      .upload(path, input.data, {
        contentType: input.mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Generated image upload failed: ${error.message}`);
    }

    return { bucket: this.config.mediaBucket, path };
  }
}
