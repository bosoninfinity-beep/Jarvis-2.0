/**
 * Media Generation Tool v4 — Images, Videos, Voice via external APIs.
 *
 * Supports:
 * - Flux Pro (fal.ai) — fast, high-quality images
 * - Kling 3.0 — AI video generation
 * - ElevenLabs — voice synthesis / text-to-speech
 * - HeyGen — avatar talking-head videos
 *
 * Each provider is called via its REST API. The tool saves output to NAS
 * and returns the file path + metadata.
 */

import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const log = createLogger('tools:media-gen');

export interface MediaGenConfig {
  readonly fluxApiKey?: string;
  readonly klingApiKey?: string;
  readonly elevenLabsApiKey?: string;
  readonly heygenApiKey?: string;
  readonly runwayApiKey?: string;
  readonly nasPath?: string;
}

export class MediaGenTool implements AgentTool {
  constructor(private config: MediaGenConfig) {}

  definition = {
    name: 'media_generate',
    description:
      'Generate media assets using AI APIs. Supports: image (Flux Pro), video (Kling 3.0), voice (ElevenLabs), avatar (HeyGen). ' +
      'Returns file path on NAS and metadata. Use for social media visuals, ads, product demos, voiceovers.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['image', 'video', 'voice', 'avatar'],
          description: 'Type of media to generate',
        },
        prompt: {
          type: 'string',
          description: 'Generation prompt. For images: detailed visual description. For video: scene description. For voice: text to speak. For avatar: script.',
        },
        product: {
          type: 'string',
          enum: ['okidooki', 'nowtrust', 'makeitfun'],
          description: 'Product this media is for (used for file organization)',
        },
        style: {
          type: 'string',
          description: 'Style hint: product_shot, social_graphic, ad, cinematic, voiceover, explainer',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3'],
          description: 'Aspect ratio. 1:1 (square/social), 16:9 (landscape/YouTube), 9:16 (vertical/TikTok/Reels), 4:3 (presentation). Default: 1:1',
        },
        voice_id: {
          type: 'string',
          description: 'ElevenLabs voice ID (for voice/avatar type). Default: Rachel (21m00Tcm4TlvDq8ikWAM)',
        },
        duration: {
          type: 'number',
          description: 'Target duration in seconds (for video/avatar). Default: 10',
        },
        filename: {
          type: 'string',
          description: 'Output filename (without extension). Auto-generated if not provided.',
        },
      },
      required: ['type', 'prompt'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const type = params['type'] as string;
    const prompt = params['prompt'] as string;
    if (!prompt) return createErrorResult('Missing required parameter: prompt');

    const product = (params['product'] as string) ?? 'general';
    const style = (params['style'] as string) ?? type;
    const aspectRatio = (params['aspect_ratio'] as string) ?? '1:1';
    const voiceId = (params['voice_id'] as string) ?? '21m00Tcm4TlvDq8ikWAM';
    const duration = (params['duration'] as number) ?? 10;
    const filename = (params['filename'] as string) ?? `${product}-${style}-${Date.now()}`;
    const nasPath = this.config.nasPath ?? context.nasPath ?? '/tmp';

    switch (type) {
      case 'image': return this.generateImage(prompt, product, aspectRatio, filename, nasPath);
      case 'video': return this.generateVideo(prompt, product, aspectRatio, duration, filename, nasPath);
      case 'voice': return this.generateVoice(prompt, product, voiceId, filename, nasPath);
      case 'avatar': return this.generateAvatar(prompt, product, voiceId, duration, filename, nasPath);
      default: return createErrorResult(`Unknown media type: ${type}`);
    }
  }

  // ── Image: Flux Pro via fal.ai ──

  private async generateImage(
    prompt: string, product: string, aspectRatio: string, filename: string, nasPath: string,
  ): Promise<ToolResult> {
    if (!this.config.fluxApiKey) {
      return createErrorResult('FLUX_API_KEY not configured. Add it to .env to generate images with Flux Pro.');
    }

    const sizeMap: Record<string, { width: number; height: number }> = {
      '1:1': { width: 1024, height: 1024 },
      '16:9': { width: 1536, height: 1024 },
      '9:16': { width: 1024, height: 1536 },
      '4:3': { width: 1024, height: 768 },
    };
    const size = sizeMap[aspectRatio] ?? sizeMap['1:1']!;

    log.info(`Generating image via Flux Pro: "${prompt.slice(0, 60)}..." (${size.width}x${size.height})`);

    try {
      // fal.ai Flux Pro endpoint
      const response = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1.1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${this.config.fluxApiKey}`,
        },
        body: JSON.stringify({
          prompt,
          image_size: { width: size.width, height: size.height },
          num_images: 1,
          safety_tolerance: '5',
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Flux API error (${response.status}): ${err}`);
      }

      const data = await response.json() as { images?: Array<{ url?: string }>; request_id?: string };

      // fal.ai returns a queue — if we get a request_id, poll for result
      if (data.request_id && !data.images?.length) {
        return this.pollFalResult(data.request_id, product, filename, nasPath);
      }

      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) return createErrorResult('No image URL returned from Flux API');

      // Download and save
      const savePath = join(nasPath, 'media', 'images', product, `${filename}.png`);
      await this.downloadAndSave(imageUrl, savePath);

      return createToolResult(
        `Image generated via Flux Pro\nSaved: ${savePath}\nSize: ${size.width}x${size.height}`,
        { path: savePath, tool: 'flux', width: size.width, height: size.height },
      );
    } catch (err) {
      return createErrorResult(`Flux image generation failed: ${(err as Error).message}`);
    }
  }

  private async pollFalResult(requestId: string, product: string, filename: string, nasPath: string): Promise<ToolResult> {
    // Poll fal.ai queue for completion (max 60s)
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      try {
        const statusRes = await fetch(`https://queue.fal.run/fal-ai/flux-pro/v1.1/requests/${requestId}/status`, {
          headers: { 'Authorization': `Key ${this.config.fluxApiKey}` },
        });
        const status = await statusRes.json() as { status?: string };
        if (status.status === 'COMPLETED') {
          const resultRes = await fetch(`https://queue.fal.run/fal-ai/flux-pro/v1.1/requests/${requestId}`, {
            headers: { 'Authorization': `Key ${this.config.fluxApiKey}` },
          });
          const result = await resultRes.json() as { images?: Array<{ url?: string }> };
          const imageUrl = result.images?.[0]?.url;
          if (!imageUrl) return createErrorResult('No image in completed result');

          const savePath = join(nasPath, 'media', 'images', product, `${filename}.png`);
          await this.downloadAndSave(imageUrl, savePath);
          return createToolResult(`Image generated via Flux Pro\nSaved: ${savePath}`, { path: savePath, tool: 'flux' });
        }
        if (status.status === 'FAILED') return createErrorResult('Flux generation failed in queue');
      } catch { /* retry */ }
    }
    return createErrorResult('Flux generation timed out (60s)');
  }

  // ── Video: Kling 3.0 ──

  private async generateVideo(
    prompt: string, product: string, aspectRatio: string, duration: number, filename: string, nasPath: string,
  ): Promise<ToolResult> {
    if (!this.config.klingApiKey) {
      return createErrorResult('KLING_API_KEY not configured. Add it to .env to generate videos with Kling 3.0.');
    }

    log.info(`Generating video via Kling 3.0: "${prompt.slice(0, 60)}..." (${duration}s, ${aspectRatio})`);

    try {
      const response = await fetch('https://api.klingai.com/v1/videos/text2video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.klingApiKey}`,
        },
        body: JSON.stringify({
          prompt,
          duration: String(Math.min(duration, 10)),
          aspect_ratio: aspectRatio,
          model: 'kling-v1',
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Kling API error (${response.status}): ${err}`);
      }

      const data = await response.json() as { data?: { task_id?: string; video_url?: string } };

      const savePath = join(nasPath, 'media', 'videos', product, `${filename}.mp4`);

      // If async task, poll for completion (like Flux)
      if (data.data?.task_id && !data.data.video_url) {
        return this.pollKlingResult(data.data.task_id, savePath, duration);
      }

      if (data.data?.video_url) {
        await this.downloadAndSave(data.data.video_url, savePath);
        return createToolResult(
          `Video generated via Kling 3.0\nSaved: ${savePath}\nDuration: ${duration}s`,
          { path: savePath, tool: 'kling', duration },
        );
      }

      return createErrorResult('Unexpected Kling API response');
    } catch (err) {
      return createErrorResult(`Kling video generation failed: ${(err as Error).message}`);
    }
  }

  // ── Voice: ElevenLabs ──

  private async generateVoice(
    text: string, product: string, voiceId: string, filename: string, nasPath: string,
  ): Promise<ToolResult> {
    if (!this.config.elevenLabsApiKey) {
      return createErrorResult('ELEVENLABS_API_KEY not configured. Add it to .env to generate voice with ElevenLabs.');
    }

    log.info(`Generating voice via ElevenLabs: "${text.slice(0, 60)}..." (voice: ${voiceId})`);

    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.config.elevenLabsApiKey,
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.5,
            use_speaker_boost: true,
          },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`ElevenLabs API error (${response.status}): ${err}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const savePath = join(nasPath, 'media', 'audio', product, `${filename}.mp3`);
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, buffer);

      const durationEstimate = Math.round(text.length / 15); // ~15 chars/sec estimate
      return createToolResult(
        `Voice generated via ElevenLabs\nSaved: ${savePath}\nSize: ${buffer.length} bytes\nEstimated duration: ~${durationEstimate}s`,
        { path: savePath, tool: 'elevenlabs', bytes: buffer.length, voiceId },
      );
    } catch (err) {
      return createErrorResult(`ElevenLabs voice generation failed: ${(err as Error).message}`);
    }
  }

  // ── Avatar: HeyGen ──

  private async generateAvatar(
    script: string, product: string, voiceId: string, duration: number, filename: string, nasPath: string,
  ): Promise<ToolResult> {
    if (!this.config.heygenApiKey) {
      return createErrorResult('HEYGEN_API_KEY not configured. Add it to .env to generate avatar videos with HeyGen.');
    }

    log.info(`Generating avatar video via HeyGen: "${script.slice(0, 60)}..."`);

    try {
      const response = await fetch('https://api.heygen.com/v2/video/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.config.heygenApiKey,
        },
        body: JSON.stringify({
          video_inputs: [{
            character: {
              type: 'avatar',
              avatar_id: 'default',
              avatar_style: 'normal',
            },
            voice: {
              type: 'text',
              input_text: script,
              voice_id: voiceId,
            },
          }],
          dimension: { width: 1080, height: 1920 },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`HeyGen API error (${response.status}): ${err}`);
      }

      const data = await response.json() as { data?: { video_id?: string } };
      const videoId = data.data?.video_id;
      if (!videoId) return createErrorResult('HeyGen did not return a video_id');

      const savePath = join(nasPath, 'media', 'videos', product, `${filename}.mp4`);
      return this.pollHeyGenResult(videoId, savePath);
    } catch (err) {
      return createErrorResult(`HeyGen avatar generation failed: ${(err as Error).message}`);
    }
  }

  // ── Polling ──

  private async pollKlingResult(taskId: string, savePath: string, duration: number): Promise<ToolResult> {
    const maxAttempts = 60; // 2 min max (video gen is slower than images)
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          headers: { 'Authorization': `Bearer ${this.config.klingApiKey}` },
        });
        const status = await res.json() as { data?: { status?: string; video_url?: string } };
        if (status.data?.status === 'completed' && status.data.video_url) {
          await this.downloadAndSave(status.data.video_url, savePath);
          return createToolResult(
            `Video generated via Kling 3.0\nSaved: ${savePath}\nDuration: ${duration}s`,
            { path: savePath, tool: 'kling', duration },
          );
        }
        if (status.data?.status === 'failed') {
          return createErrorResult('Kling video generation failed');
        }
      } catch { /* retry */ }
    }
    return createErrorResult(`Kling video generation timed out (120s). Task ID: ${taskId}`);
  }

  private async pollHeyGenResult(videoId: string, savePath: string): Promise<ToolResult> {
    const maxAttempts = 90; // 3 min max (avatar gen is slowest)
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
          headers: { 'X-Api-Key': this.config.heygenApiKey! },
        });
        const data = await res.json() as { data?: { status?: string; video_url?: string } };
        if (data.data?.status === 'completed' && data.data.video_url) {
          await this.downloadAndSave(data.data.video_url, savePath);
          return createToolResult(
            `Avatar video generated via HeyGen\nSaved: ${savePath}`,
            { path: savePath, tool: 'heygen', videoId },
          );
        }
        if (data.data?.status === 'failed') {
          return createErrorResult(`HeyGen avatar generation failed (video_id: ${videoId})`);
        }
      } catch { /* retry */ }
    }
    return createErrorResult(`HeyGen avatar generation timed out (180s). Video ID: ${videoId}`);
  }

  // ── Helpers ──

  private async downloadAndSave(url: string, savePath: string): Promise<void> {
    await mkdir(dirname(savePath), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(savePath, buffer);
    log.info(`Saved ${buffer.length} bytes to ${savePath}`);
  }
}
