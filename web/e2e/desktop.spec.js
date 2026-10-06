import { test, expect, category, showAllFeeds } from "./fixtures";

// Mouse + wide screen: the sidebar is a fixed column, hover reveals the pencil, and
// clicking a category's name selects it and expands/collapses it (there's no chevron).

test.describe("desktop sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".category-header").first()).toBeVisible();
  });

  test("is always visible, with no menu button", async ({ page }) => {
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
  });

  test("clicking a category selects it and toggles its feeds", async ({ page }) => {
    const news = category(page, "News");
    await expect(page.locator(".feed-list")).toHaveCount(0);

    await news.locator(".sidebar-item").click();
    await expect(news).toHaveClass(/active/);
    await expect(page.locator(".feed-list .feed-item")).toHaveText(["BBC", "New York Times"]);

    await news.locator(".sidebar-item").click();
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("clicking the empty part of the row works too, and there is no chevron", async ({ page }) => {
    const news = category(page, "News");
    const box = await news.boundingBox();
    await news.click({ position: { x: box.width - 12, y: box.height / 2 } });
    await expect(news).toHaveClass(/active/);
    await expect(page.locator(".feed-list .feed-item")).toHaveCount(2);
    await expect(page.locator(".expand-btn").first()).toBeHidden();
  });

  test("the pencil appears on hover, right after the name", async ({ page }) => {
    const sports = category(page, "Sports");
    const pencil = sports.locator(".edit-category-btn");
    await expect(pencil).toHaveCSS("opacity", "0");

    await sports.hover();
    await expect(pencil).toHaveCSS("opacity", "1");

    const name = await sports.locator(".sidebar-item").boundingBox();
    const pen = await pencil.boundingBox();
    expect(pen.x - (name.x + name.width)).toBeLessThanOrEqual(2);
  });

  test("the pencil opens the editor without expanding or collapsing", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").click();
    await expect(page.locator(".feed-list .feed-item")).toHaveCount(2);

    await news.hover();
    await news.locator(".edit-category-btn").click();
    await expect(page.locator(".edit-category-form")).toBeVisible();
    await expect(page.locator(".feed-list .feed-item")).toHaveCount(2);
  });

  test("a feed's pencil appears on hover, right after its name, and opens its editor", async ({ page }) => {
    await category(page, "News").locator(".sidebar-item").click();
    const row = page.locator(".feed-row").filter({ hasText: "BBC" });
    const pencil = row.locator(".edit-feed-btn");
    await expect(pencil).toHaveCSS("opacity", "0");

    await row.hover();
    await expect(pencil).toHaveCSS("opacity", "1");
    const name = await row.locator(".feed-item").boundingBox();
    const pen = await pencil.boundingBox();
    expect(pen.x - (name.x + name.width)).toBeLessThanOrEqual(2);

    await pencil.click();
    await expect(page.locator(".edit-feed-form")).toBeVisible();
  });
});

test.describe("desktop article list", () => {
  test("rows are the compact single-line layout", async ({ page }) => {
    await showAllFeeds(page);
    const row = page.locator(".article-item").first();
    await expect(row).toHaveCSS("display", "flex");
    await expect(row.locator(".article-snippet")).toBeVisible();
    await expect(row.locator(".article-title")).toHaveCSS("white-space", "nowrap");
    const { height } = await row.boundingBox();
    expect(height).toBeLessThan(70);
  });
});
