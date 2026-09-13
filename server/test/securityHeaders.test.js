import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { securityHeaders } from "../src/securityHeaders.js";

// Exercised through a real Express app so header casing and delivery match production.
let server;
let port;

before(async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.get("/page", (req, res) => res.send("<!doctype html><title>x</title>"));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

function get(path = "/page") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("securityHeaders", () => {
  it("forbids framing (clickjacking)", async () => {
    const h = await get();
    assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(h["x-frame-options"], "DENY");
  });

  it("restricts scripts, styles and connections to self", async () => {
    const csp = (await get())["content-security-policy"];
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /default-src 'self'/);
    // No inline-script escape hatch — that's the whole reason the theme script was moved out.
    assert.doesNotMatch(csp, /'unsafe-inline'/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
  });

  it("still allows images from anywhere plus data: (feed icons, placeholder)", async () => {
    const csp = (await get())["content-security-policy"];
    assert.match(csp, /img-src[^;]*\bdata:/);
    assert.match(csp, /img-src[^;]*\bhttps:/);
  });

  it("sets nosniff and a no-referrer policy", async () => {
    const h = await get();
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.equal(h["referrer-policy"], "no-referrer");
  });

  it("does not advertise the framework", async () => {
    const h = await get();
    assert.equal(h["x-powered-by"], undefined);
  });
});
