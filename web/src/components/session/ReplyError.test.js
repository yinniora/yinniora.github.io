import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReplyError from './ReplyError.svelte';

afterEach(cleanup);

describe('ReplyError', () => {
  it('keeps the named actions available while raw failure details are folded', async () => {
    const onRetry = vi.fn();
    const onChooseModel = vi.fn();
    const { container } = render(ReplyError, {
      props: { error: 'HTTP 402', model: 'Claude', onRetry, onChooseModel },
    });
    const card = container.querySelector('.reply-error');
    const details = card.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(card).getByText('Failed')).toBeInTheDocument();
    expect(within(card).getByText('Claude')).toBeInTheDocument();

    await fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    await fireEvent.click(within(card).getByRole('button', { name: 'Models' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onChooseModel).toHaveBeenCalledTimes(1);
    expect(details).not.toHaveAttribute('open');

    await fireEvent.click(details.querySelector('summary'));
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText('HTTP 402')).toBeVisible();
  });

  it('uses the same controls below an unfinished activity without a second status card', async () => {
    const onContinue = vi.fn();
    const { container, getByRole } = render(ReplyError, {
      props: { actionsOnly: true, onContinue },
    });
    expect(container.querySelector('.reply-error')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows a provider model rejection and prioritizes choosing another model', async () => {
    const onChooseModel = vi.fn();
    const { getByText, getByRole, container } = render(ReplyError, {
      props: {
        error:
          '404 {"error":{"type":"not_found_error","message":"no provider serves the requested model","code":10002}}',
        model: 'claude-opus-5-5',
        onChooseModel,
        onRetry: vi.fn(),
      },
    });
    expect(getByText('Model unavailable from this provider')).toBeInTheDocument();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    const choose = getByRole('button', { name: 'Switch model' });
    expect(choose).toHaveClass('reply-action-primary');
    await fireEvent.click(choose);
    expect(onChooseModel).toHaveBeenCalledOnce();
  });
});
