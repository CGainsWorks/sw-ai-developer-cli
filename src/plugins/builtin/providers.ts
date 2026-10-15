/**
 * Registers the two shipped providers.
 *
 * They are contributed through the same `providers` array a third-party plugin
 * would use, so "add another provider" never requires a kernel change.
 */
import { compatProviderFactory } from '../../providers/compatible.js';
import { openaiProviderFactory } from '../../providers/openai.js';
import { definePlugin, PLUGIN_API_VERSION } from '../api.js';

export default definePlugin({
  name: 'providers',
  apiVersion: PLUGIN_API_VERSION,
  description: 'Provides the openai and compat (OpenAI-compatible) model providers.',
  providers: [openaiProviderFactory, compatProviderFactory],
});
