import '../styles/ComparisonControls.css'

function ComparisonControls({
  leftGhost,
  setLeftGhost,
  mismatchEnabled,
  setMismatchEnabled,
  threshold,
  setThreshold,
  mismatchMode,
  setMismatchMode,
  zoom,
  setZoom,
  bothLoaded,
}) {
  return (
    <div className="panel-block">
      <h2>Comparison Controls</h2>
      <div className="control-grid">
        <label className="toggle">
          <input
            type="checkbox"
            checked={leftGhost}
            onChange={(event) => setLeftGhost(event.target.checked)}
          />
          Left source ghost (50% opacity)
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={mismatchEnabled}
            onChange={(event) => setMismatchEnabled(event.target.checked)}
            disabled={!bothLoaded}
          />
          Pixel mismatch overlay
        </label>

        <div className="control-group">
          <span>Mismatch threshold: {threshold.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
            disabled={!mismatchEnabled}
          />
        </div>

        <div className="control-group">
          <span>Mismatch mode</span>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="mismatch-mode"
                value="binary"
                checked={mismatchMode === 'binary'}
                onChange={() => setMismatchMode('binary')}
                disabled={!mismatchEnabled}
              />
              Binary
            </label>
            <label>
              <input
                type="radio"
                name="mismatch-mode"
                value="heatmap"
                checked={mismatchMode === 'heatmap'}
                onChange={() => setMismatchMode('heatmap')}
                disabled={!mismatchEnabled}
              />
              Heatmap
            </label>
          </div>
        </div>

        <div className="control-group">
          <span>Zoom</span>
          <input
            type="range"
            min="0.4"
            max="3"
            step="0.05"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </div>
      </div>
    </div>
  )
}

export default ComparisonControls
