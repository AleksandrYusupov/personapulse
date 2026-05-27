import { GoogleGenAI } from '@google/genai';
import { AppConfig } from '../config';

export class GeminiService {
  private readonly ai: GoogleGenAI;

  constructor(config: AppConfig) {
    this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  async generateJson(input: {
    model: string;
    systemInstruction: string;
    prompt: string;
    responseSchema: unknown;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<unknown> {
    return this.withRetries(async () => {
      const response = await this.ai.models.generateContent({
        model: input.model,
        contents: input.prompt,
        config: {
          systemInstruction: input.systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema: input.responseSchema,
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error('Gemini returned an empty JSON response');
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`Gemini returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  async generateImage(input: {
    model: string;
    prompt: string;
  }): Promise<{ data: Buffer; mimeType: string }> {
    return this.withRetries(async () => {
      const response = await this.ai.models.generateContent({
        model: input.model,
        contents: input.prompt,
        config: {
          responseModalities: ['IMAGE'] as any,
        },
      });

      const candidates = (response as any).candidates ?? [];
      for (const candidate of candidates) {
        for (const part of candidate.content?.parts ?? []) {
          const inlineData = part.inlineData ?? part.inline_data;
          if (inlineData?.data) {
            return {
              data: Buffer.from(inlineData.data, 'base64'),
              mimeType: inlineData.mimeType ?? inlineData.mime_type ?? 'image/png',
            };
          }
        }
      }

      throw new Error('Gemini image generation returned no image data');
    });
  }

  private async withRetries<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const backoffMs = [0, 2000, 8000];
    for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
      if (backoffMs[attempt] > 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, backoffMs[attempt]));
      }
      try {
        return await operation();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
