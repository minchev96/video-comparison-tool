import { useState } from "react";
import "../styles/LiveSourceForm.css";

function LiveSourceForm({
  onApplyUrls,
  leftInputError,
  rightInputError,
  leftName,
  rightName,
  collapsed = false,
  onToggleCollapse,
  disabled = false,
  title = "Live Comparison",
  placeholders = [
    "https://example.com/left-source.mp4",
    "https://example.com/right-source.mp4",
  ],
}) {
  const [leftUrl, setLeftUrl] = useState("");
  const [rightUrl, setRightUrl] = useState("");
  const [formError, setFormError] = useState("");

  const handleApply = () => {
    const leftTrimmed = leftUrl.trim();
    const rightTrimmed = rightUrl.trim();

    if (!leftTrimmed || !rightTrimmed) {
      setFormError("Please provide both URLs before loading.");
      return;
    }

    setFormError("");
    if (!disabled) {
      onApplyUrls(leftTrimmed, rightTrimmed);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleApply();
    }
  };

  return (
    <section className="live-form panel-block" aria-label="Live URL Inputs">
      <div className="live-form-header">
        <h2>{title}</h2>
        {onToggleCollapse && (
          <button
            type="button"
            className={`live-collapse-button${collapsed ? " is-collapsed" : ""}`}
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expand URL form" : "Collapse URL form"}
          >
            <span className="live-collapse-icon" aria-hidden="true" />
          </button>
        )}
      </div>

      {collapsed ? (
        <div className="live-collapsed-summary" role="note">
          <span>Left: {leftName || leftUrl || "--"}</span>
          <span>Right: {rightName || rightUrl || "--"}</span>
        </div>
      ) : (
        <>
          <div className="live-form-grid">
            <label className="live-field" htmlFor="left-url-input">
              <span>URL 1</span>
              <input
                id="left-url-input"
                type="text"
                value={leftUrl}
                onChange={(event) => setLeftUrl(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholders[0]}
                disabled={disabled}
              />
            </label>

            <label className="live-field" htmlFor="right-url-input">
              <span>URL 2</span>
              <input
                id="right-url-input"
                type="text"
                value={rightUrl}
                onChange={(event) => setRightUrl(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholders[1]}
                disabled={disabled}
              />
            </label>

            <button
              type="button"
              className="live-load-button"
              onClick={handleApply}
              disabled={disabled}
            >
              {disabled ? "Loading..." : "Load URLs"}
            </button>
          </div>

          {(formError || leftInputError || rightInputError) && (
            <div className="live-errors" role="status">
              {formError && <p>{formError}</p>}
              {leftInputError && <p>{leftInputError}</p>}
              {rightInputError && <p>{rightInputError}</p>}
            </div>
          )}
        </>
      )}

      {!collapsed && (leftName || rightName) && (
        <div className="live-loaded-names" role="note">
          <span>Left: {leftName || "--"}</span>
          <span>Right: {rightName || "--"}</span>
        </div>
      )}
    </section>
  );
}

export default LiveSourceForm;
