import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/svelte';
import HomeProject from './HomeProject.svelte';
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('actually removes collapsed conversations and persists the choice; provides project actions', async () => {
  const onNewSession = vi.fn(),
    onDeleteProject = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessions: [{ id: 'a.jsonl', name: 'A conversation', project: '/work/demo' }],
            total: 1,
          }),
        ),
    ),
  );
  const project = { path: '/work/demo', sessionCount: 1 };
  const view = render(HomeProject, { project, onNewSession, onDeleteProject });
  await view.findByText('A conversation');
  const toggle = view.getByRole('button', { name: /demo.*1 session/ });
  await fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByText('A conversation')).toBeNull();
  expect(JSON.parse(localStorage.getItem('pi-sessions:collapsed-projects'))['/work/demo']).toBe(1);
  await fireEvent.click(toggle);
  await view.findByText('A conversation');
  await fireEvent.click(view.getByRole('button', { name: 'New conversation in demo' }));
  expect(onNewSession).toHaveBeenCalledWith('/work/demo');
  await fireEvent.click(view.getByText('Delete project'));
  expect(onDeleteProject).toHaveBeenCalledWith(project);
});
it('loads missing conversations per project and ignores a response after collapse', async () => {
  let complete;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const view = render(HomeProject, { project: { path: '/work/empty', sessionCount: 1 } });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await fireEvent.click(view.getByRole('button', { name: /empty.*1 session/ }));
  complete(
    new Response(
      JSON.stringify({ sessions: [{ id: 'b.jsonl', name: 'Hidden conversation' }], total: 1 }),
    ),
  );
  await waitFor(() => expect(view.queryByText('Hidden conversation')).toBeNull());
});
