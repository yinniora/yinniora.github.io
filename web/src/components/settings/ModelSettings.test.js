import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor, within } from '@testing-library/svelte';
import ModelSettings from './ModelSettings.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('shows the native effort protocol and saves only an available per-model default', async () => {
  const model = {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    api: 'anthropic-messages',
    reasoning: true,
    adaptiveThinking: true,
    contextWindow: 128000,
    maxTokens: 32000,
    defaultContextWindow: 1000000,
    defaultMaxTokens: 128000,
    thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' },
  };
  const profile = { id: 'fixture', label: 'Native', applied: [model], available: [model] };
  const requests = [];
  vi.stubGlobal('fetch', async (_url, options) => {
    if (options?.method === 'POST') {
      const request = JSON.parse(options.body);
      requests.push(request);
      model.defaultThinkingLevel = request.thinkingLevel;
    }
    return new Response(JSON.stringify({ profiles: [profile], revision: 'fixture' }));
  });

  const view = render(ModelSettings);
  await view.findByText(/· effort$/);
  await fireEvent.click(view.getByRole('button', { name: /Context limit.*Claude Opus/ }));
  const contextField = within(view.container.querySelector('.model-limit-form')).getByLabelText(
    'Context limit',
    { exact: true },
  );
  expect(contextField).toHaveValue('128K');
  await fireEvent.click(view.getByRole('button', { name: 'Default · 1M' }));
  expect(contextField).toHaveValue('1M');
  const select = view.getByRole('combobox', { name: /Adjustable reasoning effort.*Default/ });
  expect(Array.from(select.options, (option) => option.value)).toEqual([
    '',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  expect(Array.from(select.options, (option) => option.textContent)).toEqual([
    'Default',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  await fireEvent.change(select, { target: { value: 'high' } });
  await view.findByText(/Default high$/);
  expect(requests).toEqual([
    {
      action: 'edit-thinking-default',
      id: 'fixture',
      modelId: model.id,
      thinkingLevel: 'high',
      revision: 'fixture',
    },
  ]);
});

it('keeps keys out of browser storage, refreshes without applying, and applies multiple models explicitly', async () => {
  const profile = {
    id: 'key-one',
    label: 'Work key',
    baseUrl: 'https://example.invalid/v1',
    api: 'openai-completions',
    hasKey: true,
    available: [],
    applied: [],
  };
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body);
        calls.push(body);
        if (body.action === 'refresh')
          profile.available = [
            { id: 'one', name: 'Chat One', reasoning: true },
            { id: 'two', name: 'Chat Two', input: ['text', 'image'] },
          ];
        if (body.action === 'apply')
          profile.applied = profile.available.filter((m) => body.modelIds.includes(m.id));
        if (body.action === 'remove-model')
          profile.applied = profile.applied.filter((m) => m.id !== body.modelId);
      }
      return new Response(JSON.stringify({ profiles: [profile], revision: 'revision' }));
    }),
  );
  const view = render(ModelSettings);
  const refresh = await view.findByRole('button', { name: 'Refresh models' });
  expect(refresh.closest('.model-protocol')).toBeInTheDocument();
  expect(view.queryByRole('button', { name: 'Check API' })).not.toBeInTheDocument();
  await fireEvent.click(refresh);
  await view.findByText('Chat One');
  expect(calls.some((c) => c.action === 'apply')).toBe(false);
  expect(
    view.queryByRole('button', { name: 'Adjustable reasoning effort' }),
  ).not.toBeInTheDocument();
  await fireEvent.input(view.getByRole('searchbox', { name: 'Search models' }), {
    target: { value: 'Chat One' },
  });
  await fireEvent.click(view.getByRole('button', { name: 'Select search results' }));
  await fireEvent.click(view.getByRole('button', { name: 'Accepts images' }));
  await fireEvent.input(view.getByRole('searchbox', { name: 'Search models' }), {
    target: { value: ' two CHAT ' },
  });
  await fireEvent.click(view.getByRole('checkbox', { name: /Chat Two/ }));
  await fireEvent.click(view.getByRole('button', { name: 'Apply 2 selected models' }));
  await waitFor(() => expect(view.getByText('Applied models (2)')).toBeInTheDocument());
  const group = view.getByRole('region', { name: 'Work key' });
  expect(group.querySelectorAll('.model-applied-row')).toHaveLength(2);
  expect(calls.find((c) => c.action === 'apply').modelIds).toEqual(['one', 'two']);
  await fireEvent.click(view.getByRole('button', { name: 'Remove Chat One from Work key' }));
  await waitFor(() => expect(view.getByText('Applied models (1)')).toBeInTheDocument());
  expect(localStorage.length).toBe(0);
});

it('fills provider presets and saves a masked key without a browser sign-in form', async () => {
  const fetchImpl = vi.fn(
    async (_url, options) =>
      new Response(
        JSON.stringify({
          profiles:
            options?.method === 'POST'
              ? [{ id: 'new', label: 'Home', hasKey: true, available: [], applied: [] }]
              : [],
          revision: 'revision',
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchImpl);
  const view = render(ModelSettings);
  await view.findByText('No models applied yet.');
  await fireEvent.click(view.getByRole('button', { name: 'Add key' }));
  expect(view.getByLabelText('API base URL')).toHaveValue('https://api.openai.com/v1');
  const presets = view.getByRole('combobox', { name: 'Common API addresses' });
  expect(presets.selectedOptions[0]).toHaveTextContent('OpenAI');
  await fireEvent.change(presets, { target: { value: 'https://api.anthropic.com' } });
  expect(view.getByLabelText('API base URL')).toHaveValue('https://api.anthropic.com');
  expect(within(presets).getByRole('option', { name: 'Kimi · China' })).toHaveValue(
    'https://api.moonshot.cn/v1',
  );
  await fireEvent.input(view.getByLabelText('Key label'), { target: { value: 'Home' } });
  await fireEvent.input(view.getByLabelText('API base URL'), {
    target: { value: 'https://example.invalid/v1' },
  });
  expect(presets.selectedOptions[0]).toHaveTextContent('Custom address');
  const token = view.getByLabelText('API key');
  expect(token.tagName).toBe('TEXTAREA');
  expect(token.form).toBeNull();
  await fireEvent.input(token, {
    target: { value: 'fixture-secret-only' },
  });
  await fireEvent.keyDown(token, { key: 'Enter' });
  await view.findByText('Key saved. Refresh its models to choose what to apply.');
  expect(view.queryByLabelText('API key')).not.toBeInTheDocument();
  await fireEvent.click(view.getByRole('button', { name: 'Add key' }));
  expect(view.getByLabelText('API key').value).toBe('');
  expect(localStorage.length).toBe(0);
  expect(fetchImpl.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
  const [, options] = fetchImpl.mock.calls.find(([, opts]) => opts?.method === 'POST');
  expect(JSON.parse(options.body)).toMatchObject({
    baseUrl: 'https://example.invalid/v1',
    key: 'fixture-secret-only',
  });
});
