import "../styles/ComparisonControls.css";

function ComparisonControls({
  mismatchEnabled,
  setMismatchEnabled,
  threshold,
  setThreshold,
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
  );
}

export default ComparisonControls;
