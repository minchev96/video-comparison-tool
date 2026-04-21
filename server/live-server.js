/**
 * Live Website Comparison – Reverse-Proxy Backend
 *
 * Instead of rendering pages in headless Chrome and streaming screenshots,
 * this server acts as a reverse proxy so the client can embed both target
 * websites in same-origin iframes.  The user's own browser GPU does all
 * the rendering at native 60 fps with zero overhead.
 *
 * Routes
 * ──────
 *   POST /api/live/session           → register a session (left + right URL)
 *   DELETE /api/live/session/:id     → tear down
 *   GET  /api/live/health            → health-check
 *   /proxy/left/:id/**               → reverse-proxy for the left URL
 *   /proxy/right/:id/**              → reverse-proxy for the right URL
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import express from "express";
import cors from "cors";
import { getMirrorScript, getPatchScript } from "./injected-scripts.js";

const PORT = 8787;
const MAX_SESSIONS = 5;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 30 * 1000;
const parseEnvMs = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sessions = new Map();
const BET_REPLAY_WAIT_MS = parseEnvMs(process.env.BET_REPLAY_WAIT_MS, 450);
const BET_REPLAY_STALE_MS = parseEnvMs(process.env.BET_REPLAY_STALE_MS, 5000);
const BET_PATH_RE = /(^|\/)bet(?:$|[/?#])/i;

const betDebugLog = () => {};

// ── helpers ─────────────────────────────────────────────────────────

const normalizeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
};

const validateUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const touchSession = (session) => {
  session.lastAccessAt = Date.now();
};

const closeSession = (sessionId) => {
  sessions.delete(sessionId);
};

const closeStaleSessions = () => {
  const now = Date.now();
  for (const [id] of sessions.entries()) {
    const session = sessions.get(id);
    const last = session.lastAccessAt || session.createdAt || 0;
    if (now - last > SESSION_IDLE_TIMEOUT_MS) {
      sessions.delete(id);
    }
  }
};

const createHash = (value) =>
  crypto.createHash("sha1").update(value).digest("hex");

const pathnameFromPathWithQuery = (pathWithQuery) => {
  const raw = String(pathWithQuery || "");
  const q = raw.indexOf("?");
  const h = raw.indexOf("#");
  const end =
    q === -1 ? (h === -1 ? raw.length : h) : h === -1 ? q : Math.min(q, h);
  return raw.slice(0, end || raw.length) || "/";
};

const isBetPath = (pathWithQuery) =>
  BET_PATH_RE.test(pathnameFromPathWithQuery(pathWithQuery));

const isTextualBodyType = (contentType) => {
  const value = String(contentType || "").toLowerCase();
  return (
    value.includes("application/json") ||
    value.includes("application/graphql") ||
    value.includes("application/x-www-form-urlencoded") ||
    value.includes("text/plain")
  );
};

const isBetRequestBody = (bodyBuffer, contentType) => {
  if (!bodyBuffer?.length) return false;
  if (!isTextualBodyType(contentType)) return false;
  const bodyText = bodyBuffer.toString("utf-8").toLowerCase();
  return (
    bodyText.includes("bet") ||
    bodyText.includes("stake") ||
    bodyText.includes("wager")
  );
};

const buildBetFingerprint = (
  method,
  pathWithQuery,
  bodyBuffer,
  contentType,
) => {
  const bodyKey = bodyBuffer?.length
    ? isTextualBodyType(contentType)
      ? bodyBuffer.toString("utf-8")
      : bodyBuffer.toString("base64")
    : "";
  const base = `${method}|${pathnameFromPathWithQuery(pathWithQuery)}|${bodyKey}`;
  return createHash(base);
};

const getBetRequestMeta = ({
  method,
  pathWithQuery,
  bodyBuffer,
  contentType,
}) => {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const byPath = isBetPath(pathWithQuery);
  const byBody = isBetRequestBody(bodyBuffer, contentType);
  const isBet = normalizedMethod === "POST" && (byPath || byBody);
  return {
    isBet,
    method: normalizedMethod,
    pathKey: pathnameFromPathWithQuery(pathWithQuery),
    fingerprint: isBet
      ? buildBetFingerprint(
          normalizedMethod,
          pathWithQuery,
          bodyBuffer,
          contentType,
        )
      : "",
  };
};

const sanitizeReplayHeaders = (headers, bodyLength) => {
  const next = { ...(headers || {}) };
  delete next["content-encoding"];
  delete next["transfer-encoding"];
  delete next["set-cookie"];
  next["content-length"] = String(bodyLength);
  next["access-control-allow-origin"] = "*";
  next["access-control-expose-headers"] = "*";
  return next;
};

const storeLeftBetResponse = (session, key, payload) => {
  if (!session.leftBetResponses) session.leftBetResponses = new Map();
  if (!session.leftBetResponsesByPath)
    session.leftBetResponsesByPath = new Map();

  const enriched = {
    ...payload,
    pathKey: key.pathKey,
    fingerprint: key.fingerprint,
    storedAt: Date.now(),
  };

  session.leftBetResponses.set(key.fingerprint, enriched);
  session.leftBetResponsesByPath.set(key.pathKey, enriched);
  betDebugLog(
    `store left response path=${key.pathKey} fp=${key.fingerprint.slice(0, 10)} status=${payload.statusCode || 200} bytes=${payload.body?.length || 0}`,
  );
  if (session.pendingBetWaiters?.has(key.fingerprint)) {
    const waiters = session.pendingBetWaiters.get(key.fingerprint);
    session.pendingBetWaiters.delete(key.fingerprint);
    waiters.forEach((resolve) => {
      resolve(enriched);
    });
  }

  session.lastLeftBetResponse = payload;
  if (session.leftBetResponses.size > 60) {
    const firstKey = session.leftBetResponses.keys().next().value;
    session.leftBetResponses.delete(firstKey);
  }
  if (session.leftBetResponsesByPath.size > 60) {
    const firstPath = session.leftBetResponsesByPath.keys().next().value;
    session.leftBetResponsesByPath.delete(firstPath);
  }
};

const getCachedBetResponse = (session, meta) => {
  const now = Date.now();
  const byFingerprint = session.leftBetResponses?.get(meta.fingerprint);
  if (
    byFingerprint &&
    now - (byFingerprint.storedAt || 0) <= BET_REPLAY_STALE_MS
  ) {
    betDebugLog(
      `cache hit by fingerprint path=${meta.pathKey} fp=${meta.fingerprint.slice(0, 10)}`,
    );
    return byFingerprint;
  }
  const byPath = session.leftBetResponsesByPath?.get(meta.pathKey);
  if (byPath && now - (byPath.storedAt || 0) <= BET_REPLAY_STALE_MS) {
    betDebugLog(`cache hit by path path=${meta.pathKey}`);
    return byPath;
  }
  betDebugLog(
    `cache miss path=${meta.pathKey} fp=${meta.fingerprint.slice(0, 10)} hasFP=${session.leftBetResponses?.has(meta.fingerprint) ? "yes" : "no"} hasPath=${session.leftBetResponsesByPath?.has(meta.pathKey) ? "yes" : "no"}`,
  );
  return null;
};

const waitForBetResponse = (session, fingerprint, timeoutMs) => {
  if (!session.pendingBetWaiters) session.pendingBetWaiters = new Map();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiters = session.pendingBetWaiters.get(fingerprint);
      if (waiters) {
        waiters.delete(done);
        if (!waiters.size) session.pendingBetWaiters.delete(fingerprint);
      }
      resolve(null);
    }, timeoutMs);

    const done = (payload) => {
      clearTimeout(timer);
      resolve(payload || null);
    };

    const waiters = session.pendingBetWaiters.get(fingerprint) || new Set();
    waiters.add(done);
    session.pendingBetWaiters.set(fingerprint, waiters);
  });
};

// ── API routes ──────────────────────────────────────────────────────

app.get("/api/live/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/live/session", (req, res) => {
  const leftUrl = normalizeUrl(req.body?.leftUrl);
  const rightUrl = normalizeUrl(req.body?.rightUrl);

  if (!validateUrl(leftUrl) || !validateUrl(rightUrl)) {
    return res
      .status(400)
      .json({ error: "Both URLs must be valid http(s) addresses." });
  }

  // Evict oldest if at limit
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0),
    )[0];
    if (oldest) sessions.delete(oldest[0]);
  }

  const leftParsed = new URL(leftUrl);
  const rightParsed = new URL(rightUrl);

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    id: sessionId,
    leftUrl,
    rightUrl,
    leftOrigin: leftParsed.origin,
    rightOrigin: rightParsed.origin,
    leftPath: leftParsed.pathname + leftParsed.search + leftParsed.hash,
    rightPath: rightParsed.pathname + rightParsed.search + rightParsed.hash,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
  });

  res.json({
    sessionId,
    leftProxyBase: `/proxy/left/${sessionId}`,
    rightProxyBase: `/proxy/right/${sessionId}`,
    leftPath: leftParsed.pathname + leftParsed.search + leftParsed.hash,
    rightPath: rightParsed.pathname + rightParsed.search + rightParsed.hash,
  });
});

app.delete("/api/live/session/:id", (req, res) => {
  closeSession(req.params.id);
  res.json({ ok: true });
});

// ── Reverse Proxy ───────────────────────────────────────────────────
// /proxy/left/:sessionId/**  →  leftOrigin/**
// /proxy/right/:sessionId/** →  rightOrigin/**
//
// We use raw http(s).request instead of http-proxy-middleware to have
// full control over header rewriting and response streaming without
// external dependencies.

const proxyHandler = (side) => (req, res) => {
  const sessionId = req.params.id;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }
  touchSession(session);

  const origin = side === "left" ? session.leftOrigin : session.rightOrigin;
  const prefix = `/proxy/${side}/${sessionId}`;
  const targetPath = req.originalUrl.slice(prefix.length) || "/";
  const targetUrl = new URL(targetPath, origin);
  const pathWithQuery = targetUrl.pathname + targetUrl.search;

  const isHttps = targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  // Build outgoing headers – forward most, override host/origin
  const outHeaders = { ...req.headers };
  outHeaders.host = targetUrl.host;
  outHeaders.origin = origin;
  delete outHeaders.referer;
  delete outHeaders.cookie;
  // Remove accept-encoding to get uncompressed responses we can rewrite
  // (simpler than handling gzip/brotli for HTML content-rewriting)
  delete outHeaders["accept-encoding"];

  const method = String(req.method || "GET").toUpperCase();
  const shouldReadBody = !["GET", "HEAD", "OPTIONS"].includes(method);

  const requestBodyChunks = [];

  const startProxyRequest = async (requestBody) => {
    const betMeta = getBetRequestMeta({
      method,
      pathWithQuery,
      bodyBuffer: requestBody,
      contentType: req.headers["content-type"],
    });

    if (side === "right" && betMeta.isBet) {
      betDebugLog(
        `right bet request path=${betMeta.pathKey} fp=${betMeta.fingerprint.slice(0, 10)} bytes=${requestBody.length}`,
      );
      let cached = getCachedBetResponse(session, betMeta);
      if (!cached) {
        cached = await waitForBetResponse(
          session,
          betMeta.fingerprint,
          BET_REPLAY_WAIT_MS,
        );
        if (cached) {
          betDebugLog(
            `wait hit for fingerprint path=${betMeta.pathKey} fp=${betMeta.fingerprint.slice(0, 10)}`,
          );
        } else {
          betDebugLog(
            `wait miss for fingerprint path=${betMeta.pathKey} fp=${betMeta.fingerprint.slice(0, 10)} timeout=${BET_REPLAY_WAIT_MS}ms`,
          );
        }
      }
      if (cached?.body) {
        const replayHeaders = sanitizeReplayHeaders(
          cached.headers,
          cached.body.length,
        );
        res.writeHead(cached.statusCode || 200, replayHeaders);
        res.end(cached.body);
        return;
      }
      betDebugLog(
        `proxying right request upstream path=${betMeta.pathKey} fp=${betMeta.fingerprint.slice(0, 10)}`,
      );
    }

    const requestHeaders = { ...outHeaders };
    if (requestBody.length > 0) {
      requestHeaders["content-length"] = String(requestBody.length);
    } else {
      delete requestHeaders["content-length"];
    }

    const proxyReq = transport.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: requestHeaders,
        rejectUnauthorized: false,
      },
      (proxyRes) => {
        // Strip headers that block iframe embedding
        const headers = { ...proxyRes.headers };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        // CORS
        headers["access-control-allow-origin"] = "*";
        headers["access-control-expose-headers"] = "*";

        const contentType = (headers["content-type"] || "").toLowerCase();
        const isHtml = contentType.includes("text/html");

        if (side === "left" && betMeta.isBet) {
          betDebugLog(
            `left bet request path=${betMeta.pathKey} fp=${betMeta.fingerprint.slice(0, 10)} bytes=${requestBody.length}`,
          );
          const chunks = [];
          proxyRes.on("data", (chunk) => chunks.push(chunk));
          proxyRes.on("end", () => {
            const body = Buffer.concat(chunks);
            const replayHeaders = sanitizeReplayHeaders(headers, body.length);
            storeLeftBetResponse(session, betMeta, {
              statusCode: proxyRes.statusCode || 200,
              headers: replayHeaders,
              body,
            });
            res.writeHead(proxyRes.statusCode || 200, replayHeaders);
            res.end(body);
          });
          return;
        }

        if (isHtml) {
          // For HTML responses, rewrite absolute URLs in src/href to go through
          // our proxy.  Collect the full body, do string replacements, send.
          delete headers["content-length"]; // will change after rewrite
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];

          const chunks = [];
          proxyRes.on("data", (chunk) => chunks.push(chunk));
          proxyRes.on("end", () => {
            let body = Buffer.concat(chunks).toString("utf-8");

            // Rewrite absolute URLs pointing to the target origin so they go
            // through our proxy instead.
            const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(escapedOrigin, "g");
            body = body.replace(re, prefix);

            // Also inject a <base> tag so relative URLs resolve through our proxy
            const baseTag = `<base href="${prefix}${targetUrl.pathname.replace(/\/[^/]*$/, "/")}">`;
            // Force preserveDrawingBuffer on WebGL canvases so parent can read pixels for diff
            const patchScript = `<script>${getPatchScript()}</script>`;
            // Mirror script: captures native events and relays to sibling iframe
            const mirrorScript = `<script>${getMirrorScript(side)}</script>`;

            // Strip CSP meta tags that could block our injected scripts
            body = body.replace(
              /<meta[^>]*content-security-policy[^>]*>/gi,
              "",
            );

            body = body.replace(
              /(<head[^>]*>)/i,
              `$1\n${baseTag}\n${patchScript}\n${mirrorScript}\n`,
            );

            const buf = Buffer.from(body, "utf-8");
            headers["content-length"] = String(buf.length);
            res.writeHead(proxyRes.statusCode, headers);
            res.end(buf);
          });
        } else {
          // Non-HTML (JS, CSS, images, WASM, etc.) – stream through directly
          res.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(res);
        }
      },
    );

    proxyReq.on("error", (err) => {
      console.error(`[proxy] ${side} error:`, err.message);
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: "Proxy request failed", details: err.message });
      }
    });

    if (requestBody.length > 0) {
      proxyReq.write(requestBody);
    }
    proxyReq.end();
  };

  if (!shouldReadBody) {
    startProxyRequest(Buffer.alloc(0)).catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: "Proxy processing failed",
          details: err?.message || String(err),
        });
      }
    });
    return;
  }

  req.on("data", (chunk) => requestBodyChunks.push(chunk));
  req.on("end", () => {
    startProxyRequest(Buffer.concat(requestBodyChunks)).catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: "Proxy processing failed",
          details: err?.message || String(err),
        });
      }
    });
  });
  req.on("error", (err) => {
    if (!res.headersSent) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: err.message });
    }
  });
};

// Use wildcard routes to capture everything under /proxy/:side/:id/
app.all("/proxy/left/:id/*", proxyHandler("left"));
app.all("/proxy/left/:id", proxyHandler("left"));
app.all("/proxy/right/:id/*", proxyHandler("right"));
app.all("/proxy/right/:id", proxyHandler("right"));

// ── Cleanup timer ───────────────────────────────────────────────────

setInterval(closeStaleSessions, SESSION_SWEEP_INTERVAL_MS);

// ── Graceful shutdown ───────────────────────────────────────────────

const shutdown = () => {
  sessions.clear();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen(PORT);
