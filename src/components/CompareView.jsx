import PlaybackControls from './PlaybackControls.jsx'
import '../styles/CompareView.css'

function CompareView({
  compareWrapperRef,
  compareAreaRef,
  rightVideoRef,
  leftVideoRef,
  overlayRef,
  rightSrc,
  leftSrc,
  leftGhost,
  mismatchEnabled,
  sliderPos,
  bothLoaded,
  onMouseMove,
  onMouseDown,
  onMouseUp,
  onClick,
  onContextMenu,
  setVideoMeta,
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
}) {
  return (
    <section
      className="compare-wrapper"
      ref={compareWrapperRef}
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="compare-area" ref={compareAreaRef}>
        <div className="compare-layer">
          <div className="compare-transform" style={compareTransform}>
            <video
              ref={rightVideoRef}
              src={rightSrc || undefined}
              className="video-base"
              onLoadedMetadata={(event) =>
                setVideoMeta('right', event.currentTarget)
              }
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
                className={`video-top ${leftGhost ? 'ghost' : ''}`}
                onLoadedMetadata={(event) =>
                  setVideoMeta('left', event.currentTarget)
                }
                onTimeUpdate={handleTimeUpdate}
                playsInline
                muted
              />
            </div>
            <canvas
              ref={overlayRef}
              className={`mismatch-overlay ${mismatchEnabled ? 'visible' : ''}`}
            />
            <div className="slider-line" style={{ left: `${sliderPos * 100}%` }} />
          </div>
        </div>

        {!bothLoaded && (
          <div className="compare-placeholder">
            Drop two videos to start comparing.
          </div>
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
    </section>
  )
}

export default CompareView
