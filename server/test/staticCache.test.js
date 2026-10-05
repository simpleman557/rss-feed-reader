import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import express from "express";
import compression from "compression";
import { setStaticCacheHeaders } from "../src/staticCache.js";

let server;
let port;
const bigJson = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, title: "same title ".repeat(8) })));

before(async () => {
  const app = express();
  app.use(compression());
  app.get("/big", (req, res) => res.type("json").send(bigJson));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

function get(path, headers) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

describe("response compression", () => {
  it("gzips a large JSON response when the client accepts it", async () => {
    const { headers, body } = await get("/big", { "Accept-Encoding": "gzip" });
    assert.equal(headers["content-encoding"], "gzip");
    assert.ok(body.length < bigJson.length / 5);
    assert.equal(zlib.gunzipSync(body).toString(), bigJson);
  });

  it("sends it as-is when the client doesn't accept compression", async () => {
    const { headers, body } = await get("/big", { "Accept-Encoding": "identity" });
    assert.equal(headers["content-encoding"], undefined);
    assert.equal(body.toString(), bigJson);
  });
});

describe("setStaticCacheHeaders", () => {
  function headerFor(filePath) {
    const set = {};
    setStaticCacheHeaders({ setHeader: (k, v) => (set[k] = v) }, filePath);
    return set["Cache-Control"];
  }

  it("caches content-hashed assets as immutable, privately", () => {
    const h = headerFor("/app/web/dist/assets/index-PPt7W0lv.js");
    assert.match(h, /^private/);
    assert.match(h, /max-age=31536000/);
    assert.match(h, /immutable/);
  });

  it("makes unhashed files revalidate", () => {
    assert.equal(headerFor("/app/web/dist/index.html"), "no-cache");
    assert.equal(headerFor("/app/web/dist/theme-init.js"), "no-cache");
  });

  it("recognises assets under Windows-style separators", () => {
    assert.match(headerFor("C:\\app\\web\\dist\\assets\\index-abc.css"), /immutable/);
  });
});
