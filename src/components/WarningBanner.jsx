import '../styles/WarningBanner.css'

function WarningBanner({ message, onDismiss }) {
  return (
    <div className="warning">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  )
}

export default WarningBanner
