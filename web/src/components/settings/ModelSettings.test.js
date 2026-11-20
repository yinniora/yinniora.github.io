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
            { id: 'one', name: 'Chat One' },
            { id: 'two', name: 'Chat Two' },
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
  await fireEvent.click(await view.findByRole('button', { name: 'Refresh models' }));
  await view.findByText('Chat One');
  expect(calls.some((c) => c.action === 'apply')).toBe(false);
  await fireEvent.click(view.getByRole('checkbox', { name: /Chat One/ }));
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

it('sends a newly entered key once and clears the form after saving', async () => {
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
  await fireEvent.input(view.getByLabelText('Key label'), { target: { value: 'Home' } });
  await fireEvent.input(view.getByLabelText('API base URL'), {
    target: { value: 'https://example.invalid/v1' },
  });
  await fireEvent.input(view.getByLabelText('API key'), {
    target: { value: 'fixture-secret-only' },
  });
  await fireEvent.click(view.getByRole('button', { name: 'Save key' }));
  await view.findByText('Key saved. Refresh its models to choose what to apply.');
  expect(view.queryByLabelText('API key')).not.toBeInTheDocument();
  await fireEvent.click(view.getByRole('button', { name: 'Add key' }));
  expect(view.getByLabelText('API key').value).toBe('');
  expect(localStorage.length).toBe(0);
  expect(fetchImpl.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
});
