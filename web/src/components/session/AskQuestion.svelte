<script>
  // The ask_user_question tool card. Renders the structure declaratively; the
  // option/submit buttons carry data-question/data-answer + classes that the chat
  // composer's delegated click handler turns into a chat reply. Mirrors the former
  // renderAskUserQuestionTool().
  import { icon, Check } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';

  let { args = {}, result = null, live = false, structured = false } = $props();

  const questions = $derived(Array.isArray(args.questions) ? args.questions : []);
  const answers = $derived(result?.details?.answers || {});
  const cancelled = $derived(result?.details?.cancelled === true);
  const timedOut = $derived(result?.details?.timedOut === true);
  const awaitingChatReply = $derived(result?.details?.awaitingChatReply === true);
  const questionToolFailed = $derived(result?.isError === true);
  const canReply = $derived(!result || questionToolFailed || awaitingChatReply);
  const isInteractive = $derived(
    live && ((canReply && (!structured || !!result)) || (!structured && cancelled)),
  );
  const isMulti = $derived(questions.length > 1);
  const anyMultiSelect = $derived(questions.some((q) => q && q.multiSelect === true));
  const needsSubmit = $derived(isMulti || anyMultiSelect);

  function optionLabel(option) {
    if (typeof option?.label === 'string') return option.label;
    if (typeof option?.value === 'string') return option.value;
    return String(option || '');
  }
  function optionDesc(option) {
    return typeof option?.description === 'string' ? option.description : '';
  }
  function answerFor(q, questionText) {
    if (Array.isArray(answers)) {
      const answer = answers.find((item) => item?.id === q?.id);
      return answer?.label ?? answer?.value ?? '';
    }
    return answers[questionText] ?? answers[q?.id] ?? '';
  }
  function isSelected(answer, label) {
    return (
      answer === label ||
      (Array.isArray(answer) && answer.includes(label)) ||
      (typeof answer === 'string' && answer.split(', ').includes(label))
    );
  }
  function questionTextOf(q, i) {
    if (typeof q?.question === 'string') return q.question;
    if (typeof q?.question_text === 'string') return q.question_text;
    if (typeof q?.prompt === 'string') return q.prompt;
    return `Question ${i + 1}`;
  }
  function questionHeaderOf(q) {
    return q?.header ?? q?.label ?? '';
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div
  class="ask-question-card"
  data-question-count={questions.length}
  data-needs-submit={needsSubmit}
>
  <div class="ask-question-title">{t('piExtension.questionTitle')}</div>
  {#if questionToolFailed}
    <div class="ask-question-state error">{t('piExtension.questionFailed')}</div>
  {:else if timedOut}
    <div class="ask-question-state error">{t('activity.timedOut')}</div>
  {:else if cancelled}
    <div class="ask-question-state error">{t('activity.stopped')}</div>
  {:else if awaitingChatReply}
    <div class="ask-question-state pending">{t('piExtension.waiting')}</div>
  {:else if result}
    <div class="ask-question-state answered">{t('activity.done')}</div>
  {:else}
    <div class="ask-question-state pending">{t('piExtension.waiting')}</div>
  {/if}

  {#if questions.length === 0}
    <div class="ask-question-text">No question payload provided.</div>
  {/if}

  {#each questions as q, qIndex (qIndex)}
    {@const questionText = questionTextOf(q, qIndex)}
    {@const answer = answerFor(q, questionText)}
    {@const options = Array.isArray(q.options) ? q.options : []}
    <div
      class="ask-question-block"
      data-question-text={questionText}
      data-multi-select={q && q.multiSelect === true}
    >
      {#if questionHeaderOf(q)}<div class="ask-question-header">
          {String(questionHeaderOf(q))}
        </div>{/if}
      <div class="ask-question-text">{questionText}</div>
      {#if options.length > 0}
        <div class="ask-question-options">
          {#each options as option, optionIndex (optionIndex)}
            {@const label = optionLabel(option)}
            {@const desc = optionDesc(option)}
            {@const selected = isSelected(answer, label)}
            {#if isInteractive}
              <button
                type="button"
                class="ask-question-option{selected ? ' selected' : ''} ask-question-option-action"
                data-question={questionText}
                data-answer={label}
              >
                <div class="ask-question-option-label">
                  {#if selected}{@html icon(Check, { size: 13 })}
                  {/if}{label}
                </div>
                {#if desc}<div class="ask-question-option-desc">{desc}</div>{/if}
              </button>
            {:else}
              <div class="ask-question-option{selected ? ' selected' : ''}">
                <div class="ask-question-option-label">
                  {#if selected}{@html icon(Check, { size: 13 })}
                  {/if}{label}
                </div>
                {#if desc}<div class="ask-question-option-desc">{desc}</div>{/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      {#if answer}<div class="ask-question-answer">
          <span>{t('piExtension.response')}</span>
          {Array.isArray(answer) ? answer.join(', ') : answer}
        </div>{/if}
    </div>
  {/each}

  {#if isInteractive}
    {#if needsSubmit}
      <div class="ask-question-actions" style="display:none">
        <button type="button" class="ask-question-submit-btn">{t('composer.send')}</button>
      </div>
    {:else if questionToolFailed}
      <div class="ask-question-hint">
        Use these options as a fallback — click an option to send your answer to pi.
      </div>
    {:else if cancelled}
      <div class="ask-question-hint">Click an option to send your answer to pi.</div>
    {:else if !result || awaitingChatReply}
      <div class="ask-question-hint">
        Click an option, or use the chat composer below, to answer this question.
      </div>
    {/if}
  {/if}
</div>
