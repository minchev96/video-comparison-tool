// Pixel-mismatch diff worker.
//
// The main thread captures both iframe canvases via `createImageBitmap` and
// transfers them here. We downscale into persistent OffscreenCanvases, run
// the 5-way (base / 1-frame / 2-frame sync-compensated) luma delta, and ship
// back an ImageBitmap of the overlay plus the mismatch stats. The history
// buffers, load-shedding factor and target interval stay resident so the
// main thread only pays for the transfer + final drawImage.

const DIFF_TARGET_INTERVAL_MS = 66;
const DIFF_MAX_INTERVAL_MS = 110;
const DIFF_TARGET_SAMPLES_IDLE = 150000;
const DIFF_TARGET_SAMPLES_ACTIVE = 110000;
const DIFF_ACTIVE_WINDOW_MS = 400;
const DIFF_MOTION_DELTA_THRESHOLD = 0.08;
const DIFF_ONE_FRAME_SYNC_COMPENSATION = true;
const DIFF_TWO_FRAME_SYNC_COMPENSATION = true;
const MISMATCH_MEDIAN_WINDOW = 5;
const MISMATCH_SPIKE_DELTA_PCT = 8;
const MISMATCH_SPIKE_CONFIRM_FRAMES = 2;

let tmpLeft = null;
let ctxLeft = null;
let tmpRight = null;
let ctxRight = null;
let outCanvas = null;
let outCtx = null;

let prevLeftLuma = null;
let prevRightLuma = null;
let prevPrevLeftLuma = null;
let prevPrevRightLuma = null;
let hasPrevFrame = false;
let hasPrevPrevFrame = false;
let framesProcessed = 0;
let loadSheddingFactor = 1;
let targetIntervalMs = DIFF_TARGET_INTERVAL_MS;
let stableMismatchPct = -1;
let pendingSpikeCount = 0;
let pendingSpikeTarget = -1;
const mismatchHistory = [];
let currentDims = { dw: 0, dh: 0 };
let diffSeq = 0;

const medianOf = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const ensureBuffers = (dw, dh) => {
  if (currentDims.dw === dw && currentDims.dh === dh && tmpLeft) return;
  currentDims = { dw, dh };
  tmpLeft = new OffscreenCanvas(dw, dh);
  ctxLeft = tmpLeft.getContext("2d", { willReadFrequently: true });
  tmpRight = new OffscreenCanvas(dw, dh);
  ctxRight = tmpRight.getContext("2d", { willReadFrequently: true });
  outCanvas = new OffscreenCanvas(dw, dh);
  outCtx = outCanvas.getContext("2d", { willReadFrequently: false });
  prevLeftLuma = new Float32Array(dw * dh);
  prevRightLuma = new Float32Array(dw * dh);
  prevPrevLeftLuma = new Float32Array(dw * dh);
  prevPrevRightLuma = new Float32Array(dw * dh);
  hasPrevFrame = false;
  hasPrevPrevFrame = false;
  framesProcessed = 0;
};

const resetState = () => {
  tmpLeft = ctxLeft = tmpRight = ctxRight = outCanvas = outCtx = null;
  prevLeftLuma = prevRightLuma = null;
  prevPrevLeftLuma = prevPrevRightLuma = null;
  hasPrevFrame = false;
  hasPrevPrevFrame = false;
  framesProcessed = 0;
  loadSheddingFactor = 1;
  targetIntervalMs = DIFF_TARGET_INTERVAL_MS;
  stableMismatchPct = -1;
  pendingSpikeCount = 0;
  pendingSpikeTarget = -1;
  mismatchHistory.length = 0;
  currentDims = { dw: 0, dh: 0 };
  diffSeq = 0;
};

const computeStep = (totalPixels, sinceMirror) => {
  const isActiveWindow =
    sinceMirror >= 0 && sinceMirror < DIFF_ACTIVE_WINDOW_MS;
  const sampleTarget = isActiveWindow
    ? DIFF_TARGET_SAMPLES_ACTIVE
    : DIFF_TARGET_SAMPLES_IDLE;
  const effectiveSampleTarget = Math.max(
    20000,
    Math.floor(sampleTarget / loadSheddingFactor),
  );
  const maxStep = loadSheddingFactor >= 3 ? 5 : 4;
  const step = Math.min(
    maxStep,
    Math.max(1, Math.ceil(Math.sqrt(totalPixels / effectiveSampleTarget))),
  );
  return { step, isActiveWindow };
};

