import { afterEach, expect, it } from 'vitest';
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
      content: '<svg viewBox="0 0 10 10"></svg>',
    },
    { path: 'photo.png', name: 'photo.png', kind: 'image', size: 100 },
    { path: 'clip.mp4', name: 'clip.mp4', kind: 'video', size: 100 },
    { path: 'sound.mp3', name: 'sound.mp3', kind: 'audio', size: 100 },
  ];
  render(OutputGallery, {
    props: {
      sessionId: 'demo',
      model: { entries: [] },
      fetchImpl: async (url) =>
        new Response(
          url.startsWith('/api/assets?')
            ? JSON.stringify({ assets })
            : '<svg viewBox="0 0 10 10"></svg>',
        ),
    },
  });
  await waitFor(() => expect(document.querySelectorAll('.output-card')).toHaveLength(4));
  const svg = document.querySelector('img.output-inline-preview');
  expect(svg.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('video').hasAttribute('controls')).toBe(true);
  expect(document.querySelector('video').hasAttribute('playsinline')).toBe(true);
  expect(document.querySelector('video').getAttribute('src')).toContain('/api/asset?');
  expect(document.querySelector('audio')).not.toBeNull();
});
