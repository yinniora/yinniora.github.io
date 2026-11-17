<script>
  import { t } from '../../shared/i18n.js';
  import { sessionRuntime } from '../../session/session-runtime.js';
  function set(open) {
    sessionRuntime.toggleState?.setAllExpanded?.(open);
  }
</script>

<div class="activity-controls" role="group" aria-label={t('activity.controls')}>
  <span>{t('activity.controls')}</span>
  <button type="button" onclick={() => set(false)}>{t('activity.collapseAll')}</button>
  <button type="button" onclick={() => set(true)}>{t('activity.expandAll')}</button>
</div>
