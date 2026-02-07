import '../styles/WarningBanner.css'

function WarningBanner({ message, dismissLabel, onDismiss }) {
  return (
    <div className="warning">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          {dismissLabel || 'Dismiss'}
        </button>
      )}
    </div>
  )
}

export default WarningBanner
