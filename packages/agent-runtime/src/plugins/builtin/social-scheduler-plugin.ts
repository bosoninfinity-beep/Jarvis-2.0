/**
 * Social Scheduler Plugin — Background auto-publisher for scheduled posts.
 *
 * Runs the ScheduledPostExecutor in the background, checking every 60s
 * for posts that are due for publishing. Works with the social_schedule
 * tool that stores scheduled posts in NAS config.
 *
 * Services:
 * - social-scheduler: Background service that publishes due posts
 *
 * Only activates when socialConfig is present in runtime config.
 */

import { ScheduledPostExecutor, type SocialToolConfig } from '@jarvis/tools';
import type { JarvisPluginDefinition } from '../types.js';

const CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds

export function createSocialSchedulerPlugin(): JarvisPluginDefinition {
  return {
    id: 'social-scheduler',
    name: 'Social Media Scheduler',
    description: 'Automatically publishes scheduled social media posts when their time arrives',
    version: '1.0.0',

    register(api) {
      // Only activate if social media is configured
      if (!api.config.socialConfig) {
        api.logger.debug('Social scheduler skipped (no social config)');
        return;
      }

      const socialConfig = api.config.socialConfig as SocialToolConfig;

      api.registerService({
        name: 'social-scheduler',
        start: async () => {
          const executor = new ScheduledPostExecutor(
            socialConfig,
            api.config.nasPath,
            CHECK_INTERVAL_MS,
          );

          executor.start();
          api.logger.info('Scheduled post executor started (checking every 60s)');

          // Return stop function for graceful shutdown
          return () => {
            executor.stop();
            api.logger.info('Scheduled post executor stopped');
          };
        },
      });

      // Add context to the agent's system prompt so it knows about auto-publishing
      api.registerPromptSection({
        title: 'Social Media Scheduling',
        content: [
          'Scheduled social media posts are automatically published when their scheduled time arrives.',
          'Use `social_schedule` tool with action "schedule" to queue posts for future publishing.',
          'Use `social_schedule` with action "list" to see upcoming scheduled posts.',
          'The scheduler checks for due posts every 60 seconds in the background.',
          'You ARE the content writer — write posts directly with platform constraints in mind (Twitter 280 chars, Instagram 2200, LinkedIn 3000, TikTok 2200).',
        ].join('\n'),
        priority: 5,
      });

      api.logger.info('Social scheduler plugin registered');
    },
  };
}
