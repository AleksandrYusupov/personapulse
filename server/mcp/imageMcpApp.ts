import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { AppConfig } from '../config';
import { GeminiService } from '../services/gemini';
import { Repository } from '../services/repository';
import { StorageService } from '../services/storage';
import { verifyImageMcpContext } from '../util/signedContext';

const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const IMAGE_WIDTH = 896;
const IMAGE_HEIGHT = 1200;

const imageToolInput = {
  description: z.string().min(1).max(4000),
  include_agent_character: z.boolean(),
};

const imageToolOutput = {
  ok: z.boolean(),
  image_url: z.string().optional(),
  storage_bucket: z.string().optional(),
  storage_path: z.string().optional(),
  mime_type: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  alt_text: z.string().optional(),
  generation_prompt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  error_code: z.string().optional(),
  recoverable: z.boolean().optional(),
};

export function createImageMcpApp(
  config: AppConfig,
  repository: Repository,
  storage: StorageService,
  gemini: GeminiService,
) {
  if (!config.imageMcpContextSigningSecret) {
    throw new Error('IMAGE_MCP_CONTEXT_SIGNING_SECRET is required for PROCESS_ROLE=image-mcp');
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const service = new ImageMcpGenerationService(config, repository, storage, gemini);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'personapulse-image-mcp' });
  });

  app.all('/mcp', async (req, res) => {
    if (config.imageMcpLocalBearerToken) {
      const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
      if (token !== config.imageMcpLocalBearerToken) {
        res.status(401).json({ error: 'Invalid MCP bearer token' });
        return;
      }
    }

    try {
      const server = createMcpServer(service);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('image MCP request failed', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Image MCP request failed' });
      }
    }
  });

  return app;
}

function createMcpServer(service: ImageMcpGenerationService) {
  const server = new McpServer({
    name: 'personapulse-image-mcp',
    version: '1.0.0',
  });

  server.registerTool(
    'generate_personapulse_image',
    {
      title: 'Generate PersonaPulse Image',
      description:
        'Generate one PersonaPulse chat image from a visual description. Use include_agent_character=true only when the current persona character should visibly appear.',
      inputSchema: imageToolInput,
      outputSchema: imageToolOutput,
    },
    async (args, extra) => {
      const result = await service.generate(args, headerValue(extra.requestInfo?.headers, 'x-personapulse-context'), headerValue(extra.requestInfo?.headers, 'x-personapulse-signature'));
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

class ImageMcpGenerationService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: Repository,
    private readonly storage: StorageService,
    private readonly gemini: GeminiService,
  ) {}

  async generate(
    args: { description: string; include_agent_character: boolean },
    encodedContext: string | undefined,
    signature: string | undefined,
  ): Promise<Record<string, unknown>> {
    const context = verifyImageMcpContext(encodedContext, signature, this.config.imageMcpContextSigningSecret!);

    try {
      const character = await this.repository.requireCharacterById(context.character_id);
      const parts: unknown[] = [];
      if (args.include_agent_character) {
        if (!character.avatar_storage_path) {
          return recoverable('character_reference_missing');
        }
        const reference = await this.storage.downloadObject(this.config.mediaBucket, character.avatar_storage_path);
        parts.push({
          inlineData: {
            mimeType: reference.mimeType,
            data: reference.data.toString('base64'),
          },
        });
      }

      const prompt = buildImagePrompt(args.description, args.include_agent_character, character.name);
      parts.push({ text: prompt });

      const generated = await this.gemini.generateImage({
        model: IMAGE_MODEL,
        prompt,
        parts,
        aspectRatio: '3:4',
        imageSize: '1K',
      });

      const uploaded = await this.storage.uploadGeneratedImage({
        conversationId: context.conversation_id,
        eventId: context.event_id,
        data: generated.data,
        mimeType: generated.mimeType,
        pathPrefix: `generated/${context.conversation_id}/${context.event_id}/${randomUUID()}`,
      });
      const imageUrl = await this.storage.createSignedUrlForPath(uploaded.bucket, uploaded.path);
      const altText = buildAltText(args.description, character.name, args.include_agent_character);

      return {
        ok: true,
        image_url: imageUrl,
        storage_bucket: uploaded.bucket,
        storage_path: uploaded.path,
        mime_type: generated.mimeType,
        width: IMAGE_WIDTH,
        height: IMAGE_HEIGHT,
        alt_text: altText,
        generation_prompt: prompt,
        provider: 'gemini',
        model: IMAGE_MODEL,
      };
    } catch (error) {
      console.error('image MCP generation failed', {
        event_id: context.event_id,
        conversation_id: context.conversation_id,
        character_id: context.character_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return recoverable('image_generation_failed');
    }
  }
}

function buildImagePrompt(description: string, includeCharacter: boolean, characterName: string): string {
  const lines = [
    `Generate a single image from the following description: ${description.trim()}`,
    'Output exactly one image.',
    'Use a vertical 3:4 composition at 1K quality.',
    'Do not add captions, watermarks, UI frames, signatures, or visible text unless the description explicitly asks for text.',
    'Keep the result suitable as an in-chat roleplay media attachment.',
  ];

  if (includeCharacter) {
    lines.push(
      `The attached reference image shows ${characterName}, the persona character who must appear in the generated image.`,
      `Keep ${characterName} recognizably the same individual: preserve core facial structure, silhouette, identity, and overall visual design.`,
      'Clothing, pose, expression, lighting, environment, and emotional state may change if the scene requires it, but identity consistency is mandatory.',
    );
  } else {
    lines.push(
      `Do not include ${characterName}, the persona character, unless the description itself explicitly requires that character to appear.`,
    );
  }

  return lines.join('\n');
}

function buildAltText(description: string, characterName: string, includeCharacter: boolean): string {
  const compact = description.trim().replace(/\s+/g, ' ').slice(0, 180);
  return includeCharacter ? `${characterName} in generated scene: ${compact}` : `Generated scene: ${compact}`;
}

function recoverable(errorCode: string): Record<string, unknown> {
  return {
    ok: false,
    error_code: errorCode,
    recoverable: true,
  };
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return typeof direct === 'string' ? direct : undefined;
}
