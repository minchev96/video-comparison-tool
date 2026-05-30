import "../styles/TopBar.css";

function TopBar({ sourceMode, onGoFiles, onGoLive }) {
  return (
    <header className="top-bar">
      <div className="top-bar-main">
        <h1>Video Comparison Tool</h1>
        <nav
          className="top-bar-nav"
          aria-label="Comparison Views"
        >
          <button
            type="button"
            className={`top-nav-button ${sourceMode === "file" ? "active" : ""}`}
            onClick={onGoFiles}
          >
            Video Compare
          </button>
          <button
            type="button"
            className={`top-nav-button ${sourceMode === "url" ? "active" : ""}`}
            onClick={onGoLive}
          >
            Live Compare
          </button>
        </nav>
      </div>
    </header>
  );
}

export default TopBar;
