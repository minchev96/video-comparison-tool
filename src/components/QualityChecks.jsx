import '../styles/QualityChecks.css'

function QualityChecks({
  leftMeta,
  rightMeta,
  resolutionMismatch,
  durationMismatch,
  formatTime,
}) {
  return (
    <div className="panel-block">
      <h2>Quality Checks</h2>
      <ul className="quality-list">
        <li>
          Resolution: {leftMeta.width || '--'}x{leftMeta.height || '--'} vs{' '}
          {rightMeta.width || '--'}x{rightMeta.height || '--'}{' '}
          {resolutionMismatch && <span className="flag">Mismatch</span>}
        </li>
        <li>
          Duration: {formatTime(leftMeta.duration)} vs{' '}
          {formatTime(rightMeta.duration)}{' '}
          {durationMismatch && <span className="flag">Mismatch</span>}
        </li>
      </ul>
    </div>
  )
}

export default QualityChecks
