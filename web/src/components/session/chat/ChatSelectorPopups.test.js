import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { t } from '../../../shared/i18n.js';
import ChatSelectorPopups from './ChatSelectorPopups.svelte';

afterEach(() => {
  cleanup();
});

describe('ChatSelectorPopups', () => {
  it('renders selector runtime anchors with stable ids and classes', () => {
    render(ChatSelectorPopups);

    const picker = document.getElementById('pi-chat-model-popup');
    expect(picker.classList.contains('pi-chat-model-popup')).toBe(true);
    expect(picker.style.display).toBe('none');
    expect(picker.getAttribute('role')).toBe('dialog');
    expect(picker.querySelector('#pi-chat-effort-controls').hidden).toBe(true);
    expect(document.getElementById('pi-chat-model-search').getAttribute('autocomplete')).toBe(
      'off',
    );
    expect(document.getElementById('pi-chat-model-search').getAttribute('placeholder')).toBe(
      t('composer.searchModels'),
    );
    expect(picker.querySelector('.pi-chat-model-list').id).toBe('pi-chat-model-list');

    expect(document.getElementById('pi-chat-slash-popup').className).toBe('pi-chat-slash-popup');
    expect(document.getElementById('pi-chat-slash-list').className).toBe('pi-chat-slash-list');
    expect(document.getElementById('pi-chat-mention-popup').className).toBe('pi-chat-slash-popup');
    expect(document.getElementById('pi-chat-mention-list').className).toBe('pi-chat-slash-list');
  });
});
