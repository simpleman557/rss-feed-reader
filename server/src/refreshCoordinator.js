// Coordinates "refresh all feeds" so overlapping or back-to-back requests don't each do
// the whole job — every refresh is a burst of database writes, and the hosted setup has
// two or more devices that each refresh on page load.
//
//  - Single flight: while a refresh is running, anyone else who asks gets that same
//    refresh's result instead of starting another.
//  - Recent-result reuse: if one finished less than `skipWindowMs` ago, return its result
//    without fetching anything. `force` skips this check (the Refresh button sets it, so a
//    deliberate click always fetches). State is in memory on purpose: a cold start should
//    refresh.
//  - A refresh that throws is not remembered, and doesn't leave the next caller waiting
//    on a dead promise.
//
// `run` does the actual work and resolves to the result object. `now` is injectable so
// tests don't depend on real time.
export const DEFAULT_SKIP_WINDOW_MS = 5 * 60 * 1000;

export function createRefreshCoordinator({ run, now = Date.now, skipWindowMs = DEFAULT_SKIP_WINDOW_MS }) {
  let inFlight = null;
  let last = null; // { result, finishedAt }

  return function refreshAll({ force = false } = {}) {
    if (inFlight) return inFlight;

    if (!force && last && now() - last.finishedAt < skipWindowMs) {
      return Promise.resolve({ ...last.result, skipped: true });
    }

    inFlight = (async () => {
      try {
        const result = await run();
        last = { result, finishedAt: now() };
        return result;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
