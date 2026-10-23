import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSnapshot } from "../src/snapshot.js";

const art = (id, read = false, saved = false) => ({ id, read, saved });

test("an article that arrives after the last baseline is recorded as it arrived", () => {
  const prev = new Map([["a", { read: false, saved: false }]]);
  const next = mergeSnapshot(prev, [art("a"), art("new")]);
  assert.deepEqual(next.get("new"), { read: false, saved: false });
});

test("an article that is no longer in the list is dropped, so the memory can't grow forever", () => {
  const prev = new Map([
    ["a", { read: false, saved: false }],
    ["gone", { read: false, saved: false }],
  ]);
  const next = mergeSnapshot(prev, [art("a")]);
  assert.equal(next.has("gone"), false);
  assert.equal(next.has("a"), true);
});

test("an article that arrives already read stays recorded as read, so it doesn't show up greyed out", () => {
  const next = mergeSnapshot(new Map(), [art("readElsewhere", true)]);
  assert.deepEqual(next.get("readElsewhere"), { read: true, saved: false });
});

test("an article that arrives saved is recorded as saved", () => {
  const next = mergeSnapshot(new Map(), [art("starred", false, true)]);
  assert.deepEqual(next.get("starred"), { read: false, saved: true });
});

test("an existing entry is never moved on by a silent refresh", () => {
  const prev = new Map([["a", { read: false, saved: true }]]);
  const next = mergeSnapshot(prev, [art("a", true, false)]);
  assert.deepEqual(next.get("a"), { read: false, saved: true });
});
