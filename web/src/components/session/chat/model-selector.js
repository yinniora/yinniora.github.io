import {
  detectCurrentModel,
  findModel,
  groupModelsByProvider,
  isScopedModel,
  modelDisplayLabel,
} from '../../../session/chat/chat-selectors.js';
import { t } from '../../../shared/i18n.js';
import { handleNavClick, backState } from '../../../shared/navigation.js';

export function renderModelList(
  models,
  { filter = '', selectedModel = null, escapeHtml = String } = {},
) {
  const byProvider = groupModelsByProvider(models, filter);
  const providers = Object.keys(byProvider).sort();
  if (providers.length === 0)
    return `<div class="model-empty">${escapeHtml(t('models.noMatches'))}</div>`;

  let html = '';
  providers.forEach((provider) => {
    html += `<div class="model-provider">${escapeHtml(byProvider[provider][0]?.providerLabel || provider)}</div>`;
    byProvider[provider].forEach((model) => {
      const id = model.id || model.modelId || '';
      const name = model.name || id;
      const scoped = isScopedModel(model) ? '<span class="model-scope-badge">scoped</span>' : '';
      const active =
        selectedModel &&
        selectedModel.provider === provider &&
        (selectedModel.id === id || selectedModel.modelId === id)
          ? ' selected'
          : '';
      html += `<button type="button" class="model-item${active}" data-provider="${escapeHtml(provider)}" data-model-id="${escapeHtml(id)}">${escapeHtml(name)}${scoped}</button>`;
    });
  });
  return html;
}

