<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';

  let { questions = [], expires = '', busy = false, reply, extend = null } = $props();

  // choices[i] holds the labels picked for question i; custom[i] holds free-form
  // text for the same question. A question is answered when either has content.
  let choices = $state([]);
  let custom = $state([]);
  let now = $state(Date.now());
  const remaining = $derived(Math.max(0, Math.ceil((Date.parse(expires) - now) / 1000)));
  // The countdown stops as soon as the user engages, so reading a long question
  // or typing a custom answer never runs the clock down under their hands. The
  // worker's own deadline is pushed out with a single extend request.
  let paused = $state(false);
  let extended = false;
  const prefix = $props.id();

  const answers = $derived(
    questions.map((_, index) => {
      const typed = String(custom[index] || '').trim();
      return [...new Set([...(choices[index] || []), ...(typed ? [typed] : [])])];
    }),
  );
  const ready = $derived(questions.length > 0 && answers.every((picked) => picked.length > 0));
  // Skipping is always allowed: it sends empty selections so the model knows
  // nothing was chosen instead of inventing an answer.
  const canSkip = $derived(!busy);

  onMount(() => {
    choices = questions.map((q) =>
      (q.options || []).filter((option) => option.default).map((option) => option.label),
    );
    custom = questions.map(() => '');
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function engage() {
    if (paused || busy) return;
    paused = true;
    if (!extended) {
      extended = true;
      if ((await extend?.()) === false) {
        extended = false;
        paused = false;
      }
    }
  }

  // A single-choice question has one answer: typing "something else" replaces
  // the picked option rather than being sent alongside it.
  function typeCustom(index, value) {
    custom[index] = value;
    if (value.trim() && !questions[index]?.multiSelect) choices[index] = [];
    engage();
  }

  function select(index, label, multi) {
    const before = choices[index] || [];
    choices[index] = multi
      ? before.includes(label)
        ? before.filter((value) => value !== label)
        : [...before, label]
      : [label];
    engage();
  }

  function submit(values) {
    if (busy) return;
    reply({ value: JSON.stringify(values) });
  }
</script>

<form
  class="question-picker"
  onsubmit={(event) => {
    event.preventDefault();
    if (ready) submit(answers);
  }}
  onpointerdown={engage}
  onfocusin={engage}
  oninput={engage}
>
  {#each questions as question, index (question.question)}
    <fieldset disabled={busy} data-question-index={index}>
      <legend>
        {#if question.header}<span class="question-header">{question.header}</span>{/if}
        <span class="question-title">{question.question}</span>
        {#if questions.length > 1}
          <span class="question-count">{index + 1}/{questions.length}</span>
        {/if}
      </legend>
      {#each question.options || [] as option (option.label)}
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
      <label class="question-custom">
        <span class="question-custom-label">{t('piExtension.customAnswer')}</span>
        <textarea
          rows="1"
          value={custom[index] || ''}
          oninput={(event) => typeCustom(index, event.currentTarget.value)}
          placeholder={t('piExtension.customAnswerHint')}
          maxlength="2000"
          disabled={busy}
        ></textarea>
      </label>
    </fieldset>
  {/each}

  <div class="question-picker-actions">
    <span class="question-time" aria-label={t('piExtension.timeRemaining')}>
      {#if paused && remaining > 30}
        {t('piExtension.timerPaused')}
      {:else}
        {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
      {/if}
    </span>
    <button
      type="button"
      class="btn-secondary"
      disabled={busy}
      onclick={() => reply({ cancelled: true })}
    >
      {t('common.cancel')}
    </button>
    <button
      type="button"
      class="btn-secondary"
      disabled={!canSkip}
      onclick={() => submit(questions.map(() => []))}
    >
      {t('piExtension.skip')}
    </button>
    <button type="submit" class="btn-primary" disabled={busy || !ready}>{t('composer.send')}</button
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
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
    padding: 0;
    font-size: 16px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .question-title {
    flex: 1 1 auto;
    min-width: 0;
  }
  .question-count {
    color: var(--text-soft);
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
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
  .question-custom {
    display: grid;
    gap: 6px;
  }
  .question-custom-label {
    color: var(--text-soft);
    font-size: 12px;
  }
  .question-custom textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    max-height: 160px;
    padding: 10px 12px;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--workspace-edge);
    border-radius: 10px;
    font: inherit;
    font-size: 16px;
    line-height: 1.5;
    resize: none;
  }
  .question-custom textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .question-picker-actions {
    display: flex;
    flex-wrap: wrap;
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
