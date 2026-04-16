import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../App.css";
import LiveSourceForm from "./LiveSourceForm.jsx";
import TopBar from "./TopBar.jsx";
import WarningBanner from "./WarningBanner.jsx";
import "../styles/LiveWebsiteCompare.css";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const DIFF_TARGET_INTERVAL_MS = 66;
const DIFF_MAX_INTERVAL_MS = 110;
const DIFF_TARGET_SAMPLES_IDLE = 120000;
const DIFF_TARGET_SAMPLES_ACTIVE = 70000;
const DIFF_ACTIVE_WINDOW_MS = 400;
const DIFF_MOTION_DELTA_THRESHOLD = 0.08;
const DIFF_ONE_FRAME_SYNC_COMPENSATION = true;
const DIFF_TWO_FRAME_SYNC_COMPENSATION = true;
const MISMATCH_MEDIAN_WINDOW = 5;
const MISMATCH_SPIKE_DELTA_PCT = 8;
const MISMATCH_SPIKE_CONFIRM_FRAMES = 2;

function LiveWebsiteCompare() {
  const navigate = useNavigate();
  const sessionRef = useRef(null);

  const leftIframeRef = useRef(null);
  const rightIframeRef = useRef(null);
  const diffCanvasRef = useRef(null);
  const topContainerRef = useRef(null);
  const sliderRef = useRef(null);
  const draggingRef = useRef(false);
  const relayLogSeqRef = useRef(0);
  const mismatchEnabledRef = useRef(false);
  const mismatchLogSeqRef = useRef(0);
  const lastMirroredEventAtRef = useRef(0);
  const diagnosticsRef = useRef({
    sessionStartAt: 0,
    relayCount: 0,
    relayDelayMs: { last: -1, avg: -1, max: -1 },
    relayTypes: {
      mirror: 0,
      wheel: 0,
      key: 0,
      input: 0,
      betCapture: 0,
    },
    iframeLoads: {
      left: { count: 0, lastAt: 0 },
      right: { count: 0, lastAt: 0 },
    },
    diff: {
      runId: 0,
      frameSeq: 0,
      dims: "0x0",
      mismatchPct: -1,
      rawMismatchPct: -1,
      threshold: 0,
      sampledPixels: 0,
      comparedPixels: 0,
      mismatchPixels: 0,
      dynamicSkipped: 0,
      occluders: 0,
      step: 0,
      loadShedding: 1,
      intervalMs: DIFF_TARGET_INTERVAL_MS,
      downscale: 1,
      computeMs: 0,
      captureMs: 0,
      totalMs: 0,
      blankState: "unknown",
      hasPrevFrame: false,
      hasPrevPrevFrame: false,
      updatedAt: 0,
    },
    latestError: "",
  });

  const [sessionId, setSessionId] = useState("");
  const [leftProxyUrl, setLeftProxyUrl] = useState("");
  const [rightProxyUrl, setRightProxyUrl] = useState("");
  const [leftName, setLeftName] = useState("");
  const [rightName, setRightName] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    "Provide two website URLs and press Load URLs.",
  );
  const [serverError, setServerError] = useState("");
  const [leftInputError, setLeftInputError] = useState("");
  const [rightInputError, setRightInputError] = useState("");
  const [mismatchEnabled, setMismatchEnabled] = useState(false);
  const [threshold, setThreshold] = useState(0.05);
  const [excludeDynamicAnimations, setExcludeDynamicAnimations] =
    useState(false);
  const [mismatchPercent, setMismatchPercent] = useState(-1);
  const [sliderPos, setSliderPos] = useState(0.5);
  const [isFormCollapsed, setIsFormCollapsed] = useState(false);
  const [iframeLoadGen, setIframeLoadGen] = useState(0);
  const iframesLoaded = iframeLoadGen >= 2;

  const updateRelayDiagnostics = useCallback((relayDelay, relayType) => {
    const diag = diagnosticsRef.current;
    diag.relayCount += 1;
    if (relayType && Object.hasOwn(diag.relayTypes, relayType)) {
      diag.relayTypes[relayType] += 1;
    }
    if (relayDelay >= 0) {
      const currentAverage = diag.relayDelayMs.avg;
      diag.relayDelayMs.last = relayDelay;
      diag.relayDelayMs.max = Math.max(diag.relayDelayMs.max, relayDelay);
      diag.relayDelayMs.avg =
        currentAverage < 0
          ? relayDelay
          : (currentAverage * (diag.relayCount - 1) + relayDelay) /
            diag.relayCount;
    }
  }, []);

  useEffect(() => {
    mismatchEnabledRef.current = mismatchEnabled;
    if (!mismatchEnabled) {
      setSliderPos(0.5);
    }
  }, [mismatchEnabled]);

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        fetch(`/api/live/session/${sessionRef.current}`, {
          method: "DELETE",
        }).catch(() => {});
        sessionRef.current = null;
      }
    };
  }, []);

  // Draggable slider handle — only captures events during drag.
  // Iframes keep full native interaction at all other times.
  useEffect(() => {
    if (!sessionId || mismatchEnabled) return;

    const slider = sliderRef.current;
    const container = topContainerRef.current;
    if (!slider || !container) return;

    const updatePos = (clientX) => {
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      setSliderPos(clamp((clientX - rect.left) / rect.width, 0, 1));
    };

    const onPointerDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      slider.setPointerCapture(e.pointerId);
      updatePos(e.clientX);
      // While dragging, disable iframe pointer events so mousemove works
      container.classList.add("dragging");
    };

    const onPointerMove = (e) => {
      if (!draggingRef.current) return;
      updatePos(e.clientX);
    };

    const onPointerUp = (e) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      slider.releasePointerCapture(e.pointerId);
      container.classList.remove("dragging");
    };

    slider.addEventListener("pointerdown", onPointerDown);
    slider.addEventListener("pointermove", onPointerMove);
    slider.addEventListener("pointerup", onPointerUp);
    slider.addEventListener("lostpointercapture", () => {
      draggingRef.current = false;
      container.classList.remove("dragging");
    });

    return () => {
      slider.removeEventListener("pointerdown", onPointerDown);
      slider.removeEventListener("pointermove", onPointerMove);
      slider.removeEventListener("pointerup", onPointerUp);
    };
  }, [sessionId, mismatchEnabled]);

  // ── Mirror interactions between iframes ────────────────────────────
  // The server injects a mirror script into each proxied page (runs before
  // game code).  That script forwards native events to the parent via
  // postMessage.  Here we relay those messages to the OTHER iframe.
  useEffect(() => {
    const handleMessage = (msg) => {
      const d = msg.data;
      if (!d) return;

      // Which iframe sent the message?  Forward to the other one.
      const leftWin = leftIframeRef.current?.contentWindow;
      const rightWin = rightIframeRef.current?.contentWindow;
      if (!leftWin || !rightWin) return;

      if (msg.source !== leftWin) return;
      const target = rightWin;
      const relayDelay =
        typeof d.sentAt === "number" ? Math.max(0, Date.now() - d.sentAt) : -1;

      relayLogSeqRef.current += 1;

      if (d.__mirror) {
        updateRelayDiagnostics(relayDelay, "mirror");
        lastMirroredEventAtRef.current = performance.now();
        target.postMessage({ __mirrorReplay: true, ...d }, "*");
      }
      if (d.__mirrorWheel) {
        updateRelayDiagnostics(relayDelay, "wheel");
        lastMirroredEventAtRef.current = performance.now();
        target.postMessage({ __mirrorWheelReplay: true, ...d }, "*");
      }
      if (d.__mirrorKey) {
        updateRelayDiagnostics(relayDelay, "key");
        lastMirroredEventAtRef.current = performance.now();
        target.postMessage({ __mirrorKeyReplay: true, ...d }, "*");
      }
      if (d.__mirrorInput) {
        updateRelayDiagnostics(relayDelay, "input");
        if (!mismatchEnabledRef.current) {
          setSliderPos(1);
        }
        lastMirroredEventAtRef.current = performance.now();
        target.postMessage({ __mirrorInputReplay: true, ...d }, "*");
      }
      if (d.__betCapture) {
        updateRelayDiagnostics(relayDelay, "betCapture");
        lastMirroredEventAtRef.current = performance.now();
        target.postMessage({ __betCaptureReplay: true, ...d }, "*");
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [updateRelayDiagnostics]);

  // ── Canvas-based pixel diff ───────────────────────────────────────
  useEffect(() => {
    if (!mismatchEnabled || !iframesLoaded) {
      diagnosticsRef.current.diff.blankState =
        mismatchEnabled && !iframesLoaded ? "waiting-iframes" : "disabled";
      setMismatchPercent(-1);
      return;
    }

    const leftIframe = leftIframeRef.current;
    const rightIframe = rightIframeRef.current;
    const canvas = diffCanvasRef.current;
    if (!leftIframe || !rightIframe || !canvas) return;

    let cancelled = false;
    let targetIntervalMs = DIFF_TARGET_INTERVAL_MS;

    mismatchLogSeqRef.current += 1;
    const runId = mismatchLogSeqRef.current;
    diagnosticsRef.current.diff.runId = runId;

    let diffSeq = 0;
    let pdbChecked = false; // one-time preserveDrawingBuffer check
    let leftPdb = null;
    let rightPdb = null;
    let stableMismatchPct = -1;
    let pendingSpikeCount = 0;
    let pendingSpikeTarget = -1;
    const mismatchHistory = [];

    const medianOf = (values) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    };

    const checkPreserveDrawingBuffer = (gameCanvas, label) => {
      try {
        const gl =
          gameCanvas.getContext("webgl2") ||
          gameCanvas.getContext("webgl") ||
          gameCanvas.getContext("experimental-webgl");
        if (gl) {
          const attrs = gl.getContextAttributes();
          const preserveDrawingBuffer = Boolean(attrs?.preserveDrawingBuffer);
          if (label === "left") leftPdb = preserveDrawingBuffer;
          if (label === "right") rightPdb = preserveDrawingBuffer;
        } else {
          if (label === "left") leftPdb = false;
          if (label === "right") rightPdb = false;
        }
      } catch (e) {
        diagnosticsRef.current.latestError = `pdb-check-${label}: ${e.message}`;
      }
    };

    const collectOcclusionRects = (win, targetW, targetH) => {
      const rects = [];
      try {
        const doc = win?.document;
        if (!doc?.body) return rects;
        const viewW = Math.max(
          1,
          win.innerWidth || doc.documentElement.clientWidth || 1,
        );
        const viewH = Math.max(
          1,
          win.innerHeight || doc.documentElement.clientHeight || 1,
        );
        const scaleX = targetW / viewW;
        const scaleY = targetH / viewH;

        const candidates = doc.body.querySelectorAll("*");
        const maxScan = Math.min(candidates.length, 3000);

        for (let idx = 0; idx < maxScan; idx += 1) {
          const element = candidates[idx];
          if (!element || element.tagName === "CANVAS") continue;

          const style = win.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") <= 0 ||
            style.pointerEvents === "none"
          ) {
            continue;
          }

          const zIndex = Number.parseInt(style.zIndex || "0", 10);
          const isFloating =
            style.position === "fixed" ||
            style.position === "absolute" ||
            style.position === "sticky";
          if (!isFloating && zIndex < 50) {
            continue;
          }

          const rect = element.getBoundingClientRect();
          if (rect.width < 16 || rect.height < 16) continue;
          const areaRatio = (rect.width * rect.height) / (viewW * viewH);
          if (areaRatio < 0.005 || areaRatio > 0.98) continue;

          const x1 = clamp(Math.floor(rect.left * scaleX), 0, targetW - 1);
          const y1 = clamp(Math.floor(rect.top * scaleY), 0, targetH - 1);
          const x2 = clamp(Math.ceil(rect.right * scaleX), 0, targetW);
          const y2 = clamp(Math.ceil(rect.bottom * scaleY), 0, targetH);

          if (x2 - x1 > 2 && y2 - y1 > 2) {
            rects.push({ x1, y1, x2, y2 });
          }

          if (rects.length >= 40) break;
        }
      } catch {
        return [];
      }
      return rects;
    };

    const isOccluded = (x, y, rects) => {
      for (const rect of rects) {
        if (x >= rect.x1 && x < rect.x2 && y >= rect.y1 && y < rect.y2) {
          return true;
        }
      }
      return false;
    };

    // Reusable temp canvases (avoid creating per-frame)
    const tmpLeft = document.createElement("canvas");
    const ctxLeft = tmpLeft.getContext("2d", { willReadFrequently: true });
    const tmpRight = document.createElement("canvas");
    const ctxRight = tmpRight.getContext("2d", { willReadFrequently: true });
    let cachedLeftOccluders = [];
    let cachedRightOccluders = [];
    let prevLeftLuma = null;
    let prevRightLuma = null;
    let prevPrevLeftLuma = null;
    let prevPrevRightLuma = null;
    let hasPrevFrame = false;
    let hasPrevPrevFrame = false;
    let framesProcessed = 0;
    let loadSheddingFactor = 1;

    const computeDiff = () => {
      if (cancelled) return;
      const seq = ++diffSeq;
      const t0 = performance.now();

      try {
        const leftWin = leftIframe.contentWindow;
        const rightWin = rightIframe.contentWindow;
        if (!leftWin || !rightWin) return;

        const leftCanvas = leftWin.document.querySelector("canvas");
        const rightCanvas = rightWin.document.querySelector("canvas");
        if (!leftCanvas || !rightCanvas) {
          diagnosticsRef.current.diff.blankState = `nocanvas:L=${!!leftCanvas},R=${!!rightCanvas}`;
          diagnosticsRef.current.diff.frameSeq = seq;
          diagnosticsRef.current.diff.updatedAt = Date.now();
          setMismatchPercent(-1);
          return;
        }

        // One-time: check if preserveDrawingBuffer was applied
        if (!pdbChecked) {
          pdbChecked = true;
          checkPreserveDrawingBuffer(leftCanvas, "left");
          checkPreserveDrawingBuffer(rightCanvas, "right");
        }

        const sourceWidth = Math.min(leftCanvas.width, rightCanvas.width);
        const sourceHeight = Math.min(leftCanvas.height, rightCanvas.height);
        if (!sourceWidth || !sourceHeight) return;

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

        if (seq % 12 === 1) {
          cachedLeftOccluders = collectOcclusionRects(leftWin, dw, dh);
          cachedRightOccluders = collectOcclusionRects(rightWin, dw, dh);
        }
        const occlusionRects = [
          ...cachedLeftOccluders,
          ...cachedRightOccluders,
        ];

        // Resize temp canvases if needed
        if (tmpLeft.width !== dw || tmpLeft.height !== dh) {
          tmpLeft.width = dw;
          tmpLeft.height = dh;
          tmpRight.width = dw;
          tmpRight.height = dh;
          prevLeftLuma = new Float32Array(dw * dh);
          prevRightLuma = new Float32Array(dw * dh);
          prevPrevLeftLuma = new Float32Array(dw * dh);
          prevPrevRightLuma = new Float32Array(dw * dh);
          hasPrevFrame = false;
          hasPrevPrevFrame = false;
        }

        ctxLeft.drawImage(leftCanvas, 0, 0, dw, dh);
        const leftData = ctxLeft.getImageData(0, 0, dw, dh);
        ctxRight.drawImage(rightCanvas, 0, 0, dw, dh);
        const rightData = ctxRight.getImageData(0, 0, dw, dh);

        // Quick blank check (sample ~1000 pixels across the buffer)
        let leftSum = 0,
          rightSum = 0;
        const sampleStep = Math.max(1, Math.floor(leftData.data.length / 1000));
        for (let i = 0; i < leftData.data.length; i += sampleStep) {
          leftSum += leftData.data[i];
          rightSum += rightData.data[i];
        }

        // If both canvases are blank, skip expensive diff (game still loading)
        if (leftSum === 0 && rightSum === 0) {
          diagnosticsRef.current.diff.blankState = "both-blank";
          diagnosticsRef.current.diff.frameSeq = seq;
          diagnosticsRef.current.diff.updatedAt = Date.now();
          setMismatchPercent(-1);
          // Clear the overlay canvas
          canvas.width = dw;
          canvas.height = dh;
          return;
        }

        // If only one is blank, log but still compute
        if (leftSum === 0 || rightSum === 0) {
          diagnosticsRef.current.diff.blankState =
            leftSum === 0 ? "left-blank" : "right-blank";
        } else {
          diagnosticsRef.current.diff.blankState = "ok";
        }

        const tCapture = performance.now();

        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");

        // Compute diff
        const output = ctx.createImageData(dw, dh);
        let mismatchCount = 0;
        const totalPixels = dw * dh;
        const sinceMirror = t0 - lastMirroredEventAtRef.current;
        const isActiveWindow =
          sinceMirror >= 0 && sinceMirror < DIFF_ACTIVE_WINDOW_MS;
        const sampleTarget = isActiveWindow
          ? DIFF_TARGET_SAMPLES_ACTIVE
          : DIFF_TARGET_SAMPLES_IDLE;
        const effectiveSampleTarget = Math.max(
          20000,
          Math.floor(sampleTarget / loadSheddingFactor),
        );
        const maxStep = loadSheddingFactor >= 3 ? 8 : 6;
        const step = Math.min(
          maxStep,
          Math.max(
            1,
            Math.ceil(Math.sqrt(totalPixels / effectiveSampleTarget)),
          ),
        );
        let sampledPixels = 0;
        let comparedPixels = 0;
        let dynamicSkipped = 0;

        for (let y = 0; y < dh; y += step) {
          for (let x = 0; x < dw; x += step) {
            const i = (y * dw + x) * 4;
            if (isOccluded(x, y, occlusionRects)) {
              continue;
            }
            const pixelIndex = y * dw + x;
            const leftLuma =
              (leftData.data[i] * 0.2126 +
                leftData.data[i + 1] * 0.7152 +
                leftData.data[i + 2] * 0.0722) /
              255;
            const rightLuma =
              (rightData.data[i] * 0.2126 +
                rightData.data[i + 1] * 0.7152 +
                rightData.data[i + 2] * 0.0722) /
              255;

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
            if (isMismatch) mismatchCount++;

            const alpha = isMismatch ? 220 : 0;

            // Fill block
            for (let dy = 0; dy < step; dy++) {
              for (let dx = 0; dx < step; dx++) {
                const px = x + dx;
                const py = y + dy;
                if (px >= dw || py >= dh) continue;
                const oi = (py * dw + px) * 4;
                output.data[oi] = alpha ? 255 : 0;
                output.data[oi + 1] = 0;
                output.data[oi + 2] = 0;
                output.data[oi + 3] = alpha;
              }
            }
          }
        }

        framesProcessed += 1;
        hasPrevFrame = framesProcessed >= 1;
        hasPrevPrevFrame = framesProcessed >= 2;

        ctx.putImageData(output, 0, 0);
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
          targetIntervalMs = Math.min(
            DIFF_MAX_INTERVAL_MS,
            targetIntervalMs + 8,
          );
        } else if (computeMs < targetIntervalMs * 0.45) {
          targetIntervalMs = Math.max(
            DIFF_TARGET_INTERVAL_MS,
            targetIntervalMs - 5,
          );
        }

        diagnosticsRef.current.diff = {
          runId,
          frameSeq: seq,
          dims: `${dw}x${dh}`,
          mismatchPct: pct,
          rawMismatchPct: rawPct,
          threshold,
          sampledPixels,
          comparedPixels,
          mismatchPixels: mismatchCount,
          dynamicSkipped,
          occluders: occlusionRects.length,
          step,
          loadShedding: Number(loadSheddingFactor.toFixed(2)),
          intervalMs: targetIntervalMs,
          downscale: Number(downscale.toFixed(2)),
          computeMs: Number(computeMs.toFixed(2)),
          captureMs: Number((tCapture - t0).toFixed(2)),
          totalMs: Number((tEnd - t0).toFixed(2)),
          blankState: diagnosticsRef.current.diff.blankState || "ok",
          hasPrevFrame,
          hasPrevPrevFrame,
          excludeDynamicAnimations,
          isActiveWindow,
          leftPreserveDrawingBuffer: leftPdb,
          rightPreserveDrawingBuffer: rightPdb,
          updatedAt: Date.now(),
        };
        setMismatchPercent(pct);
      } catch (err) {
        diagnosticsRef.current.latestError =
          err instanceof Error ? err.message : String(err);
        diagnosticsRef.current.diff.blankState = "error";
        diagnosticsRef.current.diff.updatedAt = Date.now();
        setMismatchPercent(-1);
      }
    };

    let lastRun = 0;
    const loop = (now) => {
      if (cancelled) return;
      if (now - lastRun >= targetIntervalMs) {
        lastRun = now;
        computeDiff();
      }
      rafId = requestAnimationFrame(loop);
    };
    let rafId = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [mismatchEnabled, iframesLoaded, threshold, excludeDynamicAnimations]);

  // ── URL helpers ───────────────────────────────────────────────────

  const applyUrls = useCallback(async (leftUrl, rightUrl) => {
    setFormBusy(true);
    setServerError("");
    setLeftInputError("");
    setRightInputError("");
    setStatusMessage("Setting up proxy session...");
    setIframeLoadGen(0);

    try {
      // Tear down previous session
      if (sessionRef.current) {
        await fetch(`/api/live/session/${sessionRef.current}`, {
          method: "DELETE",
        }).catch(() => {});
      }

      const response = await fetch("/api/live/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leftUrl, rightUrl }),
      });

      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.error || "Could not create session.";
        setServerError(message);
        setLeftInputError(message);
        setRightInputError(message);
        setSessionId("");
        sessionRef.current = null;
        setStatusMessage("Session failed to start.");
        return;
      }

      const {
        sessionId: sid,
        leftProxyBase,
        rightProxyBase,
        leftPath,
        rightPath,
      } = payload;
      sessionRef.current = sid;
      setSessionId(sid);
      diagnosticsRef.current = {
        ...diagnosticsRef.current,
        sessionStartAt: Date.now(),
        relayCount: 0,
        relayDelayMs: { last: -1, avg: -1, max: -1 },
        relayTypes: {
          mirror: 0,
          wheel: 0,
          key: 0,
          input: 0,
          betCapture: 0,
        },
        iframeLoads: {
          left: { count: 0, lastAt: 0 },
          right: { count: 0, lastAt: 0 },
        },
        latestError: "",
      };
      setIframeLoadGen(0); // reset so we wait for both new iframes to load
      setLeftProxyUrl(`${leftProxyBase}${leftPath}`);
      setRightProxyUrl(`${rightProxyBase}${rightPath}`);
      setLeftName(leftUrl || "Website A");
      setRightName(rightUrl || "Website B");
      setStatusMessage(
        "Live comparison active — websites render natively in your browser.",
      );
      setIsFormCollapsed(true);
    } catch {
      setServerError(
        "Live backend is unavailable. Start it with: npm run dev:live",
      );
      setSessionId("");
      sessionRef.current = null;
      setStatusMessage("Session failed to start.");
    } finally {
      setFormBusy(false);
    }
  }, []);

  const handleIframeLoad = useCallback((side) => {
    // Increment generation so mirroring effect re-attaches to fresh docs
    setIframeLoadGen((g) => g + 1);
    const now = Date.now();
    if (side === "left") {
      diagnosticsRef.current.iframeLoads.left.count += 1;
      diagnosticsRef.current.iframeLoads.left.lastAt = now;
    }
    if (side === "right") {
      diagnosticsRef.current.iframeLoads.right.count += 1;
      diagnosticsRef.current.iframeLoads.right.lastAt = now;
    }
  }, []);

  return (
    <div className="app">
      <TopBar
        sourceMode="url"
        onGoFiles={() => navigate("/")}
        onGoLive={() => navigate("/live")}
      />

      <LiveSourceForm
        onApplyUrls={applyUrls}
        leftInputError={leftInputError}
        rightInputError={rightInputError}
        leftName={leftName}
        rightName={rightName}
        collapsed={isFormCollapsed}
        onToggleCollapse={() => setIsFormCollapsed((prev) => !prev)}
        disabled={formBusy}
        title="Live Website Comparison"
        placeholders={[
          "https://example.com/site-a",
          "https://example.com/site-b",
        ]}
      />

      {serverError && <WarningBanner message={serverError} />}

      <section className="website-stack panel-block">
        <div className="website-stack-header">
          <h2>Live Comparison</h2>
          <span>{statusMessage}</span>
        </div>

        <div className="website-mismatch-controls">
          <label className="website-toggle">
            <input
              type="checkbox"
              checked={mismatchEnabled}
              onChange={(e) => setMismatchEnabled(e.target.checked)}
              disabled={!sessionId}
            />
            Pixel mismatch overlay
          </label>

          <label className="website-threshold">
            Threshold: {threshold.toFixed(2)}
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              disabled={!sessionId || !mismatchEnabled}
            />
          </label>

          <label className="website-toggle">
            <input
              type="checkbox"
              checked={excludeDynamicAnimations}
              onChange={(e) => setExcludeDynamicAnimations(e.target.checked)}
              disabled={!sessionId || !mismatchEnabled}
            />
            Exclude dynamic animations
          </label>

          {mismatchEnabled && mismatchPercent >= 0 && (
            <span className="website-mismatch-stat">
              Mismatch: {mismatchPercent.toFixed(1)}%
            </span>
          )}
        </div>

        {/* Top stage: URL1 base (interactive), URL2 clipped overlay for visual diff */}
        <div
          className={`website-stage ${sessionId ? "active" : ""}`}
          ref={topContainerRef}
        >
          {sessionId ? (
            <>
              {/* URL1 (base) iframe */}
              <iframe
                ref={leftIframeRef}
                src={leftProxyUrl}
                title="URL1 website"
                className="website-iframe website-layer-base"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onLoad={() => handleIframeLoad("left")}
              />

              {/* URL2 overlay stream (non-interactive) */}
              <div
                className="website-compare-overlay"
                style={
                  mismatchEnabled
                    ? { opacity: 0, pointerEvents: "none" }
                    : {
                        clipPath: `inset(0 ${100 - sliderPos * 100}% 0 0)`,
                        pointerEvents: "none",
                      }
                }
              >
                <iframe
                  ref={rightIframeRef}
                  src={rightProxyUrl}
                  title="URL2 website"
                  className="website-iframe website-layer-overlay"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  onLoad={() => handleIframeLoad("right")}
                />
              </div>

              {/* Diff canvas overlay */}
              {mismatchEnabled && (
                <canvas
                  ref={diffCanvasRef}
                  className="website-frame mismatch-layer"
                />
              )}
              {!mismatchEnabled && (
                <div
                  ref={sliderRef}
                  className="website-slider-handle"
                  style={{ left: `${sliderPos * 100}%` }}
                />
              )}
            </>
          ) : (
            <div className="website-placeholder">
              Load URLs to start website rendering.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default LiveWebsiteCompare;
