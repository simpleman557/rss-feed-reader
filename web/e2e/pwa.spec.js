import { test, expect } from "./fixtures";

// Home-screen install support (docs/adr/2026-10-10-iphone-pwa.md, IT-1). This can't prove
// that IAP lets the manifest through (there's no IAP here) — that's a manual check after
// deploy — only that the files exist, are linked correctly and are served as expected.

test("the page links a credentialed manifest and an apple-touch icon", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("crossorigin", "use-credentials");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
});

test("the manifest is valid, standalone, and every icon it lists is served as a PNG", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/json|manifest/);

  const manifest = await res.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.length).toBeGreaterThan(0);

  for (const icon of [...manifest.icons, { src: "/apple-touch-icon.png" }]) {
    const iconRes = await request.get(icon.src);
    expect(iconRes.status(), icon.src).toBe(200);
    expect(iconRes.headers()["content-type"], icon.src).toBe("image/png");
  }
});
