import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import QuestionPicker from './QuestionPicker.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const single = {
  question: 'Which scope?',
  options: [{ label: 'Local', default: true }, { label: 'Remote' }],
};

const multi = {
  question: 'Which files?',
  multiSelect: true,
  options: [{ label: 'One' }, { label: 'Two' }],
};

function picker(questions, reply = vi.fn(), extra = {}) {
  return render(QuestionPicker, {
    props: {
      questions,
      expires: new Date(Date.now() + 120_000).toISOString(),
      busy: false,
      reply,
      ...extra,
    },
  });
}

describe('QuestionPicker', () => {
  it('stops the countdown and extends the deadline once the user engages', async () => {
    vi.useFakeTimers();
    const extend = vi.fn();
    picker([single], vi.fn(), { extend });

    const time = document.querySelector('.question-time');
    expect(time.textContent.trim()).toBe('2:00');

    await vi.advanceTimersByTimeAsync(3000);
    expect(time.textContent.trim()).toBe('1:57');

    const option = document.querySelector('.question-picker-option');
    option.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await tick();

    expect(extend).toHaveBeenCalledTimes(1);
    expect(time.textContent.trim()).toBe('Timer paused while you answer');

    await vi.advanceTimersByTimeAsync(5000);
    expect(time.textContent.trim()).toBe('Timer paused while you answer');
    // Engaging twice must not spam the worker with extend requests.
    option.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(extend).toHaveBeenCalledTimes(1);
  });

  it('accepts a typed answer that is not one of the options', async () => {
    const reply = vi.fn();
    picker([single], reply);

    const custom = document.querySelector('.question-custom textarea');
    custom.value = 'Neither — scope it to the parser only';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    const submit = document.querySelector('button[type="submit"]');
    expect(submit.disabled).toBe(false);
    // The typed answer replaces the prefilled option for a single-choice question.
    expect(document.querySelector('.question-picker-option.selected')).toBeNull();
    submit.click();

    expect(reply).toHaveBeenCalledWith({
      value: JSON.stringify([['Neither — scope it to the parser only']]),
    });
  });

  it('keeps each of several questions independent and requires an answer for each', async () => {
    const reply = vi.fn();
    picker([single, multi], reply);

    const blocks = document.querySelectorAll('.question-picker fieldset');
    expect(blocks).toHaveLength(2);
    expect(document.querySelector('.question-count')?.textContent).toBe('1/2');

    const submit = () => document.querySelector('button[type="submit"]');
    // Question 1 is prefilled by its default, question 2 is not.
    expect(submit().disabled).toBe(true);

    const second = document.querySelectorAll('.question-picker-option')[2];
    second.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    second.querySelector('input').click();
    await tick();
    expect(submit().disabled).toBe(false);

    submit().click();
    expect(reply).toHaveBeenCalledWith({ value: JSON.stringify([['Local'], ['One']]) });
  });

  it('offers skip (empty selections) and cancel (cancelled)', () => {
    const reply = vi.fn();
    picker([single, multi], reply);

    const [cancel, skip] = document.querySelectorAll('.question-picker-actions button');
    skip.click();
    expect(reply).toHaveBeenCalledWith({ value: JSON.stringify([[], []]) });

    cancel.click();
    expect(reply).toHaveBeenCalledWith({ cancelled: true });
  });
});
