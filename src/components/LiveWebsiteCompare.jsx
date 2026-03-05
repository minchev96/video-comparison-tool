import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'
import LiveSourceForm from './LiveSourceForm.jsx'
import TopBar from './TopBar.jsx'
import WarningBanner from './WarningBanner.jsx'
import '../styles/LiveWebsiteCompare.css'

const POLL_INTERVAL_MS = 350
const REMOTE_VIEWPORT = { width: 1280, height: 720 }
const DIFF_FRAME_DIVISOR = 6

const normalizeKey = (event) => {
  if (event.code === 'Space') return 'Space'
  if (event.key === 'ArrowLeft') return 'ArrowLeft'
  if (event.key === 'ArrowRight') return 'ArrowRight'
  if (event.key === 'ArrowUp') return 'ArrowUp'
  if (event.key === 'ArrowDown') return 'ArrowDown'
  if (event.key === 'Enter') return 'Enter'
  if (event.key === 'Tab') return 'Tab'
  if (event.key === 'Escape') return 'Escape'
  if (event.key.length === 1) return event.key
  return null
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function LiveWebsiteCompare() {
  const navigate = useNavigate()
  const interactionAreaRef = useRef(null)
  const topFrameRef = useRef(null)
  const sessionRef = useRef(null)

  const [sessionId, setSessionId] = useState('')
  const [frameVersion, setFrameVersion] = useState(0)
  const [leftName, setLeftName] = useState('')
  const [rightName, setRightName] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState('Provide two website URLs and press Load URLs.')
  const [serverError, setServerError] = useState('')
  const [leftInputError, setLeftInputError] = useState('')
  const [rightInputError, setRightInputError] = useState('')
  const [mismatchEnabled, setMismatchEnabled] = useState(false)
  const [threshold, setThreshold] = useState(0.05)
  const [mismatchMode, setMismatchMode] = useState('binary')
  const [qualityMode, setQualityMode] = useState('fast')
  const [sliderPos, setSliderPos] = useState(0.5)
  const [isFormCollapsed, setIsFormCollapsed] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      if (!sessionRef.current) return
      setFrameVersion((prev) => prev + 1)
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    return () => {
      if (!sessionRef.current) return
      fetch(`/api/live/session/${sessionRef.current}`, { method: 'DELETE' }).catch(() => {})
      sessionRef.current = null
    }
  }, [])

  useEffect(() => {
    const element = interactionAreaRef.current
    if (!element) return undefined

    const getFrameCoordinates = (event) => {
      const rect = topFrameRef.current?.getBoundingClientRect()
      if (!rect?.width || !rect?.height) return null
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return null
      }

      const xRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
      const yRatio = clamp((event.clientY - rect.top) / rect.height, 0, 1)
      return {
        x: Math.round(xRatio * REMOTE_VIEWPORT.width),
        y: Math.round(yRatio * REMOTE_VIEWPORT.height),
      }
    }

    const postNativeInteraction = (payload) => {
      if (!sessionRef.current) return
      fetch(`/api/live/session/${sessionRef.current}/interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(() => setFrameVersion((prev) => prev + 1))
        .catch(() => {
          setServerError('Failed to mirror interaction. Check if live backend is still running.')
        })
    }

    const handlePointerDown = (event) => {
      if (event.button !== 0 && event.button !== 2) return
      const coords = getFrameCoordinates(event)
      if (!coords) return
      element.focus()
      postNativeInteraction({
        type: 'pointer',
        action: 'click',
        x: coords.x,
        y: coords.y,
        button: event.button === 2 ? 'right' : 'left',
      })
    }

    const handlePointerMove = (event) => {
      const rect = topFrameRef.current?.getBoundingClientRect()
      if (!rect?.width || !rect?.height) return
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
      setSliderPos(ratio)
    }

    const handleWheel = (event) => {
      event.preventDefault()
      postNativeInteraction({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY })
    }

    const handleKeyDown = (event) => {
      const key = normalizeKey(event)
      if (!key) return
      event.preventDefault()
      postNativeInteraction({ type: 'key', key })
    }

    element.addEventListener('pointerdown', handlePointerDown)
    element.addEventListener('pointermove', handlePointerMove)
    element.addEventListener('wheel', handleWheel, { passive: false })
    element.addEventListener('keydown', handleKeyDown)
    return () => {
      element.removeEventListener('pointerdown', handlePointerDown)
      element.removeEventListener('pointermove', handlePointerMove)
      element.removeEventListener('wheel', handleWheel)
      element.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const frameLeftSrc = useMemo(() => {
    if (!sessionId) return ''
    return `/api/live/session/${sessionId}/frame/left?t=${frameVersion}`
  }, [sessionId, frameVersion])

  const frameRightSrc = useMemo(() => {
    if (!sessionId) return ''
    return `/api/live/session/${sessionId}/frame/right?t=${frameVersion}`
  }, [sessionId, frameVersion])

  const diffFrameSrc = useMemo(() => {
    if (!sessionId || !mismatchEnabled) return ''
    const divisor = qualityMode === 'precise' ? 1 : DIFF_FRAME_DIVISOR
    const diffVersion = Math.floor(frameVersion / divisor)
    return `/api/live/session/${sessionId}/frame/diff?t=${diffVersion}&threshold=${threshold}&mode=${mismatchMode}&quality=${qualityMode}`
  }, [sessionId, frameVersion, mismatchEnabled, mismatchMode, threshold, qualityMode])

  const parseName = (value, fallback) => {
    try {
      const parsed = new URL(value)
      return parsed.host || fallback
    } catch {
      return fallback
    }
  }

  const applyUrls = async (leftUrl, rightUrl) => {
    setFormBusy(true)
    setServerError('')
    setLeftInputError('')
    setRightInputError('')
    setStatusMessage('Starting mirrored browser session...')

    try {
      if (sessionRef.current) {
        await fetch(`/api/live/session/${sessionRef.current}`, { method: 'DELETE' })
          .catch(() => {})
      }

      const response = await fetch('/api/live/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leftUrl, rightUrl }),
      })

      const payload = await response.json()
      if (!response.ok) {
        const message = payload?.error || 'Could not create live website session.'
        const leftDetail =
          typeof payload?.details?.left === 'string' ? payload.details.left : ''
        const rightDetail =
          typeof payload?.details?.right === 'string' ? payload.details.right : ''

        setServerError(
          leftDetail || rightDetail
            ? `${message} Left: ${leftDetail || 'ok'} | Right: ${rightDetail || 'ok'}`
            : message,
        )
        setLeftInputError(leftDetail || message)
        setRightInputError(rightDetail || message)
        setSessionId('')
        sessionRef.current = null
        setStatusMessage('Session failed to start.')
        return
      }

      const nextSession = payload.sessionId
      sessionRef.current = nextSession
      setSessionId(nextSession)
      setFrameVersion((prev) => prev + 1)
      setLeftName(parseName(leftUrl, 'Website A'))
      setRightName(parseName(rightUrl, 'Website B'))
      setStatusMessage('Live mirror active: interactions on top frame are broadcast to both websites.')
      setIsFormCollapsed(true)
    } catch {
      const message = 'Live backend is unavailable. Start it with: npm run dev:live'
      setServerError(message)
      setLeftInputError(message)
      setRightInputError(message)
      setSessionId('')
      sessionRef.current = null
      setStatusMessage('Session failed to start.')
    } finally {
      setFormBusy(false)
    }
  }

  return (
    <div className="app">
      <TopBar
        sourceMode="url"
        onGoFiles={() => navigate('/')}
        onGoLive={() => navigate('/live')}
      />

      <LiveSourceForm
        onApplyUrls={applyUrls}
        leftInputError={leftInputError}
        rightInputError={rightInputError}
        leftName={leftName}
        rightName={rightName}
        collapsed={isFormCollapsed}
        onToggleCollapse={() => setIsFormCollapsed((prev) => !prev)}
        disabled={formBusy}
        title="Live Website Comparison"
        placeholders={[
          'https://example.com/site-a',
          'https://example.com/site-b',
        ]}
      />

      {serverError && <WarningBanner message={serverError} />}

      <section className="website-stack panel-block">
        <div className="website-stack-header">
          <h2>Mirrored Websites</h2>
          <span>{statusMessage}</span>
        </div>

        <div className="website-mismatch-controls" aria-label="Live mismatch controls">
          <label className="website-toggle">
            <input
              type="checkbox"
              checked={mismatchEnabled}
              onChange={(event) => setMismatchEnabled(event.target.checked)}
              disabled={!sessionId}
            />
            Pixel mismatch overlay
          </label>

          <label className="website-threshold">
            Threshold: {threshold.toFixed(2)}
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              disabled={!sessionId || !mismatchEnabled}
            />
          </label>

          <div className="website-mode-group">
            <label>
              <input
                type="radio"
                name="live-mismatch-mode"
                value="binary"
                checked={mismatchMode === 'binary'}
                onChange={() => setMismatchMode('binary')}
                disabled={!sessionId || !mismatchEnabled}
              />
              Binary
            </label>
            <label>
              <input
                type="radio"
                name="live-mismatch-mode"
                value="heatmap"
                checked={mismatchMode === 'heatmap'}
                onChange={() => setMismatchMode('heatmap')}
                disabled={!sessionId || !mismatchEnabled}
              />
              Heatmap
            </label>
          </div>

          <div className="website-quality-group">
            <label>
              <input
                type="radio"
                name="live-quality-mode"
                value="fast"
                checked={qualityMode === 'fast'}
                onChange={() => setQualityMode('fast')}
                disabled={!sessionId || !mismatchEnabled}
              />
              Fast (low CPU)
            </label>
            <label>
              <input
                type="radio"
                name="live-quality-mode"
                value="precise"
                checked={qualityMode === 'precise'}
                onChange={() => setQualityMode('precise')}
                disabled={!sessionId || !mismatchEnabled}
              />
              Precise
            </label>
          </div>
        </div>

        <div
          className={`website-stage ${sessionId ? 'active' : ''}`}
          ref={interactionAreaRef}
          role="button"
          tabIndex={0}
          onContextMenu={(event) => event.preventDefault()}
          aria-label="Top website interactive surface"
        >
          {sessionId ? (
            <>
              <img
                ref={topFrameRef}
                src={frameRightSrc}
                alt="Top compare base stream"
                className="website-frame"
                draggable={false}
              />
              <div
                className="website-compare-overlay"
                style={{ clipPath: `inset(0 ${100 - sliderPos * 100}% 0 0)` }}
              >
                <img
                  src={frameLeftSrc}
                  alt="Top compare overlay stream"
                  className="website-frame"
                  draggable={false}
                />
              </div>
              {mismatchEnabled && (
                <img
                  src={diffFrameSrc}
                  alt="Mismatch overlay"
                  className="website-frame mismatch-layer"
                />
              )}
              <div className="website-slider-line" style={{ left: `${sliderPos * 100}%` }} />
            </>
          ) : (
            <div className="website-placeholder">Load URLs to start website rendering.</div>
          )}
        </div>

        <div className="website-stage">
          {sessionId ? (
            <img src={frameRightSrc} alt="Bottom website stream" className="website-frame" />
          ) : (
            <div className="website-placeholder">Bottom mirrored website will appear here.</div>
          )}
        </div>
      </section>
    </div>
  )
}

export default LiveWebsiteCompare
