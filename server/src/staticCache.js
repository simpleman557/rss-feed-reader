// Cache-Control for the built frontend (web/dist). Vite content-hashes everything under
// /assets/, so those files can be cached "forever" — a new build means new filenames.
// Everything else (index.html, theme-init.js) keeps a stable name and must be revalidated,
// or a deploy wouldn't reach anyone until their cache expired.
//
// `private`, not `public`: the whole service sits behind IAP, and a shared cache
// shouldn't hold a copy of anything an authenticated request fetched.
export function setStaticCacheHeaders(res, filePath) {
  const normalized = filePath.split("\\").join("/");
  if (normalized.includes("/assets/")) {
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}
