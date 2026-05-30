export const shouldShowMismatchStat = (mismatchPercent, threshold) => {
  if (!Number.isFinite(mismatchPercent) || mismatchPercent < 0) {
    return false;
  }

  const displayThreshold = Number.isFinite(threshold) ? threshold : 0;
  return mismatchPercent > displayThreshold * 100;
};
