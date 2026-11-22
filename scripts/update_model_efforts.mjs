import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Official thinking levels per model ID, from the models.generated.js file
// shipped with Pi's pi-ai package. Each entry lists the Pi levels the model's
// own API accepts, the provider value for each, and whether it uses adaptive
// (effort-only) thinking.
const { MODELS } = await import(pathToFileURL(resolve(process.argv[2])));
const providers = [
  'anthropic', 'openai', 'google', 'deepseek', 'xai', 'moonshotai', 'kimi-coding',
  'mistral', 'minimax', 'zai', 'qwen-token-plan',
];
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const efforts = new Map();
for (const provider of providers) {
  for (const model of Object.values(MODELS[provider] ?? {})) {
    if (!model.reasoning || efforts.has(model.id)) continue;
    const map = model.thinkingLevelMap ?? {};
    const entry = {};
    for (const level of levels) {
      const mapped = map[level];
      if (mapped === null) continue;
      if ((level === 'xhigh' || level === 'max') && mapped === undefined) continue;
      entry[level] = mapped ?? level;
    }
    const value = { levels: entry };
    if (model.compat?.forceAdaptiveThinking) value.adaptive = true;
    efforts.set(model.id, value);
  }
}
// Official releases that can precede the bundled Pi catalog.
// https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-reasoningeffort
for (const id of ['gpt-6.2-astra', 'gpt-6.2-sol']) {
  const bundled = efforts.get(id);
  const fallback = { levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } };
  efforts.set(id, { ...(bundled ?? fallback), image: true });
}
const lines = [...efforts].sort(([a], [b]) => a.localeCompare(b, 'en'))
  .map(([id, value]) => `  ${JSON.stringify(id)}: ${JSON.stringify(value)}`);
process.stdout.write(`{\n${lines.join(',\n')}\n}\n`);
