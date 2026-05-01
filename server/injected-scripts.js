// @ts-nocheck
/* eslint-disable */

const patchRuntime = () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (
      type === "webgl" ||
      type === "webgl2" ||
      type === "experimental-webgl"
    ) {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return originalGetContext.call(this, type, attrs);
  };
};

const mirrorRuntime = (side) => {
  let m = false;
  const MIRROR_SIDE = side;
  const betCache = new Map();
  const betWaiters = new Map();
  const BET_CACHE_MS = 5000;
  const _BET_WAIT_MS = 900;
  const RIGHT_BET_WAIT_MS = 900;
  const dbg = () => {};

  function nowTs() {
    return Date.now();
  }

  function pathKeyOf(url) {
    try {
      const u = new URL(url, window.location.href);
      return u.pathname || "/";
    } catch (_x) {
      return String(url || "");
    }
  }

  function safeToString(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      return String(value);
    } catch (_x) {
      return "";
    }
  }

  function bodyKeyOf(body) {
    try {
      if (body == null) return "";
      if (typeof body === "string") return body;
      if (
        typeof URLSearchParams !== "undefined" &&
        body instanceof URLSearchParams
      ) {
        return body.toString();
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const out = [];
        body.forEach((v, k) => {
          out.push(`${String(k)}=${safeToString(v)}`);
        });
        return out.join("&");
      }
      if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
        return `ab:${body.byteLength}`;
      }
      if (
        typeof ArrayBuffer !== "undefined" &&
        ArrayBuffer.isView &&
        ArrayBuffer.isView(body)
      ) {
        return `view:${body.byteLength}`;
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        return `blob:${body.size}`;
      }
      if (typeof body === "object") return JSON.stringify(body);
    } catch (_x) {}
    return "";
  }

  function hashOf(text) {
    const str = safeToString(text);
    let hash = 5381;
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash >>> 0);
  }

  function betKeyOf(url, method, body) {
    const path = pathKeyOf(url);
    const bodyKey = bodyKeyOf(body);
    return `${String(method || "GET").toUpperCase()}|${path}|${hashOf(bodyKey)}`;
  }

  function isBetReq(url, method) {
    const methodName = String(method || "GET").toUpperCase();
    if (methodName !== "POST") return false;
    const path = pathKeyOf(url);
    return /(^|\/)bet(?:$|[/?#])/i.test(path);
  }

  function putBet(pathKey, payload) {
    const next = Object.assign({}, payload, { storedAt: nowTs() });
    betCache.set(pathKey, next);
    if (!betWaiters.has(pathKey)) return;

    const list = betWaiters.get(pathKey) || [];
    betWaiters.delete(pathKey);
    for (let i = 0; i < list.length; i += 1) {
      try {
        list[i](next);
      } catch (_x) {}
    }
  }

  function getBet(pathKey) {
    const cached = betCache.get(pathKey);
    if (!cached) return null;
    if (nowTs() - (cached.storedAt || 0) > BET_CACHE_MS) {
      betCache.delete(pathKey);
      return null;
    }
    return cached;
  }

  function waitBet(pathKey, timeoutMs) {
    const immediate = getBet(pathKey);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const list = betWaiters.get(pathKey) || [];
        const next = [];
        for (let i = 0; i < list.length; i += 1) {
          if (list[i] !== resolver) next.push(list[i]);
        }
        if (next.length) betWaiters.set(pathKey, next);
        else betWaiters.delete(pathKey);
        resolve(null);
      }, timeoutMs);

      function resolver(payload) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(payload || null);
      }

      const list = betWaiters.get(pathKey) || [];
      list.push(resolver);
      betWaiters.set(pathKey, list);
    });
  }

  function waitAnyBet(key, path, timeoutMs) {
    const immediate = getBet(key) || getBet(path);
    if (immediate) return Promise.resolve(immediate);
    return Promise.race([
      waitBet(key, timeoutMs),
      waitBet(path, timeoutMs),
    ]).then((hit) => hit || getBet(key) || getBet(path) || null);
  }

  function headersToObj(headers) {
    const obj = {};
    try {
      headers.forEach((value, key) => {
        obj[key] = value;
      });
    } catch (_x) {}
    return obj;
  }

  function postBetCapture(payload) {
    try {
      const bodySize = payload?.body?.byteLength || 0;
      window.parent.postMessage(
        {
          __betCapture: true,
          key: payload.key,
          path: payload.path,
          status: payload.status,
          headers: payload.headers,
          body: payload.body,
          bodySize: bodySize,
          sentAt: Date.now(),
        },
        "*",
      );
    } catch (_x) {}
  }

  if (window.fetch) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const reqUrl = typeof input === "string" ? input : input?.url || "";
      const method = init?.method || input?.method || "GET";
      const reqBody = init && "body" in init ? init.body : undefined;
      const path = pathKeyOf(reqUrl);
      const key = betKeyOf(reqUrl, method, reqBody);
      const isBet = isBetReq(reqUrl, method);

      if (isBet && MIRROR_SIDE === "right") {
        let replay = getBet(key) || getBet(path);
        if (!replay) replay = await waitAnyBet(key, path, RIGHT_BET_WAIT_MS);
        if (replay && replay.body != null) {
          dbg(
            "[bet-mirror][fetch] replay",
            path,
            "key",
            key.slice(0, 10),
            "status",
            replay.status || 200,
            "bytes",
            replay.body.byteLength || 0,
          );
          return new Response(replay.body.slice(0), {
            status: replay.status || 200,
            headers: replay.headers || {},
          });
        }
        dbg("[bet-mirror][fetch] miss", path, "key", key.slice(0, 10));
      }

      const resp = await originalFetch(input, init);
      if (isBet) {
        try {
          const clone = resp.clone();
          const arrayBuffer = await clone.arrayBuffer();
          const payload = {
            key: key,
            path: path,
            status: clone.status || 200,
            headers: headersToObj(clone.headers),
            body: new Uint8Array(arrayBuffer),
          };
          putBet(key, payload);
          putBet(path, payload);
          dbg(
            "[bet-mirror][fetch] capture",
            path,
            "key",
            key.slice(0, 10),
            "status",
            payload.status || 200,
            "bytes",
            payload.body.byteLength || 0,
          );
          if (MIRROR_SIDE === "left") postBetCapture(payload);
        } catch (_x) {}
      }
      return resp;
    };
  }

  if (window.XMLHttpRequest?.prototype) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method,
      url,
      async,
      user,
      password,
    ) {
      this.__bmMethod = String(method || "GET").toUpperCase();
      this.__bmUrl = url || "";
      return originalOpen.call(this, method, url, async, user, password);
    };

    XMLHttpRequest.prototype.send = function (body) {
      const method = this.__bmMethod || "GET";
      const url = this.__bmUrl || "";
      const path = pathKeyOf(url);
      const key = betKeyOf(url, method, body);

      const emitReplay = (replay) => {
        try {
          let text = "";
          try {
            text = new TextDecoder().decode(replay.body);
          } catch (_x) {}
          Object.defineProperty(this, "readyState", {
            configurable: true,
            value: 4,
          });
          Object.defineProperty(this, "status", {
            configurable: true,
            value: replay.status || 200,
          });
          Object.defineProperty(this, "responseURL", {
            configurable: true,
            value: String(url || ""),
          });

          if (!this.responseType || this.responseType === "text") {
            Object.defineProperty(this, "responseText", {
              configurable: true,
              value: text,
            });
            Object.defineProperty(this, "response", {
              configurable: true,
              value: text,
            });
          } else if (this.responseType === "json") {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (_x) {}
            Object.defineProperty(this, "response", {
              configurable: true,
              value: parsed,
            });
          } else if (this.responseType === "arraybuffer") {
            Object.defineProperty(this, "response", {
              configurable: true,
              value: replay.body.buffer.slice(0),
            });
          }

          setTimeout(() => {
            try {
              this.dispatchEvent(new Event("readystatechange"));
            } catch (_x) {}
            try {
              this.dispatchEvent(new Event("load"));
            } catch (_x) {}
            try {
              this.dispatchEvent(new Event("loadend"));
            } catch (_x) {}
            if (typeof this.onreadystatechange === "function") {
              try {
                this.onreadystatechange();
              } catch (_x) {}
            }
            if (typeof this.onload === "function") {
              try {
                this.onload();
              } catch (_x) {}
            }
            if (typeof this.onloadend === "function") {
              try {
                this.onloadend();
              } catch (_x) {}
            }
          }, 0);

          dbg(
            "[bet-mirror][xhr] replay",
            path,
            "key",
            key.slice(0, 10),
            "status",
            replay.status || 200,
            "bytes",
            replay.body.byteLength || 0,
          );
          return true;
        } catch (_x) {
          return false;
        }
      };

      const proceed = () => {
        if (isBetReq(url, method)) {
          this.addEventListener(
            "loadend",
            () => {
              try {
                let bytes = null;
                if (this.responseType === "arraybuffer" && this.response) {
                  bytes = new Uint8Array(this.response);
                } else if (this.response && typeof this.response === "string") {
                  bytes = new TextEncoder().encode(this.response);
                } else if (typeof this.responseText === "string") {
                  bytes = new TextEncoder().encode(this.responseText);
                } else {
                  return;
                }

                const headersRaw = this.getAllResponseHeaders
                  ? this.getAllResponseHeaders()
                  : "";
                const headersObj = {};
                if (headersRaw) {
                  headersRaw
                    .trim()
                    .split(/\r?\n/)
                    .forEach((line) => {
                      const index = line.indexOf(":");
                      if (index > 0) {
                        const headerKey = line
                          .slice(0, index)
                          .trim()
                          .toLowerCase();
                        const headerValue = line.slice(index + 1).trim();
                        headersObj[headerKey] = headerValue;
                      }
                    });
                }

                const payload = {
                  key: key,
                  path: path,
                  status: this.status || 200,
                  headers: headersObj,
                  body: bytes,
                };
                putBet(key, payload);
                putBet(path, payload);
                dbg("[bet-mirror][xhr] capture", path);
                postBetCapture(payload);
              } catch (_x) {}
            },
            { once: true },
          );
        }
        return originalSend.call(this, body);
      };

      if (isBetReq(url, method)) {
        const replay = getBet(key) || getBet(path);
        if (replay && replay.body != null) {
          if (emitReplay(replay)) return;
        }
        if (MIRROR_SIDE === "right") {
          dbg(
            "[bet-mirror][xhr] hold",
            path,
            "key",
            key.slice(0, 10),
            "wait",
            RIGHT_BET_WAIT_MS,
          );
          waitAnyBet(key, path, RIGHT_BET_WAIT_MS)
            .then((hit) => {
              if (hit && hit.body != null) {
                if (emitReplay(hit)) return;
              }
              dbg("[bet-mirror][xhr] miss", path, "key", key.slice(0, 10));
              proceed();
            })
            .catch(() => {
              dbg("[bet-mirror][xhr] miss", path, "key", key.slice(0, 10));
              proceed();
            });
          return;
        }
      }
      return proceed();
    };
  }

  function pickTarget(element) {
    if (!element) return null;
    if (element.closest) {
      const candidate = element.closest(
        '.tp-toggle-btn,button,[role="button"],a,input[type="button"],input[type="submit"],label',
      );
      if (candidate) return candidate;
    }
    return element;
  }

  function buildPath(element) {
    try {
      if (!element?.tagName) return "";
      const parts = [];
      let current = element;

      while (current && current.nodeType === 1 && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`${tag}#${CSS.escape(current.id)}`);
          break;
        }

        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${tag}:nth-of-type(${index})`);
        current = current.parentElement;
      }

      parts.unshift("body");
      return parts.join(" > ");
    } catch (_x) {
      return "";
    }
  }

  const hintCache = new WeakMap();

  function hintOf(element) {
    if (!element) return null;
    element = pickTarget(element);
    if (!element) return null;
    const cached = hintCache.get(element);
    if (cached) return cached;

    const classes = [];
    if (element.classList) {
      for (let i = 0; i < element.classList.length; i += 1) {
        classes.push(element.classList[i]);
      }
    }

    // textContent doesn't trigger a layout/style flush (innerText does).
    // The text is only used as a stability hint for replay, so the raw
    // node text is equivalent for our purposes.
    const hint = {
      id: element.id || "",
      tag: element.tagName ? element.tagName.toLowerCase() : "",
      text: (element.textContent || "").trim().slice(0, 120),
      classes: classes,
      path: buildPath(element),
    };
    hintCache.set(element, hint);
    return hint;
  }

  function findByHint(hint) {
    try {
      if (!hint) return null;
      if (hint.id) {
        const byId = document.getElementById(hint.id);
        if (byId) return byId;
      }

      if (hint.path) {
        try {
          const byPath = document.querySelector(hint.path);
          if (byPath) return byPath;
        } catch (_x) {}
      }

      if (hint.classes?.length) {
        for (let i = 0; i < hint.classes.length; i += 1) {
          const cls = hint.classes[i];
          if (!cls) continue;
          const escaped =
            window.CSS && CSS.escape
              ? CSS.escape(cls)
              : String(cls).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
          const byClass = document.querySelector(`.${escaped}`);
          if (byClass) return byClass;
        }
      }

      if (hint.tag && hint.text) {
        const list = document.querySelectorAll(
          hint.tag +
            ',button,[role="button"],a,input[type="button"],input[type="submit"],label',
        );
        for (let i = 0; i < list.length; i += 1) {
          const text = (list[i].innerText || list[i].textContent || "")
            .trim()
            .slice(0, 120);
          if (text === hint.text) return list[i];
        }
      }
    } catch (_x) {
      return null;
    }
    return null;
  }

  ["click", "pointerdown", "pointerup"].forEach((type) => {
    document.addEventListener(
      type,
      (e) => {
        if (m) return;
        const vw = Math.max(
          1,
          window.innerWidth || document.documentElement.clientWidth || 1,
        );
        const vh = Math.max(
          1,
          window.innerHeight || document.documentElement.clientHeight || 1,
        );
        window.parent.postMessage(
          {
            __mirror: true,
            type: e.type,
            cx: e.clientX,
            cy: e.clientY,
            rx: e.clientX / vw,
            ry: e.clientY / vh,
            sx: e.screenX,
            sy: e.screenY,
            btn: e.button,
            btns: e.buttons,
            pid: e.pointerId,
            ptype: e.pointerType,
            pressure: e.pressure,
            h: hintOf(e.target),
            sentAt: Date.now(),
          },
          "*",
        );
      },
      true,
    );
  });

  // Coalesce wheel events into one postMessage per animation frame.
  // Native wheel handlers fire 60+ times/sec during a scroll gesture and
  // each postMessage round-trip to the parent + re-post to the sibling
  // iframe is not free.
  let wheelPending = null;
  let wheelRaf = 0;

  function flushWheel() {
    wheelRaf = 0;
    const buf = wheelPending;
    wheelPending = null;
    if (!buf) return;
    try {
      window.parent.postMessage(buf, "*");
    } catch (_x) {}
  }

  document.addEventListener(
    "wheel",
    (e) => {
      if (m) return;
      if (wheelPending && wheelPending.dm === e.deltaMode) {
        wheelPending.dx += e.deltaX;
        wheelPending.dy += e.deltaY;
        wheelPending.cx = e.clientX;
        wheelPending.cy = e.clientY;
        wheelPending.sentAt = Date.now();
      } else {
        if (wheelPending) {
          try {
            window.parent.postMessage(wheelPending, "*");
          } catch (_x) {}
        }
        wheelPending = {
          __mirrorWheel: true,
          dx: e.deltaX,
          dy: e.deltaY,
          dm: e.deltaMode,
          cx: e.clientX,
          cy: e.clientY,
          sentAt: Date.now(),
        };
      }
      if (!wheelRaf) {
        wheelRaf = requestAnimationFrame(flushWheel);
      }
    },
    { capture: true, passive: true },
  );

  ["keydown", "keyup", "keypress"].forEach((type) => {
    document.addEventListener(
      type,
      (e) => {
        if (m) return;
        if (MIRROR_SIDE === "right") {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        window.parent.postMessage(
          {
            __mirrorKey: true,
            type: type,
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            which: e.which,
            location: e.location,
            repeat: e.repeat,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            h: hintOf(document.activeElement || e.target),
            sentAt: Date.now(),
          },
          "*",
        );
      },
      true,
    );
  });

  ["input", "change"].forEach((type) => {
    document.addEventListener(
      type,
      (e) => {
        if (m) return;
        if (MIRROR_SIDE === "right") {
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        const element = e.target;
        if (!element) return;
        window.parent.postMessage(
          {
            __mirrorInput: true,
            eventType: type,
            h: hintOf(element),
            value: "value" in element ? element.value : null,
            checked: "checked" in element ? !!element.checked : null,
            inputType: element.type || "",
            sentAt: Date.now(),
          },
          "*",
        );
      },
      true,
    );
  });

  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (!data) return;

    if (data.__betCaptureReplay) {
      try {
        if (data.path) {
          const replayPayload = {
            key: String(data.key || ""),
            path: String(data.path),
            status: data.status || 200,
            headers: data.headers || {},
            body: data.body || null,
          };
          if (data.key) putBet(String(data.key), replayPayload);
          putBet(String(data.path), replayPayload);
          dbg(
            "[bet-mirror][relay] received",
            String(data.path),
            "key",
            String(data.key || "").slice(0, 10),
            "status",
            data.status || 200,
            "bytes",
            data.bodySize || data.body?.byteLength || 0,
          );
        }
      } catch (_x) {}
    }

    if (data.__mirrorReplay) {
      m = true;
      try {
        const targetW = Math.max(
          1,
          window.innerWidth || document.documentElement.clientWidth || 1,
        );
        const targetH = Math.max(
          1,
          window.innerHeight || document.documentElement.clientHeight || 1,
        );
        const px =
          typeof data.rx === "number" && Number.isFinite(data.rx)
            ? data.rx * targetW
            : data.cx;
        const py =
          typeof data.ry === "number" && Number.isFinite(data.ry)
            ? data.ry * targetH
            : data.cy;
        const hinted = data.type === "click" ? findByHint(data.h) : null;
        const element = hinted || document.elementFromPoint(px, py);

        if (element) {
          if (data.type === "click") {
            element.click();
          } else {
            const isPointer = data.type.indexOf("pointer") === 0;
            const EventCtor = isPointer ? PointerEvent : MouseEvent;
            const payload = {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: px,
              clientY: py,
              screenX: data.sx,
              screenY: data.sy,
              button: data.btn,
              buttons: data.btns,
              view: window,
            };
            if (isPointer) {
              payload.pointerId = data.pid != null ? data.pid : 1;
              payload.pointerType = data.ptype || "mouse";
              payload.isPrimary = true;
              payload.pressure = data.pressure || 0.5;
              payload.width = 1;
              payload.height = 1;
            }
            element.dispatchEvent(new EventCtor(data.type, payload));
          }
        }
      } catch (_x) {}
      m = false;
    }

    if (data.__mirrorWheelReplay) {
      m = true;
      try {
        let dx = data.dx;
        let dy = data.dy;
        if (data.dm === 1) {
          dx *= 40;
          dy *= 40;
        }
        if (data.dm === 2) {
          dx *= window.innerHeight;
          dy *= window.innerHeight;
        }

        let element = document.elementFromPoint(data.cx, data.cy);
        while (element && element !== document.documentElement) {
          const style = getComputedStyle(element);
          const canScrollY =
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            element.scrollHeight > element.clientHeight;
          const canScrollX =
            (style.overflowX === "auto" || style.overflowX === "scroll") &&
            element.scrollWidth > element.clientWidth;
          if (canScrollY || canScrollX) {
            element.scrollBy(dx, dy);
            m = false;
            return;
          }
          element = element.parentElement;
        }
        window.scrollBy(dx, dy);
      } catch (_x) {}
      m = false;
    }

    if (data.__mirrorKeyReplay) {
      m = true;
      try {
        const target =
          findByHint(data.h) ||
          document.activeElement ||
          document.body ||
          document;
        const keyboardEvent = new KeyboardEvent(data.type || "keydown", {
          key: data.key || "",
          code: data.code || "",
          location: data.location || 0,
          repeat: !!data.repeat,
          ctrlKey: !!data.ctrlKey,
          shiftKey: !!data.shiftKey,
          altKey: !!data.altKey,
          metaKey: !!data.metaKey,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        target.dispatchEvent(keyboardEvent);
      } catch (_x) {}
      m = false;
    }

    if (data.__mirrorInputReplay) {
      m = true;
      try {
        const inputElement = findByHint(data.h);
        if (
          inputElement &&
          ("value" in inputElement || "checked" in inputElement)
        ) {
          if (
            (data.inputType === "checkbox" || data.inputType === "radio") &&
            "checked" in inputElement
          ) {
            inputElement.checked = !!data.checked;
          } else if ("value" in inputElement && data.value != null) {
            inputElement.value = data.value;
          }

          inputElement.dispatchEvent(
            new Event(data.eventType === "change" ? "change" : "input", {
              bubbles: true,
              cancelable: false,
              composed: true,
            }),
          );
        }
      } catch (_x) {}
      m = false;
    }
  });
};

export const getPatchScript = () => `(${patchRuntime.toString()})();`;

export const getMirrorScript = (side) => {
  const safeSide = JSON.stringify(String(side || ""));
  return `(${mirrorRuntime.toString()})(${safeSide});`;
};
