import {
  detectCurrentModel,
  findModel,
  groupModelsByProvider,
  isScopedModel,
  modelDisplayLabel,
} from '../../../session/chat/chat-selectors.js';
import { t } from '../../../shared/i18n.js';
import { Check, icon } from '../../../shared/icons.js';
import { handleNavClick, backState } from '../../../shared/navigation.js';
import { loadModelBalances, modelBalanceLabel } from '../../../session/chat/model-balances.js';
import { escapeHtml as escapeModelHtml } from '../../../session/render/session-format.js';
import { showToast } from '../../../shared/toast.js';

export function renderModelList(
  models,
  { filter = '', selectedModel = null, balances = {}, escapeHtml = escapeModelHtml } = {},
) {
  const byProvider = groupModelsByProvider(models, filter);
  const providers = Object.keys(byProvider).sort((a, b) =>
    (byProvider[a][0]?.providerLabel || a).localeCompare(byProvider[b][0]?.providerLabel || b),
  );
  if (providers.length === 0)
    return '<div class="model-empty">' + escapeHtml(t('models.noMatches')) + '</div>';

  let html = '';
  for (const provider of providers) {
    const providerLabel = escapeHtml(byProvider[provider][0]?.providerLabel || provider);
    const balance = modelBalanceLabel(
      Object.hasOwn(balances, provider) ? balances[provider] : null,
    );
    html += '<div class="model-provider"><span>' + providerLabel + '</span>';
    html +=
      '<span class="model-picker-balance" data-balance-provider="' +
      escapeHtml(provider) +
      '"' +
      (balance ? '' : ' hidden') +
      '>' +
      escapeHtml(balance) +
      '</span></div>';
    for (const model of byProvider[provider]) {
      const id = model.id || model.modelId || '';
      const name = model.name || id;
      const scoped = isScopedModel(model)
        ? '<span class="model-scope-badge">' + escapeHtml(t('models.scoped')) + '</span>'
        : '';
      const active =
        selectedModel?.provider === provider &&
        (selectedModel.id === id || selectedModel.modelId === id);
      const mark = active ? icon(Check, { size: 18, class: 'model-choice-mark' }) : '';
      html +=
        '<button type="button" class="model-item' +
        (active ? ' selected' : '') +
        '" aria-pressed="' +
        active +
        '" data-provider="' +
        escapeHtml(provider) +
        '" data-model-id="' +
        escapeHtml(id) +
        '"><span>' +
        escapeHtml(name) +
        scoped +
        '</span>' +
        mark +
        '</button>';
    }
  }
  return html;
}

