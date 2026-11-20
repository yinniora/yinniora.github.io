export const MAX_TOKEN_LIMIT = 10000000;

export function formatTokenLimit(tokens) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return '';
  if (tokens >= 1000000) return tokens / 1000000 + 'M';
  if (tokens >= 1000) return tokens / 1000 + 'K';
  return String(tokens);
}

export function parseTokenLimit(value, max) {
  const text = value?.trim() || '';
  if (!text) return undefined;
  const match = /^(\d+)(?:\.(\d+))?\s*([KM]?)$/i.exec(text);
  if (!match) return null;
  const [, integer, fraction = '', unit] = match;
  const digits = { K: 3, M: 6 }[unit.toUpperCase()] ?? 0;
  // Convert the suffix with decimal digits so input like 1.025K stays exact.
  const amount = Number(integer + fraction.padEnd(digits, '0'));
  if (fraction.length > digits || !Number.isSafeInteger(amount) || amount < 1 || amount > max) {
    return null;
  }
  return amount;
}
