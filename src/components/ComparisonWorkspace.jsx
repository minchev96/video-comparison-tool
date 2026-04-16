import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../App.css";
import CompareView from "./CompareView.jsx";
import ComparisonControls from "./ComparisonControls.jsx";
import DropZoneRow from "./DropZoneRow.jsx";
import LiveSourceForm from "./LiveSourceForm.jsx";
import QualityChecks from "./QualityChecks.jsx";
import TopBar from "./TopBar.jsx";
import WarningBanner from "./WarningBanner.jsx";

const FPS_CAP = 40;
const STEP_SECONDS = 1;
const SYNC_TOLERANCE_SECONDS = 1 / 60;
const SPIKE_MISMATCH_RATIO = 0.8;
const PRE_SPIKE_MISMATCH_RATIO = 0.6;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const formatSourceName = (urlString, fallbackLabel) => {
  try {
    const parsed = new URL(urlString);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return lastSegment || parsed.host || fallbackLabel;
  } catch {
    return fallbackLabel;
  }
};

function ComparisonWorkspace({ sourceMode }) {
  const [leftSrc, setLeftSrc] = useState(null);
  const [rightSrc, setRightSrc] = useState(null);
  const [leftName, setLeftName] = useState("");
  const [rightName, setRightName] = useState("");
  const [leftLoaded, setLeftLoaded] = useState(false);
  const [rightLoaded, setRightLoaded] = useState(false);
  const [leftInputError, setLeftInputError] = useState("");
  const [rightInputError, setRightInputError] = useState("");
  const [sliderPos, setSliderPos] = useState(0.5);
  const [mismatchEnabled, setMismatchEnabled] = useState(true);
  const [threshold, setThreshold] = useState(0.05);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [leftMeta, setLeftMeta] = useState({
    width: 0,
    height: 0,
    duration: 0,
  });
  const [rightMeta, setRightMeta] = useState({
    width: 0,
    height: 0,
    duration: 0,
  });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState(false);

  const leftVideoRef = useRef(null);
  const rightVideoRef = useRef(null);
  const overlayRef = useRef(null);
  const compareAreaRef = useRef(null);
  const compareWrapperRef = useRef(null);
  const offscreenLeftRef = useRef(null);
  const offscreenRightRef = useRef(null);
  const offscreenMismatchRef = useRef(null);
  const isSyncingRef = useRef(false);
  const isSeekingRef = useRef(false);
  const lastMismatchRatioRef = useRef(0);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const leftObjectUrlRef = useRef(null);
  const rightObjectUrlRef = useRef(null);

  const navigate = useNavigate();

  const bothLoaded = leftLoaded && rightLoaded;
  const sameNameWarning =
    leftName && rightName && leftName.toLowerCase() === rightName.toLowerCase();
  const durationMismatch =
    bothLoaded && Math.abs(leftMeta.duration - rightMeta.duration) > 0.1;
  const resolutionMismatch =
    bothLoaded &&
    (leftMeta.width !== rightMeta.width ||
      leftMeta.height !== rightMeta.height);
  const effectiveDuration = useMemo(() => {
    if (!bothLoaded) return 0;
    return Math.min(leftMeta.duration || 0, rightMeta.duration || 0);
  }, [bothLoaded, leftMeta.duration, rightMeta.duration]);

  useEffect(() => {
    offscreenLeftRef.current = document.createElement("canvas");
    offscreenRightRef.current = document.createElement("canvas");
    offscreenMismatchRef.current = document.createElement("canvas");
  }, []);

  useEffect(() => {
    return () => {
      if (leftObjectUrlRef.current)
        URL.revokeObjectURL(leftObjectUrlRef.current);
      if (rightObjectUrlRef.current)
        URL.revokeObjectURL(rightObjectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const wrapper = compareWrapperRef.current;
    if (!wrapper) return undefined;

    const handleWheelEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY > 0 ? -0.08 : 0.08;
      setZoom((prev) => clamp(prev + delta, 0.4, 3));
    };

    wrapper.addEventListener("wheel", handleWheelEvent, { passive: false });
    return () => wrapper.removeEventListener("wheel", handleWheelEvent);
  }, []);

  useEffect(() => {
    if (!bothLoaded) return;
    if (isPlaying) {
      Promise.all([
        leftVideoRef.current?.play(),
        rightVideoRef.current?.play(),
      ]).catch(() => {
        setIsPlaying(false);
      });
    } else {
      leftVideoRef.current?.pause();
      rightVideoRef.current?.pause();
    }
  }, [isPlaying, bothLoaded]);

  useEffect(() => {
    if (!mismatchEnabled) {
      const overlay = overlayRef.current;
      if (overlay) {
        const ctx = overlay.getContext("2d");
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
      }
      lastMismatchRatioRef.current = 0;
    }
  }, [mismatchEnabled]);

  const resetComparisonState = () => {
    setIsPlaying(false);
    setCurrentTime(0);
    setLeftLoaded(false);
    setRightLoaded(false);
    setSliderPos(0.5);
    setLeftMeta({ width: 0, height: 0, duration: 0 });
    setRightMeta({ width: 0, height: 0, duration: 0 });
    setDismissedWarning(false);
    setLeftInputError("");
    setRightInputError("");
    lastMismatchRatioRef.current = 0;
  };

  const resetSideState = (side) => {
    setIsPlaying(false);
    setCurrentTime(0);
    setSliderPos(0.5);
    setDismissedWarning(false);
    lastMismatchRatioRef.current = 0;

    if (side === "left") {
      setLeftLoaded(false);
      setLeftMeta({ width: 0, height: 0, duration: 0 });
      setLeftInputError("");
      return;
    }

    setRightLoaded(false);
    setRightMeta({ width: 0, height: 0, duration: 0 });
    setRightInputError("");
  };

  const setVideoMeta = (side, video) => {
    if (!video) return;
    const data = {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration || 0,
    };
    if (side === "left") {
      setLeftMeta(data);
      setLeftLoaded(true);
      setLeftInputError("");
    } else {
      setRightMeta(data);
      setRightLoaded(true);
      setRightInputError("");
    }
  };

  const handleVideoError = (side) => {
    const errorMessage =
      side === "left"
        ? "Left URL could not be loaded. Ensure it allows direct video playback and CORS access."
        : "Right URL could not be loaded. Ensure it allows direct video playback and CORS access.";

    if (side === "left") {
      setLeftLoaded(false);
      setLeftInputError(errorMessage);
    } else {
      setRightLoaded(false);
      setRightInputError(errorMessage);
    }
    setIsPlaying(false);
  };

  const handleTimeUpdate = () => {
    if (!bothLoaded) return;
    if (isSyncingRef.current || isSeekingRef.current) return;
    const leftVideo = leftVideoRef.current;
    const rightVideo = rightVideoRef.current;
    if (!leftVideo || !rightVideo) return;
    const diff = Math.abs(leftVideo.currentTime - rightVideo.currentTime);
    if (diff > SYNC_TOLERANCE_SECONDS) {
      isSyncingRef.current = true;
      rightVideo.currentTime = leftVideo.currentTime;
      isSyncingRef.current = false;
    }
    setCurrentTime(leftVideo.currentTime);
  };

  const seekTo = useCallback(
    (time) => {
      if (!bothLoaded) return;
      const leftVideo = leftVideoRef.current;
      const rightVideo = rightVideoRef.current;
      if (!leftVideo || !rightVideo) return;
      isSyncingRef.current = true;
      leftVideo.currentTime = time;
      rightVideo.currentTime = time;
      setCurrentTime(time);
      isSyncingRef.current = false;
    },
    [bothLoaded],
  );

  const togglePlay = useCallback(() => {
    if (!bothLoaded) return;
    setIsPlaying((prev) => !prev);
  }, [bothLoaded]);

  const stepTime = useCallback(
    (delta) => {
      if (!bothLoaded) return;
      const leftVideo = leftVideoRef.current;
      const baseTime = leftVideo?.currentTime ?? currentTime;
      const next = clamp(baseTime + delta, 0, effectiveDuration);
      setIsPlaying(false);
      seekTo(next);
    },
    [bothLoaded, currentTime, effectiveDuration, seekTo],
  );

  const handleSeekChange = (event) => {
    const value = Number(event.target.value);
    isSeekingRef.current = true;
    seekTo(value);
  };

  const handleSeekEnd = () => {
    isSeekingRef.current = false;
  };

  const handleMouseMove = (event) => {
    const rect = compareAreaRef.current?.getBoundingClientRect();
    if (rect && !mismatchEnabled) {
      const screenX = clamp(event.clientX - rect.left, 0, rect.width);
      const centerX = rect.width / 2;
      const layerX = (screenX - pan.x - centerX) / zoom + centerX;
      const videoWidth = leftMeta.width || rightMeta.width;
      const videoHeight = leftMeta.height || rightMeta.height;
      let imgLeft = 0;
      let imgWidth = rect.width;

      if (videoWidth && videoHeight) {
        const scale = Math.min(
          rect.width / videoWidth,
          rect.height / videoHeight,
        );
        imgWidth = videoWidth * scale;
        imgLeft = (rect.width - imgWidth) / 2;
      }

      const ratioInImage = clamp((layerX - imgLeft) / imgWidth, 0, 1);
      const sliderLayerRatio = clamp(
        (imgLeft + ratioInImage * imgWidth) / rect.width,
        0,
        1,
      );
      setSliderPos(sliderLayerRatio);
    }
    if (isPanning) {
      const dx = event.clientX - lastMouseRef.current.x;
      const dy = event.clientY - lastMouseRef.current.y;
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
    }
  };

  const handleMouseDown = (event) => {
    if (event.button === 2) {
      event.preventDefault();
      setIsPanning(true);
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleClick = (event) => {
    if (event.button !== 0) return;
    if (bothLoaded) togglePlay();
  };

  const assignFileSource = (file, side) => {
    if (!file || !file.type.startsWith("video/")) return;
    const objectUrl = URL.createObjectURL(file);
    if (side === "left") {
      if (leftObjectUrlRef.current)
        URL.revokeObjectURL(leftObjectUrlRef.current);
      leftObjectUrlRef.current = objectUrl;
      setLeftSrc(objectUrl);
      setLeftName(file.name);
    } else {
      if (rightObjectUrlRef.current)
        URL.revokeObjectURL(rightObjectUrlRef.current);
      rightObjectUrlRef.current = objectUrl;
      setRightSrc(objectUrl);
      setRightName(file.name);
    }
  };

  const handleDrop = (event, side) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("video/")) return;
    resetSideState(side);
    assignFileSource(file, side);
  };

  const handleFileSelect = (event, side) => {
    const file = event.target.files?.[0];
    if (!file) return;
    resetSideState(side);
    assignFileSource(file, side);
  };

  const applyUrlSources = (leftUrl, rightUrl) => {
    if (leftObjectUrlRef.current) {
      URL.revokeObjectURL(leftObjectUrlRef.current);
      leftObjectUrlRef.current = null;
    }
    if (rightObjectUrlRef.current) {
      URL.revokeObjectURL(rightObjectUrlRef.current);
      rightObjectUrlRef.current = null;
    }

    resetComparisonState();
    setLeftSrc(leftUrl);
    setRightSrc(rightUrl);
    setLeftName(formatSourceName(leftUrl, "Left URL"));
    setRightName(formatSourceName(rightUrl, "Right URL"));
  };

  const drawMismatch = useCallback(() => {
    const leftVideo = leftVideoRef.current;
    const rightVideo = rightVideoRef.current;
    const overlay = overlayRef.current;
    if (!leftVideo || !rightVideo || !overlay) return;
    if (!leftVideo.videoWidth || !rightVideo.videoWidth) return;

    const leftTime = leftVideo.currentTime || 0;
    const rightTime = rightVideo.currentTime || 0;
    const timeDelta = Math.abs(leftTime - rightTime);
    if (timeDelta > SYNC_TOLERANCE_SECONDS) return;

    const targetWidth = Math.min(leftVideo.videoWidth, rightVideo.videoWidth);
    const targetHeight = Math.min(
      leftVideo.videoHeight,
      rightVideo.videoHeight,
    );

    const leftCanvas = offscreenLeftRef.current;
    const rightCanvas = offscreenRightRef.current;
    leftCanvas.width = targetWidth;
    leftCanvas.height = targetHeight;
    rightCanvas.width = targetWidth;
    rightCanvas.height = targetHeight;

    const leftCtx = leftCanvas.getContext("2d", { willReadFrequently: true });
    const rightCtx = rightCanvas.getContext("2d", { willReadFrequently: true });
    if (!leftCtx || !rightCtx) return;

    leftCtx.drawImage(leftVideo, 0, 0, targetWidth, targetHeight);
    rightCtx.drawImage(rightVideo, 0, 0, targetWidth, targetHeight);

    const leftData = leftCtx.getImageData(0, 0, targetWidth, targetHeight);
    const rightData = rightCtx.getImageData(0, 0, targetWidth, targetHeight);
    const overlayCtx = overlay.getContext("2d");
    if (!overlayCtx) return;

    const areaRect = compareAreaRef.current?.getBoundingClientRect();
    if (!areaRect?.width || !areaRect?.height) return;

    const devicePixelRatio = window.devicePixelRatio || 1;
    const overlayBitmapWidth = Math.max(
      1,
      Math.round(areaRect.width * devicePixelRatio),
    );
    const overlayBitmapHeight = Math.max(
      1,
      Math.round(areaRect.height * devicePixelRatio),
    );

    if (
      overlay.width !== overlayBitmapWidth ||
      overlay.height !== overlayBitmapHeight
    ) {
      overlay.width = overlayBitmapWidth;
      overlay.height = overlayBitmapHeight;
    }

    const fitScale = Math.min(
      areaRect.width / targetWidth,
      areaRect.height / targetHeight,
    );
    const videoDrawWidth = targetWidth * fitScale;
    const videoDrawHeight = targetHeight * fitScale;
    const videoDrawLeft = (areaRect.width - videoDrawWidth) / 2;
    const videoDrawTop = (areaRect.height - videoDrawHeight) / 2;

    const output = overlayCtx.createImageData(targetWidth, targetHeight);
    const total = leftData.data.length;
    let mismatchCount = 0;
    for (let i = 0; i < total; i += 4) {
      const rDiff = Math.abs(leftData.data[i] - rightData.data[i]);
      const gDiff = Math.abs(leftData.data[i + 1] - rightData.data[i + 1]);
      const bDiff = Math.abs(leftData.data[i + 2] - rightData.data[i + 2]);
      const delta = (rDiff + gDiff + bDiff) / (3 * 255);

      if (delta > threshold) {
        mismatchCount += 1;
        const intensity = clamp(Math.round(delta * 255), 80, 255);
        output.data[i] = 255;
        output.data[i + 1] = 0;
        output.data[i + 2] = 0;
        output.data[i + 3] = intensity;
      } else {
        output.data[i + 3] = 0;
      }
    }

    const totalPixels = targetWidth * targetHeight;
    const mismatchRatio = totalPixels > 0 ? mismatchCount / totalPixels : 0;
    const previousMismatchRatio = lastMismatchRatioRef.current;
    const isTransientSpike =
      mismatchRatio >= SPIKE_MISMATCH_RATIO &&
      previousMismatchRatio <= PRE_SPIKE_MISMATCH_RATIO;

    lastMismatchRatioRef.current = mismatchRatio;

    if (isTransientSpike) return;

    const mismatchCanvas = offscreenMismatchRef.current;
    if (!mismatchCanvas) return;
    mismatchCanvas.width = targetWidth;
    mismatchCanvas.height = targetHeight;
    const mismatchCtx = mismatchCanvas.getContext("2d");
    if (!mismatchCtx) return;
    mismatchCtx.putImageData(output, 0, 0);

    overlayCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    overlayCtx.clearRect(0, 0, areaRect.width, areaRect.height);
    overlayCtx.drawImage(
      mismatchCanvas,
      videoDrawLeft,
      videoDrawTop,
      videoDrawWidth,
      videoDrawHeight,
    );
  }, [threshold]);

  useEffect(() => {
    const handleKey = (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        if (bothLoaded) togglePlay();
      }
      if (event.code === "ArrowLeft") {
        event.preventDefault();
        if (bothLoaded) stepTime(-STEP_SECONDS);
      }
      if (event.code === "ArrowRight") {
        event.preventDefault();
        if (bothLoaded) stepTime(STEP_SECONDS);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [bothLoaded, stepTime, togglePlay]);

  useEffect(() => {
    if (!bothLoaded || !mismatchEnabled) return;

    const interval = 1000 / FPS_CAP;
    let rafId;
    let lastTick = performance.now();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastTick < interval) return;
      lastTick = now;
      drawMismatch();
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [bothLoaded, mismatchEnabled, drawMismatch]);

  const compareTransform = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
  };

  return (
    <div className="app">
      <TopBar
        sourceMode={sourceMode}
        onGoFiles={() => navigate("/")}
        onGoLive={() => navigate("/live")}
      />

      {durationMismatch && !dismissedWarning && (
        <WarningBanner
          message="Duration mismatch detected. Comparison is clamped to the shorter video."
          onDismiss={() => setDismissedWarning(true)}
        />
      )}

      {sameNameWarning && (
        <WarningBanner message="Warning: both sources share the same file name." />
      )}

      {sourceMode === "file" ? (
        <DropZoneRow
          leftName={leftName}
          rightName={rightName}
          onDropLeft={(event) => handleDrop(event, "left")}
          onDropRight={(event) => handleDrop(event, "right")}
          onSelectLeft={(event) => handleFileSelect(event, "left")}
          onSelectRight={(event) => handleFileSelect(event, "right")}
        />
      ) : (
        <LiveSourceForm
          onApplyUrls={applyUrlSources}
          leftInputError={leftInputError}
          rightInputError={rightInputError}
          leftName={leftName}
          rightName={rightName}
        />
      )}

      <CompareView
        compareWrapperRef={compareWrapperRef}
        compareAreaRef={compareAreaRef}
        rightVideoRef={rightVideoRef}
        leftVideoRef={leftVideoRef}
        overlayRef={overlayRef}
        rightSrc={rightSrc}
        leftSrc={leftSrc}
        mismatchEnabled={mismatchEnabled}
        sliderPos={sliderPos}
        bothLoaded={bothLoaded}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onContextMenu={(event) => event.preventDefault()}
        setVideoMeta={setVideoMeta}
        onVideoError={handleVideoError}
        handleTimeUpdate={handleTimeUpdate}
        isPlaying={isPlaying}
        togglePlay={togglePlay}
        onStepBack={() => stepTime(-STEP_SECONDS)}
        onStepForward={() => stepTime(STEP_SECONDS)}
        currentTime={currentTime}
        effectiveDuration={effectiveDuration}
        onSeekChange={handleSeekChange}
        onSeekEnd={handleSeekEnd}
        formatTime={formatTime}
        compareTransform={compareTransform}
        placeholderText={
          sourceMode === "file"
            ? "Drop two videos to start comparing."
            : "Load two URLs to start live comparison."
        }
      />

      <section className="panel">
        <ComparisonControls
          mismatchEnabled={mismatchEnabled}
          setMismatchEnabled={setMismatchEnabled}
          threshold={threshold}
          setThreshold={setThreshold}
          zoom={zoom}
          setZoom={setZoom}
          bothLoaded={bothLoaded}
        />
        <QualityChecks
          leftMeta={leftMeta}
          rightMeta={rightMeta}
          resolutionMismatch={resolutionMismatch}
          durationMismatch={durationMismatch}
          formatTime={formatTime}
        />
      </section>
    </div>
  );
}

export default ComparisonWorkspace;
