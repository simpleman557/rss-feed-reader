import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRefreshCoordinator } from "../src/refreshCoordinator.js";

// A controllable clock and a run() whose completion the test decides.
function setup(skipWindowMs = 5 * 60 * 1000) {
  let time = 1_000_000;
  const calls = [];
  const coordinator = createRefreshCoordinator({
    now: () => time,
    skipWindowMs,
    run: () =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  });
  return {
    refreshAll: coordinator,
    calls,
    advance: (ms) => {
      time += ms;
    },
  };
}

describe("createRefreshCoordinator", () => {
  it("shares one running refresh between overlapping callers", async () => {
    const { refreshAll, calls } = setup();
    const a = refreshAll();
    const b = refreshAll();
    const c = refreshAll({ force: true }); // even a forced call joins the one in progress
    assert.equal(calls.length, 1);

    calls[0].resolve({ count: 3, errors: [] });
    const results = await Promise.all([a, b, c]);
    assert.deepEqual(results, [
      { count: 3, errors: [] },
      { count: 3, errors: [] },
      { count: 3, errors: [] },
    ]);
  });

  it("reuses a recent result without refreshing again, and says so", async () => {
    const { refreshAll, calls, advance } = setup();
    const first = refreshAll();
    calls[0].resolve({ count: 3, errors: [{ feed: { id: 1 }, error: "boom" }] });
    await first;

    advance(60_000);
    const again = await refreshAll();
    assert.equal(calls.length, 1);
    assert.deepEqual(again, { count: 3, errors: [{ feed: { id: 1 }, error: "boom" }], skipped: true });
  });

  it("refreshes again once the window has passed", async () => {
    const { refreshAll, calls, advance } = setup(5 * 60 * 1000);
    const first = refreshAll();
    calls[0].resolve({ count: 1, errors: [] });
    await first;

    advance(5 * 60 * 1000); // exactly at the window: no longer "recent"
    const second = refreshAll();
    assert.equal(calls.length, 2);
    calls[1].resolve({ count: 2, errors: [] });
    assert.deepEqual(await second, { count: 2, errors: [] });
  });

  it("force skips the recent-result check", async () => {
    const { refreshAll, calls, advance } = setup();
    const first = refreshAll();
    calls[0].resolve({ count: 1, errors: [] });
    await first;

    advance(1_000);
    const forced = refreshAll({ force: true });
    assert.equal(calls.length, 2);
    calls[1].resolve({ count: 1, errors: [] });
    assert.deepEqual(await forced, { count: 1, errors: [] });
  });

  it("doesn't remember a failed refresh, and the next call tries again", async () => {
    const { refreshAll, calls } = setup();
    const failing = refreshAll();
    calls[0].reject(new Error("db down"));
    await assert.rejects(failing, /db down/);

    const retry = refreshAll(); // not blocked by the dead one, not served a stale result
    assert.equal(calls.length, 2);
    calls[1].resolve({ count: 1, errors: [] });
    assert.deepEqual(await retry, { count: 1, errors: [] });
  });

  it("shares a failure with everyone waiting on that refresh", async () => {
    const { refreshAll, calls } = setup();
    const a = refreshAll();
    const b = refreshAll();
    calls[0].reject(new Error("db down"));
    await assert.rejects(a, /db down/);
    await assert.rejects(b, /db down/);
  });
});
