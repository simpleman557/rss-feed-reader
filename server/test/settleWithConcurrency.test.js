import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settleWithConcurrency } from "../src/settleWithConcurrency.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("settleWithConcurrency", () => {
  it("returns allSettled-shaped results in input order, whatever order they finish in", async () => {
    const results = await settleWithConcurrency([30, 5, 15], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    assert.deepEqual(results, [
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 5 },
      { status: "fulfilled", value: 15 },
    ]);
  });

  it("captures a rejection without stopping the others", async () => {
    const boom = new Error("boom");
    const results = await settleWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw boom;
      return n;
    });
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal(results[1].reason, boom);
  });

  it("never runs more than `limit` calls at once, but does use the full limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await settleWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    assert.equal(peak, 4);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    assert.deepEqual(await settleWithConcurrency([], 5, async () => 1), []);
    const results = await settleWithConcurrency([1, 2], 50, async (n) => n * 2);
    assert.deepEqual(results.map((r) => r.value), [2, 4]);
  });

  it("passes the item's index to the callback", async () => {
    const results = await settleWithConcurrency(["a", "b"], 2, async (item, i) => `${item}${i}`);
    assert.deepEqual(results.map((r) => r.value), ["a0", "b1"]);
  });
});
