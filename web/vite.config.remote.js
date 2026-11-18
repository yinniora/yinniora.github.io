import { licenseInventory } from './license-inventory.js';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte(), licenseInventory()],
  base: '/',
  build: {
    outDir: 'dist-remote',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: 'remote-index.html' },
  },
});
