import { z } from 'zod';
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_NATS_PORT,
  DEFAULT_REDIS_PORT,
  DEFAULT_WEBSOCKIFY_PORT,
  DEFAULT_NAS_MOUNT,
} from '../constants.js';

export const LLMProviderConfig = z.object({
  id: z.string(),
  name: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type LLMProviderConfig = z.infer<typeof LLMProviderConfig>;

export const VNCEndpoint = z.object({
  host: z.string(),
  port: z.number().default(DEFAULT_WEBSOCKIFY_PORT),
  password: z.string().optional(),
  label: z.string(),
});
export type VNCEndpoint = z.infer<typeof VNCEndpoint>;

export const JarvisConfig = z.object({
  gateway: z.object({
    port: z.number().default(DEFAULT_GATEWAY_PORT),
    host: z.string().default('0.0.0.0'),
    authToken: z.string(),
  }),

  nats: z.object({
    url: z.string().default(`nats://localhost:${DEFAULT_NATS_PORT}`),
  }),

  redis: z.object({
    url: z.string().default(`redis://localhost:${DEFAULT_REDIS_PORT}`),
  }),

  nas: z.object({
    mountPath: z.string().default(DEFAULT_NAS_MOUNT),
  }),

  providers: z.record(LLMProviderConfig).default({}),

  vnc: z.object({
    endpoints: z.record(VNCEndpoint).default({}),
  }).default({}),

  agents: z.object({
    smith: z.object({
      defaultModel: z.string().default('anthropic/claude-sonnet-4-6'),
      maxConcurrency: z.number().default(3),
    }).default({}),
    johny: z.object({
      defaultModel: z.string().default('anthropic/claude-sonnet-4-6'),
      maxConcurrency: z.number().default(3),
    }).default({}),
  }).default({}),
});
export type JarvisConfig = z.infer<typeof JarvisConfig>;
