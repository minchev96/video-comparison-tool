import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import CompareView from './components/CompareView.jsx'
import ComparisonControls from './components/ComparisonControls.jsx'
import DropZoneRow from './components/DropZoneRow.jsx'
import QualityChecks from './components/QualityChecks.jsx'
import TopBar from './components/TopBar.jsx'
import WarningBanner from './components/WarningBanner.jsx'

const FPS_CAP = 40
const STEP_SECONDS = 1

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function App() {
  const [leftSrc, setLeftSrc] = useState(null)
  const [rightSrc, setRightSrc] = useState(null)
  const [leftName, setLeftName] = useState('')
  const [rightName, setRightName] = useState('')
  const [leftLoaded, setLeftLoaded] = useState(false)
  const [rightLoaded, setRightLoaded] = useState(false)
  const [sliderPos, setSliderPos] = useState(0.5)
  const [leftGhost, setLeftGhost] = useState(false)
  const [mismatchEnabled, setMismatchEnabled] = useState(false)
  const [threshold, setThreshold] = useState(0.18)
  const [mismatchMode, setMismatchMode] = useState('binary')
  const [fps, setFps] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [leftMeta, setLeftMeta] = useState({ width: 0, height: 0, duration: 0 })
  const [rightMeta, setRightMeta] = useState({ width: 0, height: 0, duration: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [dismissedWarning, setDismissedWarning] = useState(false)

  const leftVideoRef = useRef(null)
  const rightVideoRef = useRef(null)
  const overlayRef = useRef(null)
  const compareAreaRef = useRef(null)
  const compareWrapperRef = useRef(null)
  const offscreenLeftRef = useRef(null)
  const offscreenRightRef = useRef(null)
  const isSyncingRef = useRef(false)
  const isSeekingRef = useRef(false)
  const lastFpsSampleRef = useRef({ time: performance.now(), frames: 0 })
  const lastMouseRef = useRef({ x: 0, y: 0 })
  const leftUrlRef = useRef(null)
  const rightUrlRef = useRef(null)

  const bothLoaded = leftLoaded && rightLoaded
  const sameNameWarning =
    leftName && rightName && leftName.toLowerCase() === rightName.toLowerCase()
  const durationMismatch =
    bothLoaded && Math.abs(leftMeta.duration - rightMeta.duration) > 0.1
  const resolutionMismatch =
    bothLoaded &&
    (leftMeta.width !== rightMeta.width || leftMeta.height !== rightMeta.height)
  const effectiveDuration = useMemo(() => {
    if (!bothLoaded) return 0
    return Math.min(leftMeta.duration || 0, rightMeta.duration || 0)
  }, [bothLoaded, leftMeta.duration, rightMeta.duration])

  useEffect(() => {
    offscreenLeftRef.current = document.createElement('canvas')
    offscreenRightRef.current = document.createElement('canvas')
  }, [])

  useEffect(() => {
    if (leftSrc && leftUrlRef.current && leftUrlRef.current !== leftSrc) {
      URL.revokeObjectURL(leftUrlRef.current)
    }
    if (rightSrc && rightUrlRef.current && rightUrlRef.current !== rightSrc) {
      URL.revokeObjectURL(rightUrlRef.current)
    }
    leftUrlRef.current = leftSrc
    rightUrlRef.current = rightSrc
  }, [leftSrc, rightSrc])

  useEffect(() => {
    const handleKey = (event) => {
      if (event.code === 'Space') {
        event.preventDefault()
        if (bothLoaded) togglePlay()
      }
      if (event.code === 'ArrowLeft') {
        event.preventDefault()
        if (bothLoaded) stepTime(-STEP_SECONDS)
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault()
        if (bothLoaded) stepTime(STEP_SECONDS)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [bothLoaded])

  useEffect(() => {
    const wrapper = compareWrapperRef.current
    if (!wrapper) return undefined

    const handleWheelEvent = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.deltaY > 0 ? -0.08 : 0.08
      setZoom((prev) => clamp(prev + delta, 0.4, 3))
    }

    wrapper.addEventListener('wheel', handleWheelEvent, { passive: false })
    return () => wrapper.removeEventListener('wheel', handleWheelEvent)
  }, [])

  useEffect(() => {
    if (!bothLoaded) return
    if (isPlaying) {
      Promise.all([
        leftVideoRef.current?.play(),
        rightVideoRef.current?.play(),
      ]).catch(() => {
        setIsPlaying(false)
      })
    } else {
      leftVideoRef.current?.pause()
      rightVideoRef.current?.pause()
    }
  }, [isPlaying, bothLoaded])

  useEffect(() => {
    if (!bothLoaded || !mismatchEnabled) return

    const interval = 1000 / FPS_CAP
    let rafId
    let lastTick = performance.now()

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const now = performance.now()
      if (now - lastTick < interval) return
      lastTick = now
      drawMismatch()
      const fpsSample = lastFpsSampleRef.current
      fpsSample.frames += 1
      const elapsed = now - fpsSample.time
      if (elapsed >= 1000) {
        setFps(Math.round((fpsSample.frames / elapsed) * 1000))
        fpsSample.time = now
        fpsSample.frames = 0
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [bothLoaded, mismatchEnabled, mismatchMode, threshold, leftSrc, rightSrc])

  useEffect(() => {
    if (!mismatchEnabled) {
      const overlay = overlayRef.current
      if (overlay) {
        const ctx = overlay.getContext('2d')
        ctx?.clearRect(0, 0, overlay.width, overlay.height)
      }
    }
  }, [mismatchEnabled])

  const setVideoMeta = (side, video) => {
    if (!video) return
    const data = {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration || 0,
    }
    if (side === 'left') {
      setLeftMeta(data)
      setLeftLoaded(true)
    } else {
      setRightMeta(data)
      setRightLoaded(true)
    }
  }

  const handleTimeUpdate = () => {
    if (!bothLoaded) return
    if (isSyncingRef.current || isSeekingRef.current) return
    const leftVideo = leftVideoRef.current
    const rightVideo = rightVideoRef.current
    if (!leftVideo || !rightVideo) return
    const diff = Math.abs(leftVideo.currentTime - rightVideo.currentTime)
    if (diff > 0.05) {
      isSyncingRef.current = true
      rightVideo.currentTime = leftVideo.currentTime
      isSyncingRef.current = false
    }
    setCurrentTime(leftVideo.currentTime)
  }

  const togglePlay = () => {
    if (!bothLoaded) return
    setIsPlaying((prev) => !prev)
  }

  const stepTime = (delta) => {
    if (!bothLoaded) return
    const leftVideo = leftVideoRef.current
    const baseTime = leftVideo?.currentTime ?? currentTime
    const next = clamp(baseTime + delta, 0, effectiveDuration)
    setIsPlaying(false)
    seekTo(next)
  }

  const seekTo = (time) => {
    if (!bothLoaded) return
    const leftVideo = leftVideoRef.current
    const rightVideo = rightVideoRef.current
    if (!leftVideo || !rightVideo) return
    isSyncingRef.current = true
    leftVideo.currentTime = time
    rightVideo.currentTime = time
    setCurrentTime(time)
    isSyncingRef.current = false
  }

  const handleSeekChange = (event) => {
    const value = Number(event.target.value)
    isSeekingRef.current = true
    seekTo(value)
  }

  const handleSeekEnd = () => {
    isSeekingRef.current = false
  }

  const handleMouseMove = (event) => {
    const rect = compareAreaRef.current?.getBoundingClientRect()
    if (rect) {
      const screenX = clamp(event.clientX - rect.left, 0, rect.width)
      const centerX = rect.width / 2
      const layerX = (screenX - pan.x - centerX) / zoom + centerX
      const videoWidth = leftMeta.width || rightMeta.width
      const videoHeight = leftMeta.height || rightMeta.height
      let imgLeft = 0
      let imgWidth = rect.width

      if (videoWidth && videoHeight) {
        const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
        imgWidth = videoWidth * scale
        const imgHeight = videoHeight * scale
        imgLeft = (rect.width - imgWidth) / 2
        const imgTop = (rect.height - imgHeight) / 2
        if (layerX < imgLeft) {
          // outside left edge of image
        }
      }

      const ratioInImage = clamp((layerX - imgLeft) / imgWidth, 0, 1)
      const sliderLayerRatio = clamp(
        (imgLeft + ratioInImage * imgWidth) / rect.width,
        0,
        1,
      )
      setSliderPos(sliderLayerRatio)
    }
    if (isPanning) {
      const dx = event.clientX - lastMouseRef.current.x
      const dy = event.clientY - lastMouseRef.current.y
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
      lastMouseRef.current = { x: event.clientX, y: event.clientY }
    }
  }

  const handleMouseDown = (event) => {
    if (event.button === 2) {
      event.preventDefault()
      setIsPanning(true)
      lastMouseRef.current = { x: event.clientX, y: event.clientY }
    }
  }

  const handleMouseUp = () => {
    setIsPanning(false)
  }

  const handleClick = (event) => {
    if (event.button !== 0) return
    if (bothLoaded) togglePlay()
  }

  const handleDrop = (event, side) => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (!file || !file.type.startsWith('video/')) return
    const url = URL.createObjectURL(file)
    if (side === 'left') {
      setLeftSrc(url)
      setLeftName(file.name)
      setLeftLoaded(false)
    } else {
      setRightSrc(url)
      setRightName(file.name)
      setRightLoaded(false)
    }
    setIsPlaying(false)
    setCurrentTime(0)
  }

  const handleFileSelect = (event, side) => {
    const file = event.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    if (side === 'left') {
      setLeftSrc(url)
      setLeftName(file.name)
      setLeftLoaded(false)
    } else {
      setRightSrc(url)
      setRightName(file.name)
      setRightLoaded(false)
    }
    setIsPlaying(false)
    setCurrentTime(0)
  }

  const drawMismatch = () => {
    const leftVideo = leftVideoRef.current
    const rightVideo = rightVideoRef.current
    const overlay = overlayRef.current
    if (!leftVideo || !rightVideo || !overlay) return
    if (!leftVideo.videoWidth || !rightVideo.videoWidth) return

    const targetWidth = Math.min(leftVideo.videoWidth, rightVideo.videoWidth)
    const targetHeight = Math.min(leftVideo.videoHeight, rightVideo.videoHeight)

    const leftCanvas = offscreenLeftRef.current
    const rightCanvas = offscreenRightRef.current
    leftCanvas.width = targetWidth
    leftCanvas.height = targetHeight
    rightCanvas.width = targetWidth
    rightCanvas.height = targetHeight

    const leftCtx = leftCanvas.getContext('2d', { willReadFrequently: true })
    const rightCtx = rightCanvas.getContext('2d', { willReadFrequently: true })
    if (!leftCtx || !rightCtx) return

    leftCtx.drawImage(leftVideo, 0, 0, targetWidth, targetHeight)
    rightCtx.drawImage(rightVideo, 0, 0, targetWidth, targetHeight)

    const leftData = leftCtx.getImageData(0, 0, targetWidth, targetHeight)
    const rightData = rightCtx.getImageData(0, 0, targetWidth, targetHeight)
    const overlayCtx = overlay.getContext('2d')
    if (!overlayCtx) return

    overlay.width = targetWidth
    overlay.height = targetHeight

    const output = overlayCtx.createImageData(targetWidth, targetHeight)
    const total = leftData.data.length
    for (let i = 0; i < total; i += 4) {
      const rDiff = Math.abs(leftData.data[i] - rightData.data[i])
      const gDiff = Math.abs(leftData.data[i + 1] - rightData.data[i + 1])
      const bDiff = Math.abs(leftData.data[i + 2] - rightData.data[i + 2])
      const delta = (rDiff + gDiff + bDiff) / (3 * 255)

      if (delta > threshold) {
        if (mismatchMode === 'binary') {
          output.data[i] = 255
          output.data[i + 1] = 0
          output.data[i + 2] = 0
          output.data[i + 3] = 220
        } else {
          const intensity = clamp(Math.round(delta * 255), 80, 255)
          output.data[i] = 255
          output.data[i + 1] = 0
          output.data[i + 2] = 0
          output.data[i + 3] = intensity
        }
      } else {
        output.data[i + 3] = 0
      }
    }

    overlayCtx.putImageData(output, 0, 0)
  }

  const compareTransform = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
  }

  return (
    <div className="app">
      <TopBar bothLoaded={bothLoaded} fps={fps} />

      {durationMismatch && !dismissedWarning && (
        <WarningBanner
          message="Duration mismatch detected. Comparison is clamped to the shorter video."
          onDismiss={() => setDismissedWarning(true)}
        />
      )}

      {sameNameWarning && (
        <WarningBanner message="Warning: both sources share the same file name." />
      )}

      <DropZoneRow
        leftName={leftName}
        rightName={rightName}
        onDropLeft={(event) => handleDrop(event, 'left')}
        onDropRight={(event) => handleDrop(event, 'right')}
        onSelectLeft={(event) => handleFileSelect(event, 'left')}
        onSelectRight={(event) => handleFileSelect(event, 'right')}
      />

      <CompareView
        compareWrapperRef={compareWrapperRef}
        compareAreaRef={compareAreaRef}
        rightVideoRef={rightVideoRef}
        leftVideoRef={leftVideoRef}
        overlayRef={overlayRef}
        rightSrc={rightSrc}
        leftSrc={leftSrc}
        leftGhost={leftGhost}
        mismatchEnabled={mismatchEnabled}
        sliderPos={sliderPos}
        bothLoaded={bothLoaded}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onContextMenu={(event) => event.preventDefault()}
        setVideoMeta={setVideoMeta}
        handleTimeUpdate={handleTimeUpdate}
        isPlaying={isPlaying}
        togglePlay={togglePlay}
        onStepBack={() => stepTime(-STEP_SECONDS)}
        onStepForward={() => stepTime(STEP_SECONDS)}
        currentTime={currentTime}
        effectiveDuration={effectiveDuration}
        onSeekChange={handleSeekChange}
        onSeekEnd={handleSeekEnd}
        formatTime={formatTime}
        compareTransform={compareTransform}
      />

      <section className="panel">
        <ComparisonControls
          leftGhost={leftGhost}
          setLeftGhost={setLeftGhost}
          mismatchEnabled={mismatchEnabled}
          setMismatchEnabled={setMismatchEnabled}
          threshold={threshold}
          setThreshold={setThreshold}
          mismatchMode={mismatchMode}
          setMismatchMode={setMismatchMode}
          zoom={zoom}
          setZoom={setZoom}
          bothLoaded={bothLoaded}
        />
        <QualityChecks
          leftMeta={leftMeta}
          rightMeta={rightMeta}
          resolutionMismatch={resolutionMismatch}
          durationMismatch={durationMismatch}
          formatTime={formatTime}
        />
      </section>
    </div>
  )
}

export default App