export function setupModelSelector({
  documentImpl = document,
  scope,
  sessionId,
  entries = [],
  chatApi,
  escapeHtml = String,
  setModelLabel = () => {},
  setChatStatus = () => {},
  setKnownModelLabel = () => {},
  getKnownModelLabel = () => '',
  setCurrentModelForThinking = () => {},
  setWorkerModelUpdate = () => {},
} = {}) {
  let allModels = [];
  let selectedModel = null;
  let changingModel = false;
  let current = detectCurrentModel(entries);

  function setSelected(model) {
    selectedModel = model;
    setCurrentModelForThinking(model || null);
  }

  function reconcileSelection() {
    setSelected(findModel(allModels, current.provider, current.modelId) || null);
  }

  setWorkerModelUpdate((provider, modelId) => {
    if (changingModel || !provider || !modelId) return;
    current = { provider, modelId };
    reconcileSelection();
  });

  const popup = documentImpl.getElementById('pi-chat-model-popup');
  const popupSearch = documentImpl.getElementById('pi-chat-model-search');
  const popupList = documentImpl.getElementById('pi-chat-model-list');
  const modelLabelBtn = documentImpl.getElementById('pi-chat-model-label');

  // Always show the label button so the user can open the model picker.
  // Server may have hidden it when no model was detected at page load.
  if (modelLabelBtn) modelLabelBtn.style.display = '';

  function renderPopupList(filter) {
    if (!popupList) return;
    popupList.innerHTML = allModels.length
      ? renderModelList(allModels, { filter, selectedModel, escapeHtml })
      : `<div class="model-empty"><a href="/settings?section=models">${escapeHtml(t('models.noneInPicker'))}</a></div>`;
    popupList.dataset.activeIndex = '-1';
  }

  function openPopup() {
    if (!popup) return;
    popup.style.display = 'flex';
    if (popupSearch) {
      popupSearch.value = '';
      if (!documentImpl.defaultView?.matchMedia?.('(max-width: 900px)').matches)
        popupSearch.focus({ preventScroll: true });
    }
    renderPopupList('');
    chatApi
      .listModels()
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (scope?.aborted || !Array.isArray(data?.models)) return;
        allModels = data.models;
        reconcileSelection();
        renderPopupList(popupSearch?.value || '');
      })
      .catch(() => {});
  }

  function closePopup(focusTextarea = false) {
    if (documentImpl.activeElement === popupSearch) popupSearch?.blur?.();
    if (popup) popup.style.display = 'none';
    if (focusTextarea) {
      const textarea = documentImpl.getElementById('pi-chat-message');
      if (textarea && !documentImpl.defaultView?.matchMedia?.('(max-width: 900px)').matches)
        textarea.focus({ preventScroll: true });
    }
  }

  const api = {
    open: openPopup,
    close: closePopup,
    isChangingModel: () => changingModel,
  };

  // Attach click handlers immediately so the button is responsive
  // even before the model list finishes loading.
  modelLabelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popup && popup.style.display !== 'none') closePopup();
    else openPopup();
  });

  popupSearch?.addEventListener('input', () => renderPopupList(popupSearch.value));
  popupSearch?.addEventListener('keydown', (e) => {
    const items = popupList ? popupList.querySelectorAll('.model-item') : [];
    let popupActive = parseInt((popupList && popupList.dataset.activeIndex) || '-1', 10);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      popupActive = Math.min(popupActive + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      popupActive = Math.max(popupActive - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (popupActive >= 0 && items[popupActive]) items[popupActive].click();
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopup();
      modelLabelBtn?.focus();
      return;
    }
    if (popupList) popupList.dataset.activeIndex = popupActive;
    items.forEach((item, i) => item.classList.toggle('active', i === popupActive));
    items[popupActive]?.scrollIntoView?.({ block: 'nearest' });
  });

  popupList?.addEventListener('click', async (e) => {
    const settings = e.target.closest('a[href="/settings?section=models"]');
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
    const provider = item.dataset.provider;
    const modelId = item.dataset.modelId;
    if (!provider || !modelId || changingModel) return;
    closePopup(true);
    changingModel = true;
    try {
      const setRes = await chatApi.setModel(sessionId, { provider, modelId });
      const setData = await setRes.json();
      if (!setRes.ok) throw new Error(setData.error || 'set model failed');
      if (scope?.aborted) return;
      current = { provider, modelId };
      const model = findModel(allModels, provider, modelId);
      setSelected(model || { provider, id: modelId, name: modelId });
      const newLabel = modelDisplayLabel(model || { provider, id: modelId, name: modelId });
      setKnownModelLabel(newLabel);
      setModelLabel(newLabel);
    } catch (err) {
      setChatStatus(
        err.message?.includes('finish the current reply')
          ? t('models.finishReply')
          : err.message || String(err),
        'error',
      );
    } finally {
      changingModel = false;
    }
  });

  documentImpl.addEventListener(
    'click',
    (e) => {
      if (popup && popup.style.display !== 'none') {
        const modelLabelBtnEl = documentImpl.getElementById('pi-chat-model-label');
        if (!popup.contains(e.target) && e.target !== modelLabelBtnEl) closePopup();
      }
    },
    { signal: scope },
  );

  // Load the model list asynchronously; the button is already wired.
  // Fire-and-forget: the popup opens immediately (Ctrl+L) and renders
  // available models as they load.
  chatApi
    .listModels()
    .then((res) => {
      if (!res.ok) throw new Error('api error');
      return res.json();
    })
    .then((data) => {
      if (scope?.aborted) return;
      allModels = Array.isArray(data.models) ? data.models : [];
      reconcileSelection();
      if (popup && popup.style.display !== 'none') {
        renderPopupList(popupSearch ? popupSearch.value : '');
      }
      if (selectedModel && !getKnownModelLabel()) {
        const label = modelDisplayLabel(selectedModel);
        setKnownModelLabel(label);
        setModelLabel(label);
      }
    })
    .catch(() => {
      // Model list fetch failed; button still works (shows empty list).
      if (!scope?.aborted && popupList) {
        popupList.innerHTML = `<div class="model-empty">${escapeHtml(t('models.pickerFailed'))}</div>`;
      }
    });

  return api;
}
