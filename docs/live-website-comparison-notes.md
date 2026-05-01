# Live Website Comparison Notes

This document explains the main live-comparison behaviors used by the app.

## 1. Action mirroring between the two streams

Implemented in [live-server.js], [injected-scripts.js], and [LiveWebsiteCompare.jsx]

The backend injects a mirror script into both proxied pages. Each iframe runs the same runtime, but only the left side acts as the source of user events.

How it works:

- The active page listens for native `click`, `pointerdown`, `pointerup`, `wheel`, `keydown`, `keyup`, `keypress`, `input`, and `change` events.
- Those events are converted into compact messages and sent to the parent window with `postMessage`.
- The parent relays the message to the sibling iframe.
- The sibling iframe receives a replay message and dispatches a matching synthetic event on the closest target element.
- Wheel events are coalesced into a single message per animation frame so scrolling stays responsive and does not flood the relay.
- Input and key events use a small element hint so the replay can target the same control even if coordinates are not enough.

The right stream does not re-broadcast mirrored key and input events back to the parent, which prevents feedback loops.

## 2. How the second stream stays synced with the first

Implemented in [live-server.js], [injected-scripts.js] and [LiveWebsiteCompare.jsx]

The comparison setup keeps the right stream aligned with the left stream by replaying the same user actions in the same order and by replaying selected network activity that affects the page state.

The main pieces are:

- The left page is treated as the interaction source of truth.
- The right page receives the same mirrored events through the parent relay.
- Pointer coordinates are normalized before relay, so the replay still works if the two viewports differ slightly.
- When the app detects special bet-related requests, the left-side response is captured and made available to the right side for replay.
- The proxy layer injects the mirror runtime into both pages at load time, so both pages share the same event handling logic from the beginning.

This keeps the second stream moving through the same UI states as the first stream, which is what keeps the visual comparison meaningful.

## 3. How dynamic animations are excluded

Implemented in [diffWorker.js] and surfaced through [LiveWebsiteCompare.jsx]

The diff worker can ignore pixels that appear to belong to moving or animated content.

The detection logic is based on per-pixel luma change over time:

- For every sampled pixel, the worker computes the current luma for the left and right frames.
- It keeps the previous frame luma for both sides, plus a second previous frame buffer.
- A pixel is considered dynamic when the current luma differs from either side's previous luma by more than the motion threshold.
- The motion threshold is currently `0.08` in normalized luma space.
- When `excludeDynamicAnimations` is enabled, dynamic pixels are skipped and do not contribute to the mismatch count.

Why the worker can identify animations:

- Static content tends to stay close to the previous frame luma at the same pixel.
- Animated or moving content changes rapidly between frames, which pushes the luma delta above the threshold.
- The worker also keeps one-frame and two-frame sync-compensated comparisons, so small timing offsets between the two streams do not immediately count as mismatches.

The worker reports how many pixels were skipped via `dynamicSkipped`, which helps confirm how much animation was excluded during a diff run.

## 4. How network intercept and replay work

Implemented in [live-server.js] and [injected-scripts.js], and [LiveWebsiteCompare.jsx].

The live backend and injected runtime capture special request/response pairs so the right stream can reuse the left stream's network results when needed.

How it works:

- The proxy identifies bet-related requests by path or request body and stores the left-side response payload in session state.
- The injected runtime patches both `fetch` and `XMLHttpRequest` so matching right-side requests can replay a captured response instead of issuing a fresh network call.
- The left iframe posts captured payloads back to the parent window with a `__betCapture` marker.
- The parent relays that capture to the right iframe so both sides stay aligned on network-dependent UI state.
- Replay is time-bounded so stale responses do not linger in the cache.

This behavior is what keeps network-driven screens, especially bet flows, comparable when the two sites would otherwise diverge on timing or side effects.
