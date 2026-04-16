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
            const patchScript = `<script>(function(){var o=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,a){if(t==="webgl"||t==="webgl2"||t==="experimental-webgl")a=Object.assign({},a,{preserveDrawingBuffer:true});return o.call(this,t,a);};})()</script>`;
            // Mirror script: captures native events → postMessage to parent → parent relays to sibling iframe
            const mirrorScript = `<script>(function(){
var m=false;
var MIRROR_SIDE='${side}';
var betCache=new Map();
var betWaiters=new Map();
var BET_CACHE_MS=5000;
var BET_WAIT_MS=900;
var RIGHT_BET_WAIT_MS=2500;
var dbg=function(){};
function nowTs(){return Date.now();}
function pathKeyOf(url){
try{
var u=new URL(url,window.location.href);
return u.pathname||'/';
}catch(x){return String(url||'');}
}
function safeToString(v){
if(v==null)return '';
if(typeof v==='string')return v;
try{return String(v);}catch(x){return '';}
}
function bodyKeyOf(body){
try{
if(body==null)return '';
if(typeof body==='string')return body;
if(typeof URLSearchParams!=='undefined'&&body instanceof URLSearchParams)return body.toString();
if(typeof FormData!=='undefined'&&body instanceof FormData){
var out=[];
body.forEach(function(v,k){out.push(String(k)+'='+safeToString(v));});
return out.join('&');
}
if(typeof ArrayBuffer!=='undefined'&&body instanceof ArrayBuffer)return 'ab:'+body.byteLength;
if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(body))return 'view:'+body.byteLength;
if(typeof Blob!=='undefined'&&body instanceof Blob)return 'blob:'+body.size;
if(typeof body==='object')return JSON.stringify(body);
}catch(x){}
return '';
}
function hashOf(text){
var s=safeToString(text);
var h=5381;
for(var i=0;i<s.length;i++){h=((h<<5)+h)+s.charCodeAt(i);h=h|0;}
return String(h>>>0);
}
function betKeyOf(url,method,body){
var p=pathKeyOf(url);
var b=bodyKeyOf(body);
return String(method||'GET').toUpperCase()+'|'+p+'|'+hashOf(b);
}
function isBetReq(url,method){
var mth=String(method||'GET').toUpperCase();
if(mth!=='POST')return false;
var p=pathKeyOf(url);
return /(^|\\/)bet(?:$|[/?#])/i.test(p);
}
function putBet(pathKey,payload){
var next=Object.assign({},payload,{storedAt:nowTs()});
betCache.set(pathKey,next);
if(betWaiters.has(pathKey)){
var list=betWaiters.get(pathKey)||[];
betWaiters.delete(pathKey);
for(var i=0;i<list.length;i++){
try{list[i](next);}catch(x){}
}
}
}
function getBet(pathKey){
var cached=betCache.get(pathKey);
if(!cached)return null;
if(nowTs()-(cached.storedAt||0)>BET_CACHE_MS){
betCache.delete(pathKey);
return null;
}
return cached;
}
function waitBet(pathKey,ms){
var immediate=getBet(pathKey);
if(immediate)return Promise.resolve(immediate);
return new Promise(function(resolve){
var done=false;
var timer=setTimeout(function(){
if(done)return;
done=true;
var list=betWaiters.get(pathKey)||[];
var next=[];
for(var i=0;i<list.length;i++){if(list[i]!==resolver)next.push(list[i]);}
if(next.length)betWaiters.set(pathKey,next);else betWaiters.delete(pathKey);
resolve(null);
},ms);
function resolver(payload){
if(done)return;
done=true;
clearTimeout(timer);
resolve(payload||null);
}
var list=betWaiters.get(pathKey)||[];
list.push(resolver);
betWaiters.set(pathKey,list);
});
}
function waitAnyBet(key,path,ms){
var immediate=getBet(key)||getBet(path);
if(immediate)return Promise.resolve(immediate);
return Promise.race([
waitBet(key,ms),
waitBet(path,ms),
]).then(function(hit){
return hit||getBet(key)||getBet(path)||null;
});
}
function headersToObj(h){
var o={};
try{h.forEach(function(v,k){o[k]=v;});}catch(x){}
return o;
}
function bytesToReplayBody(bytes){
if(!bytes)return null;
if(bytes instanceof Uint8Array)return bytes.slice(0);
if(typeof ArrayBuffer!=='undefined'&&bytes instanceof ArrayBuffer)return new Uint8Array(bytes.slice(0));
if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(bytes))return new Uint8Array(bytes.buffer.slice(0));
return null;
}
function postBetCapture(payload){
try{
var bodySize=(payload&&payload.body&&payload.body.byteLength)||0;
window.parent.postMessage({__betCapture:true,key:payload.key,path:payload.path,status:payload.status,headers:payload.headers,body:payload.body,bodySize:bodySize,sentAt:Date.now()},'*');
}catch(x){}
}
if(window.fetch){
var _fetch=window.fetch.bind(window);
window.fetch=async function(input,init){
var reqUrl=typeof input==='string'?input:(input&&input.url)||'';
var method=(init&&init.method)||((input&&input.method)||'GET');
var reqBody=(init&&('body' in init))?init.body:undefined;
var path=pathKeyOf(reqUrl);
var key=betKeyOf(reqUrl,method,reqBody);
var isBet=isBetReq(reqUrl,method);
if(isBet&&MIRROR_SIDE==='right'){
var replay=getBet(key)||getBet(path);
if(!replay)replay=await waitAnyBet(key,path,RIGHT_BET_WAIT_MS);
if(replay&&replay.body!=null){
dbg('[bet-mirror][fetch] replay',path,'key',key.slice(0,10),'status',replay.status||200,'bytes',replay.body.byteLength||0);
return new Response(replay.body.slice(0),{status:replay.status||200,headers:replay.headers||{}});
}
dbg('[bet-mirror][fetch] miss',path,'key',key.slice(0,10));
}
var resp=await _fetch(input,init);
if(isBet){
try{
var clone=resp.clone();
var ab=await clone.arrayBuffer();
var payload={key:key,path:path,status:clone.status||200,headers:headersToObj(clone.headers),body:new Uint8Array(ab)};
putBet(key,payload);
putBet(path,payload);
dbg('[bet-mirror][fetch] capture',path,'key',key.slice(0,10),'status',payload.status||200,'bytes',payload.body.byteLength||0);
if(MIRROR_SIDE==='left')postBetCapture(payload);
}catch(x){}
}
return resp;
};
}
if(window.XMLHttpRequest&&window.XMLHttpRequest.prototype){
var xo=XMLHttpRequest.prototype.open;
var xs=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(method,url,async,user,password){
this.__bmMethod=String(method||'GET').toUpperCase();
this.__bmUrl=url||'';
return xo.call(this,method,url,async,user,password);
};
XMLHttpRequest.prototype.send=function(body){
var self=this;
var method=self.__bmMethod||'GET';
var url=self.__bmUrl||'';
var path=pathKeyOf(url);
var key=betKeyOf(url,method,body);
var emitReplay=function(replay){
try{
var text='';
try{text=new TextDecoder().decode(replay.body);}catch(x){}
Object.defineProperty(self,'readyState',{configurable:true,value:4});
Object.defineProperty(self,'status',{configurable:true,value:replay.status||200});
Object.defineProperty(self,'responseURL',{configurable:true,value:String(url||'')});
if(!self.responseType||self.responseType==='text'){
Object.defineProperty(self,'responseText',{configurable:true,value:text});
Object.defineProperty(self,'response',{configurable:true,value:text});
}else if(self.responseType==='json'){
var obj=null;try{obj=JSON.parse(text);}catch(x){}
Object.defineProperty(self,'response',{configurable:true,value:obj});
}else if(self.responseType==='arraybuffer'){
Object.defineProperty(self,'response',{configurable:true,value:replay.body.buffer.slice(0)});
}
setTimeout(function(){try{self.dispatchEvent(new Event('readystatechange'));}catch(x){};try{self.dispatchEvent(new Event('load'));}catch(x){};try{self.dispatchEvent(new Event('loadend'));}catch(x){};if(typeof self.onreadystatechange==='function'){try{self.onreadystatechange();}catch(x){}};if(typeof self.onload==='function'){try{self.onload();}catch(x){}};if(typeof self.onloadend==='function'){try{self.onloadend();}catch(x){}};},0);
dbg('[bet-mirror][xhr] replay',path,'key',key.slice(0,10),'status',replay.status||200,'bytes',replay.body.byteLength||0);
return true;
}catch(x){
return false;
}
};
var proceed=function(){
if(isBetReq(url,method)){
self.addEventListener('loadend',function(){
try{
var bytes=null;
if(self.responseType==='arraybuffer'&&self.response){bytes=new Uint8Array(self.response);}else if(self.response&&typeof self.response==='string'){bytes=new TextEncoder().encode(self.response);}else if(typeof self.responseText==='string'){bytes=new TextEncoder().encode(self.responseText);}else{return;}
var headersRaw=self.getAllResponseHeaders?self.getAllResponseHeaders():'';
var headersObj={};
if(headersRaw){headersRaw.trim().split(/\\r?\\n/).forEach(function(line){var i=line.indexOf(':');if(i>0){var k=line.slice(0,i).trim().toLowerCase();var v=line.slice(i+1).trim();headersObj[k]=v;}});}
var payload={key:key,path:path,status:self.status||200,headers:headersObj,body:bytes};
putBet(key,payload);putBet(path,payload);
dbg('[bet-mirror][xhr] capture',path);
postBetCapture(payload);
}catch(x){}
},{once:true});
}
return xs.call(self,body);
};
if(isBetReq(url,method)){
var replay=getBet(key)||getBet(path);
if(replay&&replay.body!=null){
if(emitReplay(replay))return;
}
if(MIRROR_SIDE==='right'){
dbg('[bet-mirror][xhr] hold',path,'key',key.slice(0,10),'wait',RIGHT_BET_WAIT_MS);
waitAnyBet(key,path,RIGHT_BET_WAIT_MS).then(function(hit){
if(hit&&hit.body!=null){
if(emitReplay(hit))return;
}
dbg('[bet-mirror][xhr] miss',path,'key',key.slice(0,10));
proceed();
}).catch(function(){
dbg('[bet-mirror][xhr] miss',path,'key',key.slice(0,10));
proceed();
});
return;
}
}
return proceed();
};
}
function pickTarget(el){
if(!el)return null;
if(el.closest){
var c=el.closest('.tp-toggle-btn,button,[role="button"],a,input[type="button"],input[type="submit"],label');
if(c)return c;
}
return el;
}
function buildPath(el){
try{
if(!el||!el.tagName)return '';
var parts=[];
var cur=el;
while(cur&&cur.nodeType===1&&cur!==document.body){
var tag=cur.tagName.toLowerCase();
if(cur.id){parts.unshift(tag+'#'+CSS.escape(cur.id));break;}
var idx=1;
var s=cur;
while((s=s.previousElementSibling)){if(s.tagName===cur.tagName)idx++;}
parts.unshift(tag+':nth-of-type('+idx+')');
cur=cur.parentElement;
}
parts.unshift('body');
return parts.join(' > ');
}catch(x){return '';}
}
function hintOf(el){
if(!el)return null;
el=pickTarget(el);
var classes=[];
if(el.classList){for(var i=0;i<el.classList.length;i++)classes.push(el.classList[i]);}
return {
id:el.id||'',
tag:el.tagName?el.tagName.toLowerCase():'',
text:(el.innerText||el.textContent||'').trim().slice(0,120),
classes:classes,
path:buildPath(el)
};
}
function findByHint(h){
try{
if(!h)return null;
if(h.id){var byId=document.getElementById(h.id);if(byId)return byId;}
if(h.path){try{var byPath=document.querySelector(h.path);if(byPath)return byPath;}catch(x){}}
if(h.classes&&h.classes.length){
for(var i=0;i<h.classes.length;i++){
var cls=h.classes[i];
if(!cls)continue;
var esc=(window.CSS&&CSS.escape)?CSS.escape(cls):String(cls).replace(/[^a-zA-Z0-9_-]/g,'\\$&');
var byClass=document.querySelector('.'+esc);
if(byClass)return byClass;
}
}
if(h.tag&&h.text){
var list=document.querySelectorAll(h.tag+',button,[role="button"],a,input[type="button"],input[type="submit"],label');
for(var j=0;j<list.length;j++){
var t=(list[j].innerText||list[j].textContent||'').trim().slice(0,120);
if(t===h.text)return list[j];
}
}
}catch(x){return null;}
return null;
}
['click','pointerdown','pointerup'].forEach(function(t){
document.addEventListener(t,function(e){
if(m)return;
var vw=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1);
var vh=Math.max(1,window.innerHeight||document.documentElement.clientHeight||1);
window.parent.postMessage({__mirror:true,type:e.type,cx:e.clientX,cy:e.clientY,rx:e.clientX/vw,ry:e.clientY/vh,sx:e.screenX,sy:e.screenY,btn:e.button,btns:e.buttons,pid:e.pointerId,ptype:e.pointerType,pressure:e.pressure,h:hintOf(e.target),sentAt:Date.now()},'*');
},true);
});
document.addEventListener('wheel',function(e){
if(m)return;
window.parent.postMessage({__mirrorWheel:true,dx:e.deltaX,dy:e.deltaY,dm:e.deltaMode,cx:e.clientX,cy:e.clientY,sentAt:Date.now()},'*');
},true);
['keydown','keyup','keypress'].forEach(function(t){
document.addEventListener(t,function(e){
if(m)return;
if(MIRROR_SIDE==='right'){
e.preventDefault();
e.stopPropagation();
return;
}
window.parent.postMessage({__mirrorKey:true,type:t,key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,location:e.location,repeat:e.repeat,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey,h:hintOf(document.activeElement||e.target),sentAt:Date.now()},'*');
},true);
});
['input','change'].forEach(function(t){
document.addEventListener(t,function(e){
if(m)return;
if(MIRROR_SIDE==='right'){
e.preventDefault();
e.stopPropagation();
return;
}
var el=e.target;
if(!el)return;
window.parent.postMessage({__mirrorInput:true,eventType:t,h:hintOf(el),value:('value' in el)?el.value:null,checked:('checked' in el)?!!el.checked:null,inputType:el.type||'',sentAt:Date.now()},'*');
},true);
});
window.addEventListener('message',function(ev){
var d=ev.data;if(!d)return;
if(d.__betCaptureReplay){
try{
if(d.path){
var replayPayload={key:String(d.key||''),path:String(d.path),status:d.status||200,headers:d.headers||{},body:d.body||null};
if(d.key){putBet(String(d.key),replayPayload);}
putBet(String(d.path),replayPayload);
dbg('[bet-mirror][relay] received',String(d.path),'key',String(d.key||'').slice(0,10),'status',d.status||200,'bytes',d.bodySize||((d.body&&d.body.byteLength)||0));
}
}catch(x){}
}
if(d.__mirrorReplay){
m=true;
try{
var targetW=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1);
var targetH=Math.max(1,window.innerHeight||document.documentElement.clientHeight||1);
var px=typeof d.rx==='number'&&isFinite(d.rx)?d.rx*targetW:d.cx;
var py=typeof d.ry==='number'&&isFinite(d.ry)?d.ry*targetH:d.cy;
var hinted=d.type==='click'?findByHint(d.h):null;
var el=hinted||document.elementFromPoint(px,py);
if(el){
if(d.type==='click'){
el.click();
}else{
var isP=d.type.indexOf('pointer')===0;
var C=isP?PointerEvent:MouseEvent;
var p={bubbles:true,cancelable:true,composed:true,clientX:px,clientY:py,screenX:d.sx,screenY:d.sy,button:d.btn,buttons:d.btns,view:window};
if(isP){p.pointerId=d.pid!=null?d.pid:1;p.pointerType=d.ptype||'mouse';p.isPrimary=true;p.pressure=d.pressure||0.5;p.width=1;p.height=1;}
el.dispatchEvent(new C(d.type,p));
}
}}catch(x){}
m=false;
}
if(d.__mirrorWheelReplay){
m=true;
try{
var dx=d.dx,dy=d.dy;
if(d.dm===1){dx*=40;dy*=40;}
if(d.dm===2){dx*=window.innerHeight;dy*=window.innerHeight;}
var el=document.elementFromPoint(d.cx,d.cy);
while(el&&el!==document.documentElement){
var s=getComputedStyle(el);
if(((s.overflowY==='auto'||s.overflowY==='scroll')&&el.scrollHeight>el.clientHeight)||((s.overflowX==='auto'||s.overflowX==='scroll')&&el.scrollWidth>el.clientWidth)){el.scrollBy(dx,dy);m=false;return;}
el=el.parentElement;}
window.scrollBy(dx,dy);
}catch(x){}
m=false;
}
if(d.__mirrorKeyReplay){
m=true;
try{
var target=findByHint(d.h)||document.activeElement||document.body||document;
var evk=new KeyboardEvent(d.type||'keydown',{key:d.key||'',code:d.code||'',location:d.location||0,repeat:!!d.repeat,ctrlKey:!!d.ctrlKey,shiftKey:!!d.shiftKey,altKey:!!d.altKey,metaKey:!!d.metaKey,bubbles:true,cancelable:true,composed:true});
target.dispatchEvent(evk);
}catch(x){}
m=false;
}
if(d.__mirrorInputReplay){
m=true;
try{
var inputEl=findByHint(d.h);
if(inputEl&&('value' in inputEl||'checked' in inputEl)){
if((d.inputType==='checkbox'||d.inputType==='radio')&&('checked' in inputEl)){
inputEl.checked=!!d.checked;
}else if('value' in inputEl&&d.value!=null){
inputEl.value=d.value;
}
inputEl.dispatchEvent(new Event(d.eventType==='change'?'change':'input',{bubbles:true,cancelable:false,composed:true}));
}
}catch(x){}
m=false;
}
});
})()</script>`;

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
