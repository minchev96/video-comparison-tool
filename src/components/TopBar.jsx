import '../styles/TopBar.css'

function TopBar({ bothLoaded, fps }) {
  return (
    <header className="top-bar">
      <div>
        <h1>Video Comparison Tool</h1>
      </div>
      <div className="status-badges">
        <span className={bothLoaded ? 'badge ready' : 'badge idle'}>
          {bothLoaded ? 'Ready' : 'Waiting'}
        </span>
        <span className="badge">FPS: {fps}</span>
      </div>
    </header>
  )
}

export default TopBar
