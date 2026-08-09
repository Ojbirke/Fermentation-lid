// Peak detection for sourdough rise curves.
//
// Pure functions: same readings in, same verdict out. See docs/algorithm.md for
// why each step is here — most of them exist because of a specific way the naive
// version got it wrong on real data.
//
// Height is derived as `baselineMm - distanceMm`, where the baseline is the
// distance measured right after a feeding.

/** @typedef {{ ts: number, distanceMm: number }} RawSample */

export const DEFAULT_PEAK_CONFIG = {
  // Smoothing
  medianWindow: 7,          // samples; kills single-sample spikes
  averageWindow: 3,         // samples; settles the remaining noise
  // Rate of change
  slopeWindowS: 15 * 60,    // trailing window for the reported slope
  // Peak state machine
  armRiseMm: 20,            // must rise this far before a peak can be declared
  peakDropMm: 4,            // must fall this far below the max to confirm
  peakConfirmS: 20 * 60,    // ...and stay non-positive for this long
  slopeToleranceMmPerMin: 0.02,
  declineMm: 5,             // fall below the peak that reads as "declining"
  // Minimums before any verdict at all
  minSamples: 10,
  minDurationS: 30 * 60,
  // Jar handling (lid off, jar moved)
  handlingJumpMm: 12,       // a jump this big is handling, not fermentation
  handlingMaxGapS: 5 * 60,
  handlingReturnS: 15 * 60, // an excursion that returns within this is excised
  handlingReturnTolMm: 8,
  feedCleanupLookbackS: 20 * 60,
  // Baseline sanity
  maxPlausibleJarDepthMm: 300,
  baselineStabilityMm: 10,
  lidOffJumpMm: 150,
};

const EMPTY = {
  phase: "insufficient_data",
  currentHeightMm: null,
  currentSlopeMmPerMin: null,
  riseSinceFeedingMm: null,
  peakReached: false,
  peakTime: null,
  peakHeightMm: null,
  timeToPeakS: null,
  samplesUsed: 0,
};

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Least-squares slope of (ts seconds, value mm) points, in mm/minute. */
function fitSlopeMmPerMin(pts) {
  const n = pts.length;
  const meanT = pts.reduce((a, p) => a + p.ts, 0) / n;
  const meanV = pts.reduce((a, p) => a + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.ts - meanT) * (p.v - meanV);
    den += (p.ts - meanT) * (p.ts - meanT);
  }
  return den === 0 ? 0 : (num / den) * 60;
}

/**
 * Sanity-check a candidate baseline before a feeding is logged.
 *
 * Guards a failure that is easy to hit and silent: press "fed now" while the lid
 * is still off, the sensor looks past the jar at the table, and the baseline is
 * anchored there. Every later height is then nonsense — and the handling cleanup
 * keeps the bogus readings, because they "match the baseline".
 *
 * @param {number[]} readings newest valid distances (what the baseline comes from)
 * @param {number} candidateMm the baseline that would be set
 * @param {number|null} preLevelMm the settled level before the feeding, if known
 */
export function validateFeedingBaseline(readings, candidateMm, preLevelMm, config = DEFAULT_PEAK_CONFIG) {
  if (readings.length === 0) {
    return { ok: false, reason: "no_data", message: "No valid readings yet." };
  }
  if (candidateMm > config.maxPlausibleJarDepthMm) {
    return {
      ok: false, reason: "lid_off",
      message: `The sensor reads ${candidateMm} mm, which is past the jar — the lid is probably still off. Put it back on and wait for a fresh reading.`,
    };
  }
  const spread = Math.max(...readings) - Math.min(...readings);
  if (spread > config.baselineStabilityMm) {
    return {
      ok: false, reason: "unstable",
      message: `The readings are swinging by ${spread} mm. Wait until they settle before logging the feeding.`,
    };
  }
  if (preLevelMm != null && candidateMm - preLevelMm > config.lidOffJumpMm) {
    return {
      ok: false, reason: "lid_off",
      message: `The level went from ${preLevelMm} to ${candidateMm} mm, which is deeper than the jar — the sensor is probably seeing past it. Put the lid back on and wait for a fresh reading.`,
    };
  }
  return { ok: true };
}

/**
 * Find the readings that are artifacts of a feeding: the stretch where the lid
 * was off and the jar handled.
 *
 * Walking backwards from the feeding, a sample is an artifact when it is a
 * dropout, or when it matches NEITHER the new baseline NOR the pre-feeding
 * level — while the jar is being handled the sensor agrees with neither regime.
 * The walk stops at the first settled reading back at the pre-feeding level.
 *
 * @returns {number[]} unix seconds of the samples to exclude
 */
export function findFeedingArtifacts(samples, feedingTs, baselineMm, config = DEFAULT_PEAK_CONFIG) {
  const from = feedingTs - config.feedCleanupLookbackS;
  const window = samples.filter(s => s.ts >= from && s.ts <= feedingTs).sort((a, b) => a.ts - b.ts);
  if (window.length === 0) return [];

  const before = samples
    .filter(s => s.ts >= from - 10 * 60 && s.ts < from && s.distanceMm >= 0)
    .map(s => s.distanceMm);
  const preLevel = before.length ? median(before) : null;

  const out = [];
  for (let i = window.length - 1; i >= 0; i--) {
    const s = window[i];
    if (s.distanceMm < 0) { out.push(s.ts); continue; }
    const nearNew = Math.abs(s.distanceMm - baselineMm) <= config.handlingJumpMm;
    const nearOld = preLevel != null && Math.abs(s.distanceMm - preLevel) <= config.handlingJumpMm;
    if (nearOld) break;
    if (nearNew) continue;
    out.push(s.ts);
  }
  return out;
}

