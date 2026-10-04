import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  isLoopbackHostname,
  requireLoopbackHost,
  requireAppRequestHeader,
  APP_REQUEST_HEADER,
} from "../src/requestGuards.js";

// Driven through a real Express app on an ephemeral loopback port rather than hand-built
// req objects, so req.hostname is parsed by Express itself — the parsing (ports, IPv6
// brackets, X-Forwarded-Host) is the part that has to be right.
let server;
let port;

before(async () => {
  const app = express();
  app.use(requireLoopbackHost);
  app.get("/ok", (req, res) => res.json({ ok: true }));
  app.post("/refresh", requireAppRequestHeader, (req, res) => res.json({ refreshed: true }));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

function request({ method = "GET", path = "/ok", headers = {}, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, setHost }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("isLoopbackHostname", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) {
    it(`accepts ${host}`, () => assert.equal(isLoopbackHostname(host), true));
  }
  // Names an attacker controls, including ones built to look local.
  for (const host of [
    "attacker.example",
    "localhost.attacker.example",
    "127.0.0.1.nip.io",
    "notlocalhost",
    "",
    undefined,
  ]) {
    it(`rejects ${JSON.stringify(host)}`, () => assert.equal(isLoopbackHostname(host), false));
  }
});

describe("requireLoopbackHost", () => {
  it("allows a normal request to localhost", async () => {
    const res = await request({ headers: { host: `localhost:${port}` } });
    assert.equal(res.status, 200);
  });

  it("allows 127.0.0.1", async () => {
    const res = await request({ headers: { host: `127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
  });

  it("allows an IPv6 loopback literal", async () => {
    const res = await request({ headers: { host: `[::1]:${port}` } });
    assert.equal(res.status, 200);
  });

  // The dev proxy forwards a Host naming a different port; only the hostname matters.
  it("allows a loopback host on another port", async () => {
    const res = await request({ headers: { host: "localhost:5173" } });
    assert.equal(res.status, 200);
  });

  it("rejects a rebound attacker hostname", async () => {
    const res = await request({ headers: { host: `attacker-rebind.example:${port}` } });
    assert.equal(res.status, 403);
  });

  it("rejects a hostname merely containing 'localhost'", async () => {
    const res = await request({ headers: { host: `localhost.attacker.example:${port}` } });
    assert.equal(res.status, 403);
  });

  it("can't be talked past with X-Forwarded-Host", async () => {
    const res = await request({
      headers: { host: `attacker-rebind.example:${port}`, "x-forwarded-host": `localhost:${port}` },
    });
    assert.equal(res.status, 403);
  });

  it("refuses a request with no Host header at all", async () => {
    const res = await request({ setHost: false });
    assert.notEqual(res.status, 200);
  });
});

describe("requireLoopbackHost with ALLOWED_HOSTS", () => {
  const prior = process.env.ALLOWED_HOSTS;
  after(() => {
    if (prior === undefined) delete process.env.ALLOWED_HOSTS;
    else process.env.ALLOWED_HOSTS = prior;
  });

  it("accepts a listed hostname and still rejects others", async () => {
    process.env.ALLOWED_HOSTS = "feeds.example.run.app, other.example";
    assert.equal((await request({ headers: { host: "feeds.example.run.app" } })).status, 200);
    assert.equal((await request({ headers: { host: "OTHER.example:443" } })).status, 200);
    assert.equal((await request({ headers: { host: "attacker.example" } })).status, 403);
  });

  it("accepts any host only for an explicit *", async () => {
    process.env.ALLOWED_HOSTS = "*";
    assert.equal((await request({ headers: { host: "anything.example" } })).status, 200);
  });

  it("is loopback-only again when unset or empty", async () => {
    process.env.ALLOWED_HOSTS = "";
    assert.equal((await request({ headers: { host: "feeds.example.run.app" } })).status, 403);
    delete process.env.ALLOWED_HOSTS;
    assert.equal((await request({ headers: { host: "feeds.example.run.app" } })).status, 403);
  });
});

describe("requireAppRequestHeader", () => {
  it("rejects a bodyless cross-site POST", async () => {
    const res = await request({ method: "POST", path: "/refresh", headers: { host: `localhost:${port}` } });
    assert.equal(res.status, 403);
  });

  it("accepts the app's own request", async () => {
    const res = await request({
      method: "POST",
      path: "/refresh",
      headers: { host: `localhost:${port}`, [APP_REQUEST_HEADER]: "1" },
    });
    assert.equal(res.status, 200);
  });

  it("rejects a wrong header value", async () => {
    const res = await request({
      method: "POST",
      path: "/refresh",
      headers: { host: `localhost:${port}`, [APP_REQUEST_HEADER]: "0" },
    });
    assert.equal(res.status, 403);
  });

  it("checks the Host first, so a rebound page can't refresh either", async () => {
    const res = await request({
      method: "POST",
      path: "/refresh",
      headers: { host: `attacker-rebind.example:${port}`, [APP_REQUEST_HEADER]: "1" },
    });
    assert.equal(res.status, 403);
  });
});
