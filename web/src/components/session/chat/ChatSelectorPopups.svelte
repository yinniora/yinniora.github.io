<script>
  import { t } from '../../../shared/i18n.js';
  import { icon, X } from '../../../shared/icons.js';
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons only -->
<div id="pi-chat-model-popup" class="pi-chat-model-popup" style="display: none">
  <div class="mobile-model-heading">
    <strong>{t('composer.switchModel')}</strong>
    <button
      type="button"
      aria-label={t('common.close')}
      onclick={(event) => {
        event.currentTarget.closest('.pi-chat-model-popup').style.display = 'none';
      }}
      >{@html icon(X, {
        size: 20,
      })}</button
    >
  </div>
  <input
    type="text"
    id="pi-chat-model-search"
    class="pi-chat-model-search"
    placeholder={t('composer.searchModels')}
    autocomplete="off"
  />
  <div id="pi-chat-model-list" class="pi-chat-model-list"></div>
</div>
<div id="pi-chat-thinking-popup" class="pi-chat-thinking-popup" style="display: none">
  <div
    id="pi-chat-thinking-list"
    class="pi-chat-thinking-list"
    role="group"
    aria-label={t('composer.switchEffort')}
  ></div>
</div>
<div id="pi-chat-slash-popup" class="pi-chat-slash-popup" style="display: none">
  <div id="pi-chat-slash-list" class="pi-chat-slash-list"></div>
</div>
<div id="pi-chat-mention-popup" class="pi-chat-slash-popup" style="display: none">
  <div id="pi-chat-mention-list" class="pi-chat-slash-list"></div>
</div>