/**
 * Analyze the current feeding segment.
 *
 * @param {RawSample[]} samples readings since the feeding, dropouts included
 * @param {number} baselineMm distance to the freshly fed surface
 * @param {number|null} feedingTimeS unix seconds of the feeding, for timeToPeakS
 */
export function analyzeRiseCurve(samples, baselineMm, feedingTimeS = null, config = DEFAULT_PEAK_CONFIG) {
  // 1. Drop invalid readings and convert to height.
  const valid = samples
    .filter(s => s.distanceMm >= 0)
    .map(s => ({ ts: s.ts, v: baselineMm - s.distanceMm }))
    .sort((a, b) => a.ts - b.ts);
  if (valid.length === 0) return { ...EMPTY };

  // 1b. Handling guard. An excursion that returns is excised (lid lifted and put
  // back); a shift that does not return is flagged as a discontinuity that peak
  // confirmation refuses to reason across (usually an unlogged feeding).
  const discontinuities = [];
  const cleaned = [];
  let i = 0;
  while (i < valid.length) {
    const prev = cleaned[cleaned.length - 1];
    const cur = valid[i];
    const gapS = prev ? cur.ts - prev.ts : 0;
    // Over a long dropout gap some genuine change is possible, so the threshold
    // grows — 1 mm/min is still far above any real fermentation rate.
    const thr = gapS <= config.handlingMaxGapS
      ? config.handlingJumpMm
      : config.handlingJumpMm + gapS / 60;
    if (!prev || Math.abs(cur.v - prev.v) <= thr) { cleaned.push(cur); i++; continue; }
    let ret = -1;
    for (let k = i; k < valid.length && valid[k].ts - prev.ts <= config.handlingReturnS; k++) {
      if (Math.abs(valid[k].v - prev.v) <= config.handlingReturnTolMm) { ret = k; break; }
    }
    if (ret >= 0) { i = ret; continue; }
    discontinuities.push(cur.ts);
    cleaned.push(cur); i++;
  }

  const durationS = cleaned[cleaned.length - 1].ts - cleaned[0].ts;
  if (cleaned.length < config.minSamples || durationS < config.minDurationS) {
    return { ...EMPTY, currentHeightMm: cleaned[cleaned.length - 1].v, samplesUsed: cleaned.length };
  }

  // 2. Trailing rolling median, then a trailing moving average. Trailing, never
  // centred, so a live verdict matches one computed later on the full series.
  const afterMedian = cleaned.map((p, idx) => {
    const from = Math.max(0, idx - config.medianWindow + 1);
    return { ts: p.ts, v: median(cleaned.slice(from, idx + 1).map(q => q.v)) };
  });
  const smoothed = afterMedian.map((p, idx) => {
    const from = Math.max(0, idx - config.averageWindow + 1);
    const win = afterMedian.slice(from, idx + 1);
    return { ts: p.ts, v: win.reduce((a, q) => a + q.v, 0) / win.length };
  });

  const last = smoothed[smoothed.length - 1];

  // 3. One least-squares fit per window. Per-sample slope estimates carry several
  // mm/hour of noise even after smoothing, so any "every point is falling" rule
  // fails at random; one aggregate fit uses the same information and is stable.
  const slopeOverWindow = (endIdx, windowS) => {
    const endTs = smoothed[endIdx].ts;
    const win = [];
    for (let j = endIdx; j >= 0 && endTs - smoothed[j].ts <= windowS; j--) win.push(smoothed[j]);
    if (win.length < 3 || endTs - win[win.length - 1].ts < windowS / 2) return null;
    return fitSlopeMmPerMin(win);
  };

  // 4. Causal scan for the first moment a peak was confirmed. Once confirmed it
  // is sticky: a later artifact can neither move it nor take it back.
  let peakReached = false;
  let peakIdx = 0;
  let runMax = 0;
  for (let k = 1; k < smoothed.length; k++) {
    if (smoothed[k].v > smoothed[runMax].v) runMax = k;
    const tsK = smoothed[k].ts;
    if (smoothed[runMax].v < config.armRiseMm) continue;                        // not armed
    if (smoothed[runMax].v - smoothed[k].v < config.peakDropMm) continue;       // not fallen enough
    if (tsK - smoothed[runMax].ts < config.peakConfirmS) continue;              // too soon after the max
    if (tsK - smoothed[0].ts < config.peakConfirmS) continue;                   // segment too short
    if (discontinuities.some(d => d > smoothed[runMax].ts && d <= tsK)) continue;
    const slope = slopeOverWindow(k, config.peakConfirmS);
    if (slope == null || slope > config.slopeToleranceMmPerMin) continue;
    peakReached = true;
    peakIdx = runMax;
    break;
  }
  const peak = smoothed[peakIdx];

  let globalMax = 0;
  for (let k = 1; k < smoothed.length; k++) if (smoothed[k].v > smoothed[globalMax].v) globalMax = k;
  const armed = smoothed[globalMax].v >= config.armRiseMm;

  const phase = peakReached
    ? (last.v <= peak.v - config.declineMm ? "declining" : "peaked")
    : (armed ? "rising" : "lag");

  const currentSlope = slopeOverWindow(smoothed.length - 1, config.slopeWindowS);
  return {
    phase,
    currentHeightMm: Math.round(last.v * 10) / 10,
    currentSlopeMmPerMin: currentSlope != null ? Math.round(currentSlope * 1000) / 1000 : null,
    riseSinceFeedingMm: Math.round((last.v - smoothed[0].v) * 10) / 10,
    peakReached,
    peakTime: peakReached ? peak.ts : null,
    peakHeightMm: peakReached ? Math.round(peak.v * 10) / 10 : null,
    timeToPeakS: peakReached && feedingTimeS != null ? peak.ts - feedingTimeS : null,
    samplesUsed: cleaned.length,
  };
}
