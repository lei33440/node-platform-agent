function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function reconcileCounter(total, previousRaw, currentRaw) {
  const accumulated = finiteNonNegative(total);
  const current = finiteNonNegative(currentRaw);
  const previous = Number(previousRaw);
  const delta = Number.isFinite(previous) && current >= previous ? current - previous : current;
  return { total: accumulated + delta, raw: current };
}

module.exports = { reconcileCounter };
