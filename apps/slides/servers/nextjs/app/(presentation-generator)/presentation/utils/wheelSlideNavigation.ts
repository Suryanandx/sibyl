// Match the editor's trackpad gesture handling in presenton-nextjs.
const GESTURE_GAP_MS = 100;
const RESTART_DELAY_MS = 60;
const RESTART_ACCELERATION = 1.5;
const RESTART_MIN_DELTA = 4;

export function createWheelNavigationState() {
  return {
    decelerating: false,
    direction: 0,
    lastDelta: 0,
    lastEventAt: 0,
    lastNavigationAt: 0,
    navigatedInGesture: false,
    peakDelta: 0,
  };
}

/** Consume one vertical gesture without letting its momentum skip slides. */
export function consumeWheelNavigation(
  state: ReturnType<typeof createWheelNavigationState>,
  event: Pick<WheelEvent, "deltaX" | "deltaY">,
  now: number,
): -1 | 0 | 1 {
  const delta = Math.abs(event.deltaY);
  if (delta < 1 || delta <= Math.abs(event.deltaX)) return 0;

  const direction = event.deltaY > 0 ? 1 : -1;
  const isNewGesture = now - state.lastEventAt > GESTURE_GAP_MS;
  const directionChanged =
    state.direction !== 0 &&
    state.direction !== direction &&
    delta >= RESTART_MIN_DELTA;
  const acceleratedAfterDeceleration =
    state.decelerating &&
    delta >= RESTART_MIN_DELTA &&
    delta >= state.lastDelta * RESTART_ACCELERATION;
  const restartedDuringMomentum =
    state.navigatedInGesture &&
    now - state.lastNavigationAt >= RESTART_DELAY_MS &&
    (directionChanged || acceleratedAfterDeceleration);

  if (isNewGesture || restartedDuringMomentum) {
    state.navigatedInGesture = false;
    state.decelerating = false;
    state.peakDelta = delta;
  } else if (
    delta < state.lastDelta * 0.85 ||
    delta < state.peakDelta * 0.65
  ) {
    state.decelerating = true;
  }

  state.direction = direction;
  state.lastDelta = delta;
  state.lastEventAt = now;
  state.peakDelta = Math.max(state.peakDelta, delta);

  if (state.navigatedInGesture) return 0;
  state.navigatedInGesture = true;
  state.lastNavigationAt = now;
  return direction;
}
