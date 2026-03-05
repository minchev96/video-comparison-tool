import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const PORT = 8787
const VIEWPORT = { width: 1280, height: 720 }
const FRAME_CACHE_MS = 120
const DIFF_SAMPLE_STEP = 2
const MAX_DIFF_SAMPLES = 120000

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

let browserPromise = null
const sessions = new Map()

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true })
  }
  return browserPromise
}

const normalizeUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `https://${raw}`
}

const validateUrl = (value) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const parseThreshold = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0.05
  return Math.max(0, Math.min(1, parsed))
}

const parseMode = (value) => (value === 'heatmap' ? 'heatmap' : 'binary')
const parseQuality = (value) => (value === 'precise' ? 'precise' : 'fast')

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const openWebsite = async (page, targetUrl) => {
  const attempts = [
    { waitUntil: 'domcontentloaded', timeout: 45000 },
    { waitUntil: 'load', timeout: 60000 },
    { waitUntil: 'commit', timeout: 60000 },
  ]

  let lastError = null
  for (const attempt of attempts) {
    try {
      await page.goto(targetUrl, attempt)
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('Navigation failed.')
}

const captureFrame = async (session, side, type = 'jpeg') => {
  const entry = side === 'left' ? session.left : session.right
  const now = Date.now()
  const isJpeg = type === 'jpeg'
  const cachedBuffer = isJpeg ? entry.cachedJpeg : entry.cachedPng

  if (entry.cachedAt && now - entry.cachedAt < FRAME_CACHE_MS && cachedBuffer) {
    return cachedBuffer
  }

  const image = await entry.page.screenshot(
    isJpeg
      ? {
          type: 'jpeg',
          quality: 65,
          fullPage: false,
        }
      : {
          type: 'png',
          fullPage: false,
        },
  )

  entry.cachedAt = now
  if (isJpeg) {
    entry.cachedJpeg = image
  } else {
    entry.cachedPng = image
  }
  return image
}

const buildDiffFrame = (leftBuffer, rightBuffer, threshold, mode, quality) => {
  const left = PNG.sync.read(leftBuffer)
  const right = PNG.sync.read(rightBuffer)
  const width = Math.min(left.width, right.width)
  const height = Math.min(left.height, right.height)
  const output = new PNG({ width, height })
  const adaptiveStep =
    quality === 'precise'
      ? 1
      : Math.max(
          DIFF_SAMPLE_STEP,
          Math.ceil(Math.sqrt((width * height) / MAX_DIFF_SAMPLES)),
        )

  for (let y = 0; y < height; y += adaptiveStep) {
    for (let x = 0; x < width; x += adaptiveStep) {
      const leftIndex = (left.width * y + x) * 4
      const rightIndex = (right.width * y + x) * 4

      const rDiff = Math.abs(left.data[leftIndex] - right.data[rightIndex])
      const gDiff = Math.abs(left.data[leftIndex + 1] - right.data[rightIndex + 1])
      const bDiff = Math.abs(left.data[leftIndex + 2] - right.data[rightIndex + 2])
      const delta = (rDiff + gDiff + bDiff) / (3 * 255)

      const alpha =
        delta > threshold
          ? mode === 'binary'
            ? 220
            : clamp(Math.round(delta * 255), 80, 255)
          : 0

      // Fill a sampled block with the mismatch value to reduce CPU cost.
      for (let dy = 0; dy < adaptiveStep; dy += 1) {
        for (let dx = 0; dx < adaptiveStep; dx += 1) {
          const px = x + dx
          const py = y + dy
          if (px >= width || py >= height) continue
          const index = (width * py + px) * 4
          output.data[index] = alpha ? 255 : 0
          output.data[index + 1] = 0
          output.data[index + 2] = 0
          output.data[index + 3] = alpha
        }
      }
    }
  }

  return PNG.sync.write(
    output,
    quality === 'precise'
      ? {
          colorType: 6,
          inputColorType: 6,
          compressionLevel: 6,
        }
      : {
          colorType: 6,
          inputColorType: 6,
          compressionLevel: 3,
        },
  )
}

const performInteraction = async (page, payload) => {
  const type = payload?.type
  const button = payload?.button || 'left'

  const toMouseButton = (value) => {
    if (value === 'right' || value === 'middle' || value === 'left') return value
    return 'left'
  }

  if (type === 'click') {
    const x = Number(payload.x)
    const y = Number(payload.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    await page.mouse.move(x, y)
    await page.mouse.down({ button: toMouseButton(button) })
    await page.mouse.up({ button: toMouseButton(button) })
    return
  }

  if (type === 'pointer') {
    const x = Number(payload.x)
    const y = Number(payload.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    await page.mouse.move(x, y)
    if (payload.action === 'down') {
      await page.mouse.down({ button: toMouseButton(button) })
      return
    }
    if (payload.action === 'up') {
      await page.mouse.up({ button: toMouseButton(button) })
      return
    }
    if (payload.action === 'click') {
      await page.mouse.down({ button: toMouseButton(button) })
      await page.mouse.up({ button: toMouseButton(button) })
      return
    }
    return
  }

  if (type === 'wheel') {
    const deltaX = Number(payload.deltaX)
    const deltaY = Number(payload.deltaY)
    await page.mouse.wheel(
      Number.isFinite(deltaX) ? deltaX : 0,
      Number.isFinite(deltaY) ? deltaY : 0,
    )
    return
  }

  if (type === 'key') {
    const key = String(payload.key || '')
    if (!key) return
    await page.keyboard.press(key)
    return
  }
}

const closeSession = async (sessionId) => {
  const existing = sessions.get(sessionId)
  if (!existing) return
  sessions.delete(sessionId)
  await Promise.allSettled([
    existing.left.page.close(),
    existing.right.page.close(),
    existing.context.close(),
  ])
}

app.get('/api/live/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/live/session', async (req, res) => {
  const leftUrl = normalizeUrl(req.body?.leftUrl)
  const rightUrl = normalizeUrl(req.body?.rightUrl)

  if (!validateUrl(leftUrl) || !validateUrl(rightUrl)) {
    res.status(400).json({ error: 'Both URLs must be valid http(s) addresses.' })
    return
  }

  try {
    const browser = await getBrowser()
    const context = await browser.newContext({
      viewport: VIEWPORT,
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    })
    const leftPage = await context.newPage()
    const rightPage = await context.newPage()

    const [leftResult, rightResult] = await Promise.allSettled([
      openWebsite(leftPage, leftUrl),
      openWebsite(rightPage, rightUrl),
    ])

    if (leftResult.status === 'rejected' || rightResult.status === 'rejected') {
      await Promise.allSettled([leftPage.close(), rightPage.close(), context.close()])

      const details = {
        left:
          leftResult.status === 'rejected'
            ? leftResult.reason instanceof Error
              ? leftResult.reason.message
              : String(leftResult.reason)
            : 'ok',
        right:
          rightResult.status === 'rejected'
            ? rightResult.reason instanceof Error
              ? rightResult.reason.message
              : String(rightResult.reason)
            : 'ok',
      }

      res.status(500).json({
        error:
          'Could not open one or both websites in the browser worker. Check the details below.',
        details,
      })
      return
    }

    const sessionId = crypto.randomUUID()
    sessions.set(sessionId, {
      id: sessionId,
      context,
      left: { page: leftPage, cachedAt: 0, cachedJpeg: null, cachedPng: null },
      right: { page: rightPage, cachedAt: 0, cachedJpeg: null, cachedPng: null },
      diffCache: {
        key: '',
        leftStamp: 0,
        rightStamp: 0,
        buffer: null,
      },
      createdAt: Date.now(),
      leftUrl,
      rightUrl,
    })

    res.json({ sessionId })
  } catch (error) {
    res.status(500).json({
      error:
        'Could not open one or both websites in the browser worker. Check the details below.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/live/session/:id/frame/:side(left|right)', async (req, res) => {
  const session = sessions.get(req.params.id)
  const side = req.params.side

  if (!session) {
    res.status(404).json({ error: 'Session or frame side not found.' })
    return
  }

  try {
    const frame = await captureFrame(session, side, 'jpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'image/jpeg')
    res.status(200).send(frame)
  } catch (error) {
    res.status(500).json({
      error: 'Failed to capture frame.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/live/session/:id/frame/diff', async (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  const threshold = parseThreshold(req.query.threshold)
  const mode = parseMode(req.query.mode)
  const quality = parseQuality(req.query.quality)

  try {
    const [leftFrame, rightFrame] = await Promise.all([
      captureFrame(session, 'left', 'png'),
      captureFrame(session, 'right', 'png'),
    ])
    const cacheKey = `${mode}:${quality}:${threshold.toFixed(3)}`
    const leftStamp = session.left.cachedAt
    const rightStamp = session.right.cachedAt

    if (
      session.diffCache.key === cacheKey &&
      session.diffCache.leftStamp === leftStamp &&
      session.diffCache.rightStamp === rightStamp &&
      session.diffCache.buffer
    ) {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'image/png')
      res.status(200).send(session.diffCache.buffer)
      return
    }

    const diffFrame = buildDiffFrame(leftFrame, rightFrame, threshold, mode, quality)
    session.diffCache = {
      key: cacheKey,
      leftStamp,
      rightStamp,
      buffer: diffFrame,
    }

    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'image/png')
    res.status(200).send(diffFrame)
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate mismatch frame.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/live/session/:id/interaction', async (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  try {
    await Promise.all([
      performInteraction(session.left.page, req.body || {}),
      performInteraction(session.right.page, req.body || {}),
    ])

    // Invalidate frame caches so next fetch reflects latest state.
    session.left.cachedAt = 0
    session.right.cachedAt = 0
    session.left.cachedJpeg = null
    session.right.cachedJpeg = null
    session.left.cachedPng = null
    session.right.cachedPng = null
    session.diffCache.key = ''
    session.diffCache.leftStamp = 0
    session.diffCache.rightStamp = 0
    session.diffCache.buffer = null

    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({
      error: 'Interaction dispatch failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.delete('/api/live/session/:id', async (req, res) => {
  await closeSession(req.params.id)
  res.json({ ok: true })
})

const shutdown = async () => {
  const ids = [...sessions.keys()]
  await Promise.allSettled(ids.map((id) => closeSession(id)))
  if (browserPromise) {
    const browser = await browserPromise
    await browser.close()
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

app.listen(PORT, () => {
  console.log(`Live website backend listening on http://localhost:${PORT}`)
})
