import express from "express";
import compression from "compression";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import categoriesRouter from "./routes/categories.js";
import feedsRouter from "./routes/feeds.js";
import articlesRouter from "./routes/articles.js";
import refreshRouter from "./routes/refresh.js";
import importRouter from "./routes/import.js";
import { requireLoopbackHost } from "./requestGuards.js";
import { securityHeaders } from "./securityHeaders.js";
import { setStaticCacheHeaders } from "./staticCache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, "..", "..", "web", "dist");

const app = express();
// Don't advertise the framework/version in every response.
app.disable("x-powered-by");
const PORT = process.env.PORT || 3001;
// Loopback unless told otherwise. A container (Cloud Run) must set HOST=0.0.0.0 so the
// platform's proxy can reach it, and should then rely on that platform's auth (IAP).
const HOST = process.env.HOST || "127.0.0.1";

// Before anything else: only this machine may talk to this server. Binding to loopback
// isn't enough on its own — see requestGuards.js for how DNS rebinding gets around it.
app.use(requireLoopbackHost);
app.use(securityHeaders);
// gzip/brotli for everything (JSON and the built JS/CSS). GET /api/articles alone is
// several MB of repetitive JSON, which shrinks by roughly an order of magnitude — the
// difference between usable and painful on a phone's cellular connection.
app.use(compression());
// OPML import posts a whole subscription list as JSON — thousands of entries is
// realistic — which outgrows express.json()'s default 100 KB limit. It gets its own,
// larger limit and is mounted before the global parser below, which would otherwise
// reject the request first.
app.use("/api/import", express.json({ limit: "2mb" }), importRouter);
app.use(express.json());

app.use("/api/categories", categoriesRouter);
app.use("/api/feeds", feedsRouter);
app.use("/api/articles", articlesRouter);
app.use("/api/refresh", refreshRouter);

// Serves the built frontend (web/dist, from `npm run build` in web/) so the whole app
// can run as a single process/port instead of a separate Vite dev server — only kicks
// in when a build actually exists, so the normal two-process dev workflow (`npm run
// dev` in web/) is unaffected.
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { setHeaders: setStaticCacheHeaders }));
} else {
  console.log(
    `No built frontend found at ${WEB_DIST} — run "npm run build" in web/ to serve it from here, or run "npm run dev" in web/ separately for local development.`
  );
}

// Central error handler. Expected business-rule violations (ValidationError, or
// anything carrying an explicit .status) are reported with that status and their own
// message. Anything else is an unexpected fault: logged in full server-side, but the
// client only gets a generic 500 — internal error details are never leaked over HTTP.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
    return res.status(status).json({ error: "Internal server error" });
  }
  res.status(status).json({ error: err.message });
});

// Bound to loopback by default, not 0.0.0.0. This API has no authentication, so
// binding every interface would hand anyone else on the same network (coffee-shop
// Wi-Fi, office LAN) full read/write access — including feed deletion, which cascades
// to every saved article. Nothing but this machine's own browser needs to reach it.
// Hosted deployments override with HOST=0.0.0.0 behind an authenticating proxy.
app.listen(PORT, HOST, () => {
  console.log(`Feed proxy server listening on http://${HOST}:${PORT}`);
});
