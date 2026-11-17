import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import MacFolderPicker from './MacFolderPicker.svelte';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('browses Mac folders and selects their server path instead of a phone file', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            url.includes('path=')
              ? {
                  path: '/Users/example/Projects',
                  root: '/Users/example',
                  parent: '/Users/example',
                  folders: [],
                }
              : {
                  path: '/Users/example',
                  root: '/Users/example',
                  parent: '',
                  folders: [{ name: 'Projects', path: '/Users/example/Projects' }],
                },
          ),
        ),
    ),
  );
  const onSelect = vi.fn();
  const view = render(MacFolderPicker, { props: { onSelect } });
  expect(view.container.querySelector('input[type=file]')).toBeNull();
  await fireEvent.click(view.getByRole('button', { name: 'Browse Mac folders' }));
  await fireEvent.click(await view.findByRole('button', { name: 'Projects' }));
  await waitFor(() => expect(view.getByText('/Users/example/Projects')).toBeTruthy());
  await fireEvent.click(view.getByRole('button', { name: 'Choose this folder' }));
  expect(onSelect).toHaveBeenCalledWith('/Users/example/Projects');
});
