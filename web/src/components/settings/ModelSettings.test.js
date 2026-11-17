import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/svelte';
import ModelSettings from './ModelSettings.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
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
