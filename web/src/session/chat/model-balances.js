import { getJSON } from '../../shared/api.js';
import { t } from '../../shared/i18n.js';

export async function loadModelBalances({ fetchImpl = fetch, signal } = {}) {
  const result = await getJSON('/api/model-balances', {
    fetchImpl: (url, options) => fetchImpl(url, { ...options, signal }),
  });
  return result.balances || {};
}

export function modelBalanceLabel(balance) {
  if (!balance) return '';
  if (balance.status === 'unlimited') return t('models.balanceUnlimited');
  if (balance.status !== 'available' || !Number.isFinite(balance.amount)) {
    return t('models.balanceUnavailable');
  }

  const currency = ['USD', 'CNY'].includes(balance.unit) ? balance.unit : '';
  const formatted = new Intl.NumberFormat(undefined, {
    ...(currency ? { style: 'currency', currency } : {}),
    maximumFractionDigits: 6,
  }).format(balance.amount);
  const amount = currency ? formatted : t('models.balanceQuotaUnits', { amount: formatted });
  return t(balance.scope === 'account' ? 'models.balanceAccount' : 'models.balanceKey', { amount });
}
