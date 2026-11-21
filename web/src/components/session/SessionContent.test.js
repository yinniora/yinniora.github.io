import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import SessionContent from './SessionContent.svelte';
import { SessionDataModel } from '../../session/data/session-data.svelte.js';

const entries = [
  {
    id: 'root',
    timestamp: '2026-01-01T00:00:00Z',
    type: 'message',
    message: { role: 'user', content: 'hi' },
  },
  {
    id: 'mid',
    parentId: 'root',
    timestamp: '2026-01-01T00:01:00Z',
    type: 'message',
    message: { role: 'assistant', content: 'mid' },
  },
  {
    id: 'leaf',
    parentId: 'mid',
    timestamp: '2026-01-01T00:02:00Z',
    type: 'message',
    message: { role: 'user', content: 'leaf' },
  },
  {
    id: 'other',
    parentId: 'root',
    timestamp: '2026-01-01T00:03:00Z',
    type: 'message',
    message: { role: 'assistant', content: 'other branch' },
  },
];

const renderEntry = (entry) => `<div id="entry-${entry.id}" class="msg">${entry.id}</div>`;

function mount(extra = {}) {
  const model = new SessionDataModel({ entries, header: {}, leafId: 'leaf', ...extra });
  return { model, ...render(SessionContent, { props: { model, renderEntry } }) };
}

describe('SessionContent', () => {
  it('renders the active root→leaf path in order (not off-path branches)', () => {
    const { container } = mount();
    const ids = [...container.querySelectorAll('#messages-list > div')].map((d) => d.id);
    expect(ids).toEqual(['entry-root', 'entry-mid', 'entry-leaf']);
    // 'other' is on a different branch → not rendered
    expect(container.querySelector('#entry-other')).not.toBeInTheDocument();
  });

  it('reactively re-renders the path when the active leaf changes', async () => {
    const { container, model } = mount();
    model.navigateTo('other');
    await Promise.resolve();
    const ids = [...container.querySelectorAll('#messages-list > div')].map((d) => d.id);
    expect(ids).toEqual(['entry-root', 'entry-other']);
  });

  it('reactively appends a new entry that extends the active path (live reload)', async () => {
    const { container, model } = mount();
    const newEntry = {
      id: 'leaf2',
      parentId: 'leaf',
      timestamp: '2026-01-01T00:04:00Z',
      type: 'message',
      message: { role: 'assistant', content: 'new' },
    };
    // Mimic live reconcile: in-place entries splice + byId refill.
    model.entries.push(newEntry);
    model.byId.set('leaf2', newEntry);
    model.navigateTo('leaf2');
    await Promise.resolve();
    expect(container.querySelector('#entry-leaf2')).toBeInTheDocument();
  });

  it('runs afterRender(container) when the path changes', async () => {
    const afterRender = vi.fn();
    const model = new SessionDataModel({ entries, header: {}, leafId: 'leaf' });
    render(SessionContent, { props: { model, renderEntry, afterRender } });
    await Promise.resolve();
    expect(afterRender).toHaveBeenCalled();
    expect(afterRender.mock.calls[0][0].id).toBe('messages-list');
  });

  it.each([
    ['final reply', { stopReason: 'stop', content: 'Here is the file.' }, '.reply-footer'],
    ['failed reply', { stopReason: 'error', errorMessage: 'HTTP 402' }, '.reply-error-actions'],
  ])('places the collapsed outputs before the %s and its controls', (_, message, controls) => {
    const path = [
      ...entries.slice(0, 3),
      {
        id: 'work',
        parentId: 'leaf',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'out.txt' } },
          ],
        },
      },
      {
        id: 'final',
        parentId: 'work',
        type: 'message',
        message: { role: 'assistant', ...message },
      },
    ];
    const model = new SessionDataModel({ entries: path, header: {}, leafId: 'final' });
    const { container } = render(SessionContent, {
      props: { model, live: true, chatAvailable: true, outputs: [{ id: 'file', entryId: 'work' }] },
    });
    const cards = container.querySelectorAll('.outputs-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].open).toBe(false);
    expect(cards[0].previousElementSibling).toHaveClass('activity-group');
    expect(cards[0].nextElementSibling).toHaveAttribute('id', 'entry-final');
    expect(cards[0].nextElementSibling.querySelector(controls)).toBeInTheDocument();
    expect(container.querySelector('#entry-mid').nextElementSibling.id).toBe('entry-leaf');
  });

  it('waits for output discovery before showing an empty-reply warning', async () => {
    const blank = {
      id: 'blank',
      parentId: 'root',
      type: 'message',
      message: { role: 'assistant', stopReason: 'stop', content: [] },
    };
    const model = new SessionDataModel({
      entries: [entries[0], blank],
      header: {},
      leafId: 'blank',
    });
    const { container, rerender } = render(SessionContent, {
      props: { model, live: true, chatAvailable: true, outputsReady: false },
    });
    expect(container.querySelector('.reply-interrupted')).toBeNull();

    await rerender({ outputsReady: true, outputs: [{ id: 'file', entryId: 'blank' }] });
    expect(container.querySelector('.reply-interrupted')).toBeNull();

    await rerender({ outputs: [] });
    const reply = container.querySelector('#entry-blank');
    expect(reply.querySelector('.reply-interrupted')).toBeInTheDocument();
    expect(reply.querySelector('.reply-error-actions')).toBeInTheDocument();
  });

  it('offers one continuation for a terminal timeout after saved tool activity', () => {
    const path = [
      entries[0],
      {
        id: 'tool',
        parentId: 'root',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'status' } }],
        },
      },
      {
        id: 'result',
        parentId: 'tool',
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
      {
        id: 'last-error',
        parentId: 'result',
        type: 'message',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'Request timed out.' },
      },
      {
        id: 'omit',
        parentId: 'last-error',
        type: 'context_edit',
        targetId: 'last-error',
        replacement: null,
      },
    ];
    const model = new SessionDataModel({ entries: path, header: {}, leafId: 'omit' });
    const { container, getAllByRole } = render(SessionContent, {
      props: { model, live: true, chatAvailable: true },
    });
    expect(container.querySelector('.activity-group')).not.toBeNull();
    expect(container.querySelector('#entry-last-error .reply-error-detail').textContent).toBe(
      'Request timed out.',
    );
    expect(getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
  });
});
