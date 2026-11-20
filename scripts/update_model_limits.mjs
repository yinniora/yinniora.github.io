import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Pass the models.generated.js file shipped with Pi's pi-ai package.
const { MODELS } = await import(pathToFileURL(resolve(process.argv[2])));
const limits = new Map();
for (const provider of [
  'anthropic', 'openai', 'openai-codex', 'google', 'deepseek', 'xai',
  'moonshotai', 'kimi-coding', 'mistral', 'minimax', 'zai', 'meta', 'qwen-token-plan',
]) {
  for (const { id, contextWindow, maxTokens } of Object.values(MODELS[provider] ?? {})) {
    if (!limits.has(id) && contextWindow > 0 && maxTokens > 0) {
      limits.set(id, [contextWindow, maxTokens]);
    }
  }
}
const lines = [...limits].sort(([a], [b]) => a.localeCompare(b, 'en'))
  .map(([id, bounds]) => `  ${JSON.stringify(id)}: ${JSON.stringify(bounds)}`);
process.stdout.write(`{\n${lines.join(',\n')}\n}\n`);
