import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../App.css";
import LiveSourceForm from "./LiveSourceForm.jsx";
import TopBar from "./TopBar.jsx";
import WarningBanner from "./WarningBanner.jsx";
import "../styles/LiveWebsiteCompare.css";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const DIFF_TARGET_INTERVAL_MS = 66;
const OCCLUSION_REFRESH_MIN_MS = 250;

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
  //
  // Wheel events are coalesced to one postMessage per animation frame
  // because they fire 60+ Hz during a scroll gesture — relaying each one
  // doubles the main-thread message work and queues up behind any layout.
  useEffect(() => {
    let pendingWheel = null;
    let wheelRaf = 0;

    const flushWheel = () => {
      wheelRaf = 0;
      const buf = pendingWheel;
      pendingWheel = null;
      if (!buf) return;
      const rightWin = rightIframeRef.current?.contentWindow;
      if (!rightWin) return;
      buf.__mirrorWheelReplay = true;
      rightWin.postMessage(buf, "*");
    };

    const handleMessage = (msg) => {
      const d = msg.data;
      if (!d) return;

      const leftWin = leftIframeRef.current?.contentWindow;
      const rightWin = rightIframeRef.current?.contentWindow;
      if (!leftWin || !rightWin) return;

      if (msg.source !== leftWin) return;

      const relayDelay =
        typeof d.sentAt === "number" ? Math.max(0, Date.now() - d.sentAt) : -1;

      relayLogSeqRef.current += 1;

      if (d.__mirror) {
        updateRelayDiagnostics(relayDelay, "mirror");
        lastMirroredEventAtRef.current = performance.now();
        // Mutate in place — the sender won't read this object again and
        // we skip a full structured-clone of hint text/classes.
        d.__mirrorReplay = true;
        rightWin.postMessage(d, "*");
        return;
      }
      if (d.__mirrorWheel) {
        updateRelayDiagnostics(relayDelay, "wheel");
        lastMirroredEventAtRef.current = performance.now();
        if (pendingWheel && pendingWheel.dm === d.dm) {
          pendingWheel.dx += d.dx;
          pendingWheel.dy += d.dy;
          pendingWheel.cx = d.cx;
          pendingWheel.cy = d.cy;
          pendingWheel.sentAt = d.sentAt;
        } else {
          if (pendingWheel) {
            // Different delta mode — flush previous batch synchronously.
            pendingWheel.__mirrorWheelReplay = true;
            rightWin.postMessage(pendingWheel, "*");
          }
          pendingWheel = {
            __mirrorWheel: true,
            dx: d.dx,
            dy: d.dy,
            dm: d.dm,
            cx: d.cx,
            cy: d.cy,
            sentAt: d.sentAt,
          };
        }
        if (!wheelRaf) {
          wheelRaf = requestAnimationFrame(flushWheel);
        }
        return;
      }
      if (d.__mirrorKey) {
        updateRelayDiagnostics(relayDelay, "key");
        lastMirroredEventAtRef.current = performance.now();
        d.__mirrorKeyReplay = true;
        rightWin.postMessage(d, "*");
        return;
      }
      if (d.__mirrorInput) {
        updateRelayDiagnostics(relayDelay, "input");
        if (!mismatchEnabledRef.current) {
          setSliderPos(1);
        }
        lastMirroredEventAtRef.current = performance.now();
        d.__mirrorInputReplay = true;
        rightWin.postMessage(d, "*");
        return;
      }
      if (d.__betCapture) {
        updateRelayDiagnostics(relayDelay, "betCapture");
        lastMirroredEventAtRef.current = performance.now();
        d.__betCaptureReplay = true;
        rightWin.postMessage(d, "*");
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      if (wheelRaf) cancelAnimationFrame(wheelRaf);
      pendingWheel = null;
    };
  }, [updateRelayDiagnostics]);

  // ── Pixel diff (worker-driven) ────────────────────────────────────
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

    let pdbChecked = false;
    let leftPdb = null;
    let rightPdb = null;

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

    // ── Occlusion cache ─────────────────────────────────────────────
    // Replaces the old every-12-frames full DOM scan. The mask is a flat
    // Uint8Array sized to the downscaled diff dimensions; the worker does
    // one index lookup per sampled pixel.
    let cachedOcclusionMask = null;
    let cachedMaskDims = { dw: 0, dh: 0 };
    let cachedRectCount = 0;
    let lastOcclusionRefresh = 0;
    let occlusionDirty = true;
    const FAST_OCCLUDER_SEL =
      '[style*="position: fixed"],[style*="position:fixed"],' +
      '[style*="position: sticky"],[style*="position:sticky"],' +
      '[class*="modal"],[class*="overlay"],[class*="popup"],' +
      "[data-modal],dialog";

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

        let candidates = doc.body.querySelectorAll(FAST_OCCLUDER_SEL);
        if (candidates.length === 0) {
          candidates = doc.body.querySelectorAll("*");
        }
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

    const buildOcclusionMask = (dw, dh) => {
      if (
        !occlusionDirty &&
        cachedOcclusionMask &&
        cachedMaskDims.dw === dw &&
        cachedMaskDims.dh === dh
      ) {
        return { mask: cachedOcclusionMask, count: cachedRectCount };
      }
      const now = performance.now();
      if (
        !occlusionDirty &&
        cachedOcclusionMask &&
        now - lastOcclusionRefresh < OCCLUSION_REFRESH_MIN_MS
      ) {
        return { mask: cachedOcclusionMask, count: cachedRectCount };
      }
      lastOcclusionRefresh = now;
      occlusionDirty = false;

      const leftWin = leftIframe.contentWindow;
      const rightWin = rightIframe.contentWindow;
      const leftRects = leftWin ? collectOcclusionRects(leftWin, dw, dh) : [];
      const rightRects = rightWin
        ? collectOcclusionRects(rightWin, dw, dh)
        : [];
      const allRects = leftRects.concat(rightRects);

      const mask = new Uint8Array(dw * dh);
      for (let r = 0; r < allRects.length; r++) {
        const { x1, y1, x2, y2 } = allRects[r];
        for (let y = y1; y < y2; y++) {
          const rowStart = y * dw;
          for (let x = x1; x < x2; x++) {
            mask[rowStart + x] = 1;
          }
        }
      }
      cachedOcclusionMask = mask;
      cachedMaskDims = { dw, dh };
      cachedRectCount = allRects.length;
      return { mask, count: allRects.length };
    };

    const invalidateOcclusion = () => {
      occlusionDirty = true;
    };

    // Wire invalidation to scroll/resize + DOM mutations (debounced by the
    // OCCLUSION_REFRESH_MIN_MS check inside buildOcclusionMask).
    const mutationObservers = [];
    const teardownObservers = [];
    const attachObservers = (win) => {
      try {
        const doc = win?.document;
        if (!doc?.body) return;
        const mo = new win.MutationObserver(invalidateOcclusion);
        mo.observe(doc.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class", "style"],
        });
        mutationObservers.push(mo);
        const onScroll = invalidateOcclusion;
        const onResize = invalidateOcclusion;
        win.addEventListener("scroll", onScroll, {
          capture: true,
          passive: true,
        });
        win.addEventListener("resize", onResize);
        teardownObservers.push(() => {
          mo.disconnect();
          win.removeEventListener("scroll", onScroll, { capture: true });
          win.removeEventListener("resize", onResize);
        });
      } catch {
        // cross-origin or not-ready; best-effort only
      }
    };
    attachObservers(leftIframe.contentWindow);
    attachObservers(rightIframe.contentWindow);

    // ── Worker wiring ───────────────────────────────────────────────
    const worker = new Worker(
      new URL("../workers/diffWorker.js", import.meta.url),
      { type: "module" },
    );

    const ctx = canvas.getContext("2d");
    let workerBusy = false;
    let nextFrameId = 0;

    worker.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "diff-result") {
        workerBusy = false;
        if (data.intervalMs) targetIntervalMs = data.intervalMs;
        const stats = data.stats;
        const bitmap = data.bitmap;
        if (bitmap) {
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close?.();
        }
        diagnosticsRef.current.diff = {
          runId,
          ...stats,
          leftPreserveDrawingBuffer: leftPdb,
          rightPreserveDrawingBuffer: rightPdb,
          updatedAt: Date.now(),
        };
        setMismatchPercent(stats.mismatchPct);
      } else if (data.type === "diff-error") {
        workerBusy = false;
        if (data.intervalMs) targetIntervalMs = data.intervalMs;
        diagnosticsRef.current.latestError = data.error || "worker-error";
        diagnosticsRef.current.diff.blankState = "error";
        diagnosticsRef.current.diff.updatedAt = Date.now();
        setMismatchPercent(-1);
      }
    };

    const submitFrame = async () => {
      if (cancelled || workerBusy) return;
      try {
        const leftWin = leftIframe.contentWindow;
        const rightWin = rightIframe.contentWindow;
        if (!leftWin || !rightWin) return;

        const leftCanvas = leftWin.document.querySelector("canvas");
        const rightCanvas = rightWin.document.querySelector("canvas");
        if (!leftCanvas || !rightCanvas) {
          diagnosticsRef.current.diff.blankState = `nocanvas:L=${!!leftCanvas},R=${!!rightCanvas}`;
          diagnosticsRef.current.diff.updatedAt = Date.now();
          setMismatchPercent(-1);
          return;
        }

        if (!pdbChecked) {
          pdbChecked = true;
          checkPreserveDrawingBuffer(leftCanvas, "left");
          checkPreserveDrawingBuffer(rightCanvas, "right");
        }

        const sourceWidth = Math.min(leftCanvas.width, rightCanvas.width);
        const sourceHeight = Math.min(leftCanvas.height, rightCanvas.height);
        if (!sourceWidth || !sourceHeight) return;

        // Downscale selection must stay in sync with the worker's
        // computation so the occlusion mask dimensions match. Mirror the
        // logic here using the diagnostics loadShedding feedback value.
        const lf = diagnosticsRef.current.diff.loadShedding || 1;
        const downscale =
          lf >= 3.5 ? 1.8 : lf >= 2.5 ? 1.5 : lf >= 1.7 ? 1.25 : 1;
        const dw = Math.max(1, Math.round(sourceWidth / downscale));
        const dh = Math.max(1, Math.round(sourceHeight / downscale));

        const { mask, count } = buildOcclusionMask(dw, dh);

        const tCaptureStart = performance.now();
        const [leftBitmap, rightBitmap] = await Promise.all([
          createImageBitmap(leftCanvas),
          createImageBitmap(rightCanvas),
        ]);
        const captureMs = performance.now() - tCaptureStart;
        if (cancelled) {
          leftBitmap.close?.();
          rightBitmap.close?.();
          return;
        }

        workerBusy = true;
        const frameId = ++nextFrameId;
        const sinceMirror =
          performance.now() - lastMirroredEventAtRef.current;

        const transferable = [leftBitmap, rightBitmap];
        // Mask buffer is reused across frames (cache). Don't transfer it;
        // copy cheaply by re-sending a shared reference isn't possible via
        // structured clone without detach — so we pass it by value.
        // To avoid cloning the mask repeatedly when unchanged, send a
        // lightweight view by slicing (same memory cost but keeps API
        // simple).
        worker.postMessage(
          {
            type: "diff",
            id: frameId,
            leftBitmap,
            rightBitmap,
            sourceWidth,
            sourceHeight,
            threshold,
            excludeDynamicAnimations,
            sinceMirror,
            occlusionMask: mask,
            occlusionCount: count,
            captureMs,
          },
          transferable,
        );
      } catch (err) {
        workerBusy = false;
        diagnosticsRef.current.latestError =
          err instanceof Error ? err.message : String(err);
        diagnosticsRef.current.diff.blankState = "error";
        diagnosticsRef.current.diff.updatedAt = Date.now();
        setMismatchPercent(-1);
      }
    };

    let lastRun = 0;
    let rafId = 0;
    const loop = (now) => {
      if (cancelled) return;
      if (!workerBusy && now - lastRun >= targetIntervalMs) {
        lastRun = now;
        submitFrame();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      worker.postMessage({ type: "reset" });
      worker.terminate();
      for (const fn of teardownObservers) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
      mutationObservers.length = 0;
      teardownObservers.length = 0;
      cachedOcclusionMask = null;
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
      setIframeLoadGen(0);
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

        <div
          className={`website-stage ${sessionId ? "active" : ""}`}
          ref={topContainerRef}
        >
          {sessionId ? (
            <>
              <iframe
                ref={leftIframeRef}
                src={leftProxyUrl}
                title="URL1 website"
                className="website-iframe website-layer-base"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onLoad={() => handleIframeLoad("left")}
              />

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