export function setupModelSelector({
  documentImpl = document,
  scope,
  sessionId,
  entries = [],
  chatApi,
  escapeHtml = escapeModelHtml,
  setModelLabel = () => {},
  setKnownModelLabel = () => {},
  getKnownModelLabel = () => '',
  setCurrentModelForThinking = () => {},
  setWorkerModelUpdate = () => {},
  setKnownThinkingLevel = () => {},
  setThinkingLabel = () => {},
  waitForThinkingChange = () => undefined,
} = {}) {
  let allModels = [];
  let balances = {};
  let balanceRequest;
  let modelRequest;
  let modelLoadFailed = false;
  let selectedModel = null;
  let changingModel = false;
  let changeGeneration = 0;
  let current = detectCurrentModel(entries);
  let focusBeforeOpen = null;
  let renderedModels = '';

  const popup = documentImpl.getElementById('pi-chat-model-popup');
  const popupSearch = documentImpl.getElementById('pi-chat-model-search');
  const popupList = documentImpl.getElementById('pi-chat-model-list');
  const modelLabelBtn = documentImpl.getElementById('pi-chat-model-label');
  const backdrop = documentImpl.getElementById('pi-chat-model-backdrop');
  const closeButton = documentImpl.getElementById('pi-chat-model-close');
  const currentLabel = documentImpl.getElementById('pi-chat-model-current');
  const note = documentImpl.getElementById('pi-chat-model-note');
  const mobileWidth = documentImpl.defaultView?.matchMedia?.('(max-width: 900px)');
  const isOpen = () => Boolean(popup && popup.style.display !== 'none');

  function reconcileSelection() {
    const { provider, modelId, thinkingLevels } = current;
    const model = findModel(allModels, provider, modelId);
    selectedModel =
      Array.isArray(thinkingLevels) && thinkingLevels.length
        ? { provider, id: modelId, ...model, thinkingLevels }
        : model || null;
    if (currentLabel) {
      currentLabel.textContent = modelId
        ? modelDisplayLabel(selectedModel || { provider, id: modelId })
        : '';
      currentLabel.hidden = !modelId;
    }
    setCurrentModelForThinking(selectedModel);
  }

  function showPickerError(message = '') {
    if (!note || !isOpen()) return false;
    note.textContent = message;
    note.hidden = !message;
    return true;
  }

  function renderPopupList(filter) {
    if (!popupList) return;
    const content = allModels.length
      ? renderModelList(allModels, { filter, selectedModel, balances, escapeHtml })
      : '<div class="model-empty"><a href="/models">' +
        escapeHtml(t(modelLoadFailed ? 'models.pickerFailed' : 'models.noneInPicker')) +
        '</a></div>';
    if (renderedModels === content) return;
    renderedModels = content;
    const focused = documentImpl.activeElement;
    const selectedKey = popupList.contains(focused) && focused.getAttribute('data-model-id');
    popupList.innerHTML = content;
    popupList.dataset.activeIndex = '-1';
    if (!selectedKey) return;
    for (const item of popupList.querySelectorAll('.model-item')) {
      if (
        item.dataset.modelId !== selectedKey ||
        item.dataset.provider !== focused.dataset.provider
      )
        continue;
      item.focus({ preventScroll: true });
      break;
    }
  }

  setWorkerModelUpdate((provider, modelId, thinkingLevels) => {
    if (changingModel || !provider || !modelId) return;
    const sameModel = current.provider === provider && current.modelId === modelId;
    current = {
      provider,
      modelId,
      thinkingLevels: thinkingLevels || (sameModel ? current.thinkingLevels : undefined),
    };
    reconcileSelection();
    if (isOpen()) renderPopupList(popupSearch?.value || '');
  });

  function refreshModels() {
    if (modelRequest) return modelRequest;
    modelRequest = chatApi
      .listModels()
      .then((res) => {
        if (!res.ok) throw new Error('api error');
        return res.json();
      })
      .then((data) => {
        if (scope?.aborted) return;
        modelLoadFailed = false;
        allModels = Array.isArray(data.models) ? data.models : [];
        reconcileSelection();
        if (isOpen()) renderPopupList(popupSearch?.value || '');
        if (selectedModel && !getKnownModelLabel()) {
          const label = modelDisplayLabel(selectedModel);
          setKnownModelLabel(label);
          setModelLabel(label);
        }
      })
      .catch(() => {
        modelLoadFailed = true;
        if (!scope?.aborted && isOpen()) renderPopupList(popupSearch?.value || '');
      })
      .finally(() => {
        modelRequest = null;
      });
    return modelRequest;
  }

  function openPopup() {
    if (!popup || isOpen()) return;
    focusBeforeOpen = documentImpl.activeElement;
    for (const menu of documentImpl.querySelectorAll(
      '#pi-chat-composer details:is(.composer-add, .computer-permission)[open]',
    )) {
      menu.open = false;
    }
    popup.inert = false;
    popup.style.display = 'flex';
    if (backdrop) backdrop.hidden = false;
    modelLabelBtn?.setAttribute('aria-expanded', 'true');
    showPickerError();
    if (popupSearch) popupSearch.value = '';
    const target = mobileWidth?.matches ? closeButton || popup : popupSearch || popup;
    target.focus({ preventScroll: true });
    renderPopupList('');
    if (popupList) popupList.scrollTop = 0;
    popup.scrollTop = 0;
    refreshModels();
    if (!balanceRequest) {
      balanceRequest = loadModelBalances({
        fetchImpl: documentImpl.defaultView?.fetch?.bind(documentImpl.defaultView),
        signal: scope,
      })
        .then((result) => {
          if (scope?.aborted) return;
          balances = result;
          if (isOpen()) renderPopupList(popupSearch?.value || '');
        })
        .catch(() => {})
        .finally(() => (balanceRequest = null));
    }
  }

  function closePopup(restoreFocus = true) {
    if (!isOpen()) return;
    if (popup.contains(documentImpl.activeElement)) documentImpl.activeElement.blur();
    popup.inert = true;
    popup.style.display = 'none';
    if (backdrop) backdrop.hidden = true;
    modelLabelBtn?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      const target = focusBeforeOpen?.matches('button, summary, a[href]')
        ? focusBeforeOpen
        : modelLabelBtn;
      target?.focus({ preventScroll: true });
    }
    focusBeforeOpen = null;
  }

  modelLabelBtn?.addEventListener(
    'click',
    () => {
      if (isOpen()) closePopup();
      else openPopup();
    },
    { signal: scope },
  );
  closeButton?.addEventListener('click', () => closePopup(), { signal: scope });
  popupSearch?.addEventListener('input', () => renderPopupList(popupSearch.value), {
    signal: scope,
  });
  popupSearch?.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing) return;
      const items = popupList ? popupList.querySelectorAll('.model-item') : [];
      let active = Number(popupList?.dataset.activeIndex ?? -1);
      if (event.key === 'Enter') {
        event.preventDefault();
        items[active]?.click();
        return;
      }
      if (!items.length) return;
      if (event.key === 'ArrowDown') active = Math.min(active + 1, items.length - 1);
      else if (event.key === 'ArrowUp') active = Math.max(active - 1, 0);
      else return;
      event.preventDefault();
      popupList.dataset.activeIndex = String(active);
      items.forEach((item, index) => item.classList.toggle('active', index === active));
      items[active]?.scrollIntoView?.({ block: 'nearest' });
    },
    { signal: scope },
  );

  popupList?.addEventListener(
    'click',
    async (e) => {
      const settings = e.target.closest('a[href="/models"]');
      if (settings) {
        const windowImpl = documentImpl.defaultView;
        handleNavClick(e, settings.getAttribute('href'), {
          windowImpl,
          state: backState({ windowImpl }),
        });
        return;
      }
      const item = e.target.closest('.model-item');
      if (!item) return;
      const { provider, modelId } = item.dataset;
      if (!provider || !modelId || changingModel) return;
      if (current.provider === provider && current.modelId === modelId) return;
      changingModel = true;
      changeGeneration++;
      showPickerError();
      popupList.setAttribute('aria-busy', 'true');
      try {
        await waitForThinkingChange();
        if (scope?.aborted) return;
        const response = await chatApi.setModel(sessionId, { provider, modelId });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'set model failed');
        if (scope?.aborted) return;
        current = { provider, modelId, thinkingLevels: result.thinkingLevels };
        setKnownThinkingLevel(result.thinkingLevel || '');
        setThinkingLabel(result.thinkingLevel || '');
        reconcileSelection();
        if (isOpen()) {
          renderPopupList(popupSearch?.value || '');
          if (mobileWidth?.matches && documentImpl.activeElement === popupSearch) {
            (closeButton || popup).focus({ preventScroll: true });
          }
        }
        const label = modelDisplayLabel(selectedModel || { provider, id: modelId });
        setKnownModelLabel(label);
        setModelLabel(label);
      } catch (err) {
        if (scope?.aborted) return;
        const error = err.message?.includes('finish the current reply')
          ? t('models.finishReply')
          : err.message || String(err);
        if (!showPickerError(error)) showToast(error, { documentImpl });
      } finally {
        changingModel = false;
        popupList.removeAttribute('aria-busy');
      }
    },
    { signal: scope },
  );

  documentImpl.addEventListener(
    'click',
    (event) => {
      const path = event.composedPath();
      if (isOpen() && !path.includes(popup) && !path.includes(modelLabelBtn)) {
        closePopup(event.target === backdrop);
      }
    },
    { signal: scope },
  );
  documentImpl.addEventListener(
    'keydown',
    (event) => {
      if (!isOpen() || event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePopup();
    },
    { signal: scope },
  );

  if (modelLabelBtn) modelLabelBtn.style.display = '';
  refreshModels();
  return {
    open: openPopup,
    close: closePopup,
    isChangingModel: () => changingModel,
    changeGeneration: () => changeGeneration,
    showPickerError,
  };
}
