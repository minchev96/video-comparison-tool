import PlaybackControls from "./PlaybackControls.jsx";
import "../styles/CompareView.css";

function CompareView({
  compareWrapperRef,
  compareAreaRef,
  rightVideoRef,
  leftVideoRef,
  overlayRef,
  rightSrc,
  leftSrc,
  mismatchEnabled,
  sliderPos,
  bothLoaded,
  onMouseMove,
  onMouseDown,
  onMouseUp,
  onClick,
  onContextMenu,
  setVideoMeta,
  onVideoError = () => {},
  handleTimeUpdate,
  isPlaying,
  togglePlay,
  onStepBack,
  onStepForward,
  currentTime,
  effectiveDuration,
  onSeekChange,
  onSeekEnd,
  formatTime,
  compareTransform,
  placeholderText = "Drop two videos to start comparing.",
}) {
  return (
    <div className="compare-wrapper" ref={compareWrapperRef}>
      <div className="compare-area" ref={compareAreaRef}>
        <button
          type="button"
          className="compare-hitbox"
          onMouseMove={onMouseMove}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onClick={onClick}
          onContextMenu={onContextMenu}
          aria-label="Comparison interaction surface"
        />
        <div className="compare-layer">
          <div className="compare-transform" style={compareTransform}>
            <video
              ref={rightVideoRef}
              src={rightSrc || undefined}
              className="video-base"
              onLoadedMetadata={(event) =>
                setVideoMeta("right", event.currentTarget)
              }
              onError={() => onVideoError("right")}
              onTimeUpdate={handleTimeUpdate}
              playsInline
              muted
            />
            <div
              className="video-overlay"
              style={{ clipPath: `inset(0 ${100 - sliderPos * 100}% 0 0)` }}
            >
              <video
                ref={leftVideoRef}
                src={leftSrc || undefined}
                className="video-top"
                onLoadedMetadata={(event) =>
                  setVideoMeta("left", event.currentTarget)
                }
                onError={() => onVideoError("left")}
                onTimeUpdate={handleTimeUpdate}
                playsInline
                muted
              />
            </div>
            <canvas
              ref={overlayRef}
              className={`mismatch-overlay ${mismatchEnabled ? "visible" : ""}`}
            />
            {!mismatchEnabled && (
              <div
                className="slider-line"
                style={{ left: `${sliderPos * 100}%` }}
              />
            )}
          </div>
        </div>

        {!bothLoaded && (
          <div className="compare-placeholder">{placeholderText}</div>
        )}
      </div>

      <PlaybackControls
        isPlaying={isPlaying}
        onTogglePlay={togglePlay}
        onStepBack={onStepBack}
        onStepForward={onStepForward}
        currentTime={currentTime}
        effectiveDuration={effectiveDuration}
        onSeekChange={onSeekChange}
        onSeekEnd={onSeekEnd}
        formatTime={formatTime}
        disabled={!bothLoaded}
      />
    </div>
  );
}

export default CompareView;
