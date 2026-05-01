# Live Website Comparison Notes

This document explains the main live-comparison behaviors used by the app.

## 1. Action mirroring between the two streams

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

The comparison setup keeps the right stream aligned with the left stream by replaying the same user actions in the same order and by replaying selected network activity that affects the page state.

The main pieces are:

- The left page is treated as the interaction source of truth.
- The right page receives the same mirrored events through the parent relay.
- Pointer coordinates are normalized before relay, so the replay still works if the two viewports differ slightly.
- When the app detects special bet-related requests, the left-side response is captured and made available to the right side for replay.
- The proxy layer injects the mirror runtime into both pages at load time, so both pages share the same event handling logic from the beginning.

This keeps the second stream moving through the same UI states as the first stream, which is what keeps the visual comparison meaningful.

## 3. How dynamic animations are excluded

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
