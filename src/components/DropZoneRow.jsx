import '../styles/DropZoneRow.css'

function DropZoneRow({ leftName, rightName, onDropLeft, onDropRight, onSelectLeft, onSelectRight }) {
  return (
    <section className="drop-zone-row">
      <label
        className="drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDropLeft}
      >
        <input type="file" accept="video/*" onChange={onSelectLeft} />
        <span className="drop-title">Left Source</span>
        <span className="drop-sub">
          {leftName || 'Drag and drop or click to select'}
        </span>
      </label>
      <label
        className="drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDropRight}
      >
        <input type="file" accept="video/*" onChange={onSelectRight} />
        <span className="drop-title">Right Source</span>
        <span className="drop-sub">
          {rightName || 'Drag and drop or click to select'}
        </span>
      </label>
    </section>
  )
}

export default DropZoneRow
