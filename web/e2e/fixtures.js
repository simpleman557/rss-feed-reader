import { test as base, expect } from "@playwright/test";

// Every test gets a page that can't reach the outside world and can't refresh feeds. The
// app refreshes all feeds on every load, which would otherwise hit the network (and fail,
// since the seeded feed URLs don't exist).
export const test = base.extend({
  // (The second argument is Playwright's "use" callback; renamed so the React-hooks lint rule
  // doesn't mistake it for a hook.)
  page: async ({ page, context }, provide) => {
    await context.route(
      (url) => !["127.0.0.1", "localhost"].includes(url.hostname),
      (route) => route.abort()
    );
    await page.route("**/api/refresh", (route) => route.fulfill({ json: { count: 0, errors: [] } }));
    await page.route("**/api/feeds/*/refresh", (route) => route.fulfill({ json: {} }));
    await provide(page);
  },
});

export { expect };

// Phone layouts keep the sidebar in a drawer; open it before touching anything in it.
// A no-op on desktop, where the sidebar is always visible.
export async function openSidebar(page) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) {
    await menu.click();
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
  }
}

export function category(page, name) {
  return page.locator(".category-header").filter({ hasText: name });
}

export async function showAllFeeds(page) {
  await page.goto("/");
  await openSidebar(page);
  await page.locator("#sidebar .all-item").click();
  await expect(page.locator(".article-item").first()).toBeVisible();
}
