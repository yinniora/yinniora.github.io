import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import OutputGallery from './OutputGallery.svelte';
afterEach(cleanup);
it('shows SVG, images, videos and audio inline through authenticated asset URLs', async () => {
  const assets = [
    {
      path: 'drawing.svg',
      name: 'drawing.svg',
      kind: 'svg',
      size: 100,
      modified: '2026-11-21T00:00:00Z',
    },
    { path: 'photo.png', name: 'photo.png', kind: 'image', size: 100 },
    { path: 'clip.mp4', name: 'clip.mp4', kind: 'video', size: 100 },
    { path: 'sound.mp3', name: 'sound.mp3', kind: 'audio', size: 100 },
    { path: 'read-only.svg', name: 'read-only.svg', kind: 'svg', size: 100 },
  ];
  const fetchImpl = vi.fn(async (url) =>
    url.startsWith('/api/assets?')
      ? Response.json({ assets })
      : new Response('<svg viewBox="0 0 10 10"></svg>'),
  );
  const model = {
    entries: [
      {
        id: 'inspection',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'read', id: 'r1', arguments: { path: 'read-only.svg' } },
          ],
        },
      },
      {
        id: 'reply',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: assets
                .slice(0, 4)
                .map(({ path }) => `[${path}](./${path})`)
                .join(' '),
            },
          ],
        },
      },
    ],
  };
  render(OutputGallery, { props: { sessionId: 'demo', model, fetchImpl } });
  await waitFor(() => expect(document.querySelectorAll('.output-card')).toHaveLength(4));
  await waitFor(() =>
    expect(document.querySelector('img.output-inline-preview')).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/svg\+xml/),
    ),
  );
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('video').hasAttribute('controls')).toBe(true);
  expect(document.querySelector('video').hasAttribute('playsinline')).toBe(true);
  expect(document.querySelector('video').getAttribute('src')).toContain('/api/asset?');
  expect(document.querySelector('audio')).not.toBeNull();
  expect(document.querySelector('.output-gallery')).not.toHaveTextContent('read-only.svg');

  const svg = document.querySelector('img.output-inline-preview');
  window.dispatchEvent(
    new CustomEvent('pi-session-entries-reconciled', { detail: { sessionId: 'demo' } }),
  );
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  expect(document.querySelector('img.output-inline-preview')).toBe(svg);
});