const runDiff = ({
  leftBitmap,
  rightBitmap,
  sourceWidth,
  sourceHeight,
  threshold,
  excludeDynamicAnimations,
  sinceMirror,
  occlusionMask,
  occlusionCount,
}) => {
  const t0 = performance.now();
  const seq = ++diffSeq;

  const downscale =
    loadSheddingFactor >= 3.5
      ? 1.8
      : loadSheddingFactor >= 2.5
        ? 1.5
        : loadSheddingFactor >= 1.7
          ? 1.25
          : 1;
  const dw = Math.max(1, Math.round(sourceWidth / downscale));
  const dh = Math.max(1, Math.round(sourceHeight / downscale));

  ensureBuffers(dw, dh);

  ctxLeft.drawImage(leftBitmap, 0, 0, dw, dh);
  ctxRight.drawImage(rightBitmap, 0, 0, dw, dh);
  leftBitmap.close?.();
  rightBitmap.close?.();

  const leftData = ctxLeft.getImageData(0, 0, dw, dh);
  const rightData = ctxRight.getImageData(0, 0, dw, dh);
  const L = leftData.data;
  const R = rightData.data;

  // Quick blank check (sample ~1000 pixels across the buffer)
  let leftSum = 0;
  let rightSum = 0;
  const sampleStep = Math.max(1, Math.floor(L.length / 1000));
  for (let i = 0; i < L.length; i += sampleStep) {
    leftSum += L[i];
    rightSum += R[i];
  }

  if (leftSum === 0 && rightSum === 0) {
    outCtx.clearRect(0, 0, dw, dh);
    const bitmap = outCanvas.transferToImageBitmap();
    return {
      bitmap,
      stats: {
        frameSeq: seq,
        dims: `${dw}x${dh}`,
        mismatchPct: -1,
        rawMismatchPct: -1,
        threshold,
        sampledPixels: 0,
        comparedPixels: 0,
        mismatchPixels: 0,
        dynamicSkipped: 0,
        occluders: occlusionCount || 0,
        step: 1,
        loadShedding: Number(loadSheddingFactor.toFixed(2)),
        intervalMs: targetIntervalMs,
        downscale: Number(downscale.toFixed(2)),
        computeMs: Number((performance.now() - t0).toFixed(2)),
        captureMs: 0,
        totalMs: Number((performance.now() - t0).toFixed(2)),
        blankState: "both-blank",
        hasPrevFrame,
        hasPrevPrevFrame,
        excludeDynamicAnimations,
        isActiveWindow: false,
        updatedAt: Date.now(),
      },
    };
  }

  const blankState =
    leftSum === 0 ? "left-blank" : rightSum === 0 ? "right-blank" : "ok";

  const totalPixels = dw * dh;
  const { step, isActiveWindow } = computeStep(totalPixels, sinceMirror);

  const output = outCtx.createImageData(dw, dh);
  const O = output.data;

  let mismatchCount = 0;
  let sampledPixels = 0;
  let comparedPixels = 0;
  let dynamicSkipped = 0;

  const hasMask = !!occlusionMask && occlusionMask.byteLength === dw * dh;

  for (let pixelIndex = 0; pixelIndex < dw * dh; pixelIndex += 1) {
    if (hasMask && occlusionMask[pixelIndex]) continue;

    const i = pixelIndex * 4;
    const leftLuma =
      (L[i] * 0.2126 + L[i + 1] * 0.7152 + L[i + 2] * 0.0722) / 255;
    const rightLuma =
      (R[i] * 0.2126 + R[i + 1] * 0.7152 + R[i + 2] * 0.0722) / 255;

    const isDynamicMotion =
      hasPrevFrame &&
      (Math.abs(leftLuma - prevLeftLuma[pixelIndex]) >
        DIFF_MOTION_DELTA_THRESHOLD ||
        Math.abs(rightLuma - prevRightLuma[pixelIndex]) >
          DIFF_MOTION_DELTA_THRESHOLD);

    const baseDelta = Math.abs(leftLuma - rightLuma);
    const oneFrameRightDelta =
      hasPrevFrame && DIFF_ONE_FRAME_SYNC_COMPENSATION
        ? Math.abs(leftLuma - prevRightLuma[pixelIndex])
        : Number.POSITIVE_INFINITY;
    const oneFrameLeftDelta =
      hasPrevFrame && DIFF_ONE_FRAME_SYNC_COMPENSATION
        ? Math.abs(prevLeftLuma[pixelIndex] - rightLuma)
        : Number.POSITIVE_INFINITY;
    const twoFrameRightDelta =
      hasPrevPrevFrame && DIFF_TWO_FRAME_SYNC_COMPENSATION
        ? Math.abs(leftLuma - prevPrevRightLuma[pixelIndex])
        : Number.POSITIVE_INFINITY;
    const twoFrameLeftDelta =
      hasPrevPrevFrame && DIFF_TWO_FRAME_SYNC_COMPENSATION
        ? Math.abs(prevPrevLeftLuma[pixelIndex] - rightLuma)
        : Number.POSITIVE_INFINITY;

    const delta = Math.min(
      baseDelta,
      oneFrameRightDelta,
      oneFrameLeftDelta,
      twoFrameRightDelta,
      twoFrameLeftDelta,
    );

    if (hasPrevFrame) {
      prevPrevLeftLuma[pixelIndex] = prevLeftLuma[pixelIndex];
      prevPrevRightLuma[pixelIndex] = prevRightLuma[pixelIndex];
    }
    prevLeftLuma[pixelIndex] = leftLuma;
    prevRightLuma[pixelIndex] = rightLuma;

    if (excludeDynamicAnimations && isDynamicMotion) {
      dynamicSkipped++;
      continue;
    }

    comparedPixels++;
    sampledPixels++;

    const isMismatch = delta > threshold;
    if (isMismatch) {
      mismatchCount++;
      const intensity = Math.max(80, Math.min(255, Math.round(delta * 255)));
      O[i] = 255;
      O[i + 1] = 0;
      O[i + 2] = 0;
      O[i + 3] = intensity;
    }
  }

  framesProcessed += 1;
  hasPrevFrame = framesProcessed >= 1;
  hasPrevPrevFrame = framesProcessed >= 2;

  outCtx.putImageData(output, 0, 0);
  const bitmap = outCanvas.transferToImageBitmap();

  const rawPct =
    comparedPixels > 0
      ? Number(((mismatchCount / comparedPixels) * 100).toFixed(1))
      : 0;

  mismatchHistory.push(rawPct);
  if (mismatchHistory.length > MISMATCH_MEDIAN_WINDOW) {
    mismatchHistory.shift();
  }
  const medianPct = Number(medianOf(mismatchHistory).toFixed(1));

  if (stableMismatchPct < 0) {
    stableMismatchPct = medianPct;
  } else {
    const upwardDelta = medianPct - stableMismatchPct;
    if (upwardDelta > MISMATCH_SPIKE_DELTA_PCT) {
      if (
        pendingSpikeTarget < 0 ||
        Math.abs(pendingSpikeTarget - medianPct) > 1.5
      ) {
        pendingSpikeTarget = medianPct;
        pendingSpikeCount = 1;
      } else {
        pendingSpikeCount += 1;
      }
    } else {
      pendingSpikeTarget = -1;
      pendingSpikeCount = 0;
    }

    if (pendingSpikeCount >= MISMATCH_SPIKE_CONFIRM_FRAMES) {
      stableMismatchPct = medianPct;
      pendingSpikeTarget = -1;
      pendingSpikeCount = 0;
    } else {
      stableMismatchPct = Number(
        (stableMismatchPct * 0.7 + medianPct * 0.3).toFixed(1),
      );
    }
  }

  const pct = stableMismatchPct;
  const tEnd = performance.now();
  const computeMs = tEnd - t0;

  if (computeMs > targetIntervalMs * 0.75) {
    loadSheddingFactor = Math.min(4, loadSheddingFactor + 0.35);
  } else if (computeMs < targetIntervalMs * 0.35) {
    loadSheddingFactor = Math.max(1, loadSheddingFactor - 0.2);
  }

  if (computeMs > targetIntervalMs * 0.85) {
    targetIntervalMs = Math.min(DIFF_MAX_INTERVAL_MS, targetIntervalMs + 8);
  } else if (computeMs < targetIntervalMs * 0.45) {
    targetIntervalMs = Math.max(DIFF_TARGET_INTERVAL_MS, targetIntervalMs - 5);
  }

  return {
    bitmap,
    stats: {
      frameSeq: seq,
      dims: `${dw}x${dh}`,
      mismatchPct: pct,
      rawMismatchPct: rawPct,
      threshold,
      sampledPixels,
      comparedPixels,
      mismatchPixels: mismatchCount,
      dynamicSkipped,
      occluders: occlusionCount || 0,
      step,
      loadShedding: Number(loadSheddingFactor.toFixed(2)),
      intervalMs: targetIntervalMs,
      downscale: Number(downscale.toFixed(2)),
      computeMs: Number(computeMs.toFixed(2)),
      captureMs: 0,
      totalMs: Number(computeMs.toFixed(2)),
      blankState,
      hasPrevFrame,
      hasPrevPrevFrame,
      excludeDynamicAnimations,
      isActiveWindow,
      updatedAt: Date.now(),
    },
  };
};

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "reset") {
    resetState();
    self.postMessage({ type: "reset-ack" });
    return;
  }

  if (msg.type !== "diff") return;

  try {
    const result = runDiff(msg);
    self.postMessage(
      {
        type: "diff-result",
        id: msg.id,
        bitmap: result.bitmap,
        stats: result.stats,
        intervalMs: targetIntervalMs,
      },
      [result.bitmap],
    );
  } catch (err) {
    try {
      msg.leftBitmap?.close?.();
      msg.rightBitmap?.close?.();
    } catch {
      // ignore
    }
    self.postMessage({
      type: "diff-error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
      intervalMs: targetIntervalMs,
    });
  }
};
