import '../styles/PlaybackControls.css'

function PlaybackControls({
  isPlaying,
  onTogglePlay,
  onStepBack,
  onStepForward,
  currentTime,
  effectiveDuration,
  onSeekChange,
  onSeekEnd,
  formatTime,
  disabled,
}) {
  return (
    <div className="controls">
      <div className="controls-row">
        <button type="button" onClick={onTogglePlay} disabled={disabled}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={onStepBack} disabled={disabled}>
          -1s
        </button>
        <button type="button" onClick={onStepForward} disabled={disabled}>
          +1s
        </button>
        <span className="time">
          {formatTime(currentTime)} / {formatTime(effectiveDuration)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={effectiveDuration || 0}
        step="0.01"
        value={currentTime}
        onChange={onSeekChange}
        onMouseUp={onSeekEnd}
        onTouchEnd={onSeekEnd}
        disabled={disabled}
      />
    </div>
  )
}

export default PlaybackControls
