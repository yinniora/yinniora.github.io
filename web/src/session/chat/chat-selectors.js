import { getLocale } from '../../shared/i18n.js';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// https://openai.com/zh-Hans-CN/index/practical-guide-building-gpt-6/
const openAIThinkingLabelsZh = new Map([
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '极高'],
  ['max', 'Max'],
]);

export function isScopedModel(model) {
  return !!(model?.isScoped || model?.scoped || model?.scope);
}

export function groupModelsByProvider(models, filter = '') {
  const q = filter.trim().toLowerCase();
  const byProvider = Object.create(null);
  models.forEach((model) => {
    const provider = model.provider || 'unknown';
    if (!byProvider[provider]) byProvider[provider] = [];
    byProvider[provider].push(model);
  });
  if (q) {
    for (const [provider, group] of Object.entries(byProvider)) {
      if (
        provider.toLowerCase().includes(q) ||
        group.some(({ providerLabel }) => providerLabel?.toLowerCase().includes(q))
      )
        continue;
      const matches = group.filter(({ name, id, modelId }) =>
        `${name || ''} ${id || modelId || ''}`.toLowerCase().includes(q),
      );
      if (matches.length) byProvider[provider] = matches;
      else delete byProvider[provider];
    }
  }
  return byProvider;
}

export function findModel(models, provider, modelId) {
  return models.find(
    (model) =>
      (model.provider || '') === provider &&
      ((model.id || '') === modelId || (model.modelId || '') === modelId),
  );
}

export function detectCurrentModel(entries) {
  const modelChanges = entries.filter((entry) => entry.type === 'model_change');
  if (modelChanges.length > 0) {
    const latest = modelChanges[modelChanges.length - 1];
    return { provider: latest.provider || '', modelId: latest.modelId || '' };
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === 'message' &&
      entry.message &&
      entry.message.role === 'assistant' &&
      entry.message.model
    ) {
      return { provider: entry.message.provider || '', modelId: entry.message.model || '' };
    }
  }
  return { provider: '', modelId: '' };
}

export function supportedThinkingLevels(model, levels = THINKING_LEVELS) {
  if (!model) return levels.filter((level) => level !== 'max');
  if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.length)
    return model.thinkingLevels.filter((level) => levels.includes(level));
  if (!model.reasoning) return ['off'];
  const map = model.thinkingLevelMap || {};
  return levels.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export function thinkingLevelLabel(model, level) {
  const value = model?.thinkingLevelMap?.[level] ?? level;
  const id = model?.id || model?.modelId || '';
  if (getLocale() === 'zh' && (model?.provider === 'openai' || /^(gpt-|o[134](?:-|$))/i.test(id))) {
    return openAIThinkingLabelsZh.get(value) ?? value;
  }
  return value;
}

export function detectCurrentThinkingLevel(entries) {
  const changes = entries.filter((entry) => entry.type === 'thinking_level_change');
  const latest = changes[changes.length - 1];
  return latest?.thinkingLevel || '';
}

export function modelDisplayLabel(model, fallbackId = '') {
  const id = model?.name || model?.id || model?.modelId || fallbackId;
  return id + (model?.provider ? ' @ ' + (model.providerLabel || model.provider) : '');
}
