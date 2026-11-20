<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';

  let { questions, expires, busy, reply } = $props();
  let choices = $state([]);
  let now = $state(Date.now());
  const prefix = $props.id();
  const seconds = $derived(Math.max(0, Math.ceil((Date.parse(expires) - now) / 1000)));
  const ready = $derived(questions.every((_, index) => choices[index]?.length));

  onMount(() => {
    choices = questions.map((q) =>
      q.options.filter((option) => option.default).map((option) => option.label),
    );
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function select(index, label, multi) {
    const before = choices[index] || [];
    choices[index] = multi
      ? before.includes(label)
        ? before.filter((value) => value !== label)
        : [...before, label]
      : [label];
  }
</script>

<form
  class="question-picker"
  onsubmit={(event) => {
    event.preventDefault();
    if (ready && seconds && !busy) reply({ value: JSON.stringify(choices) });
  }}
>
  {#each questions as question, index (question.question)}
    <fieldset disabled={busy || !seconds}>
      <legend>
        {#if question.header}<span class="question-header">{question.header}</span>{/if}
        {question.question}
      </legend>
      {#each question.options as option (option.label)}
        <label
          class="question-picker-option"
          class:selected={choices[index]?.includes(option.label)}
        >
          <input
            type={question.multiSelect ? 'checkbox' : 'radio'}
            name={prefix + '-' + index}
            checked={choices[index]?.includes(option.label)}
            onchange={() => select(index, option.label, question.multiSelect)}
          />
          <span>
            <strong>{option.label}</strong>
            {#if option.recommended}<small>{t('piExtension.recommended')}</small>{/if}
            {#if option.default}<small>{t('schedules.thinkingDefault')}</small>{/if}
            {#if option.description}<span class="question-description">{option.description}</span
              >{/if}
          </span>
        </label>
      {/each}
    </fieldset>
  {/each}
  <div class="question-picker-actions">
    <span class="question-time" aria-label={t('piExtension.timeRemaining')}>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
    <button
      type="button"
      class="btn-secondary"
      disabled={busy || !seconds}
      onclick={() => reply({ cancelled: true })}
    >
      {t('common.cancel')}
    </button>
    <button type="submit" class="btn-primary" disabled={busy || !ready || !seconds}
      >{t('composer.send')}</button
    >
  </div>
</form>

<style>
  .question-picker,
  fieldset {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 12px;
  }
  legend {
    margin-bottom: 10px;
    padding: 0;
    font-size: 16px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .question-header,
  .question-description {
    display: block;
    color: var(--text-soft);
    font-size: 13px;
    font-weight: 400;
  }
  .question-picker-option {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    min-height: 44px;
    border: 1px solid var(--workspace-edge);
    border-radius: 10px;
    background: var(--bg-secondary);
    cursor: pointer;
    overflow-wrap: anywhere;
    transition:
      border-color 150ms ease,
      background 150ms ease;
  }
  .question-picker-option.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 11%, var(--bg-secondary));
  }
  .question-picker-option input {
    flex: none;
    accent-color: var(--accent);
  }
  .question-picker-option small {
    margin-inline-start: 8px;
    color: var(--accent);
    white-space: nowrap;
  }
  .question-picker-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .question-time {
    margin-inline-end: auto;
    color: var(--text-soft);
    font-variant-numeric: tabular-nums;
  }
  button {
    min-height: 44px;
  }
</style>
