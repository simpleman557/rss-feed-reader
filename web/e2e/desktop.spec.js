import { test, expect, category, showAllFeeds } from "./fixtures";

// Mouse + wide screen: the sidebar is a fixed column, hovering a category reveals a
// pencil and a chevron right after its name, and clicking the name only selects it.

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

  test("clicking a category selects it without expanding it", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").click();
    await expect(news).toHaveClass(/active/);
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("clicking the empty part of the row selects it too, without expanding", async ({ page }) => {
    const news = category(page, "News");
    const box = await news.boundingBox();
    await news.click({ position: { x: box.width - 12, y: box.height / 2 } });
    await expect(news).toHaveClass(/active/);
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("pencil and chevron appear on hover, tight, in the order name, pencil, chevron", async ({ page }) => {
    const sports = category(page, "Sports");
    const pencil = sports.locator(".edit-category-btn");
    const chevron = sports.locator(".expand-btn");
    await expect(pencil).toHaveCSS("opacity", "0");
    await expect(chevron).toHaveCSS("opacity", "0");

    await sports.hover();
    await expect(pencil).toHaveCSS("opacity", "1");
    await expect(chevron).toHaveCSS("opacity", "1");

    const name = await sports.locator(".sidebar-item").boundingBox();
    const pen = await pencil.boundingBox();
    const chev = await chevron.boundingBox();
    expect(Math.abs(pen.x - (name.x + name.width))).toBeLessThanOrEqual(2);
    expect(Math.abs(chev.x - (pen.x + pen.width))).toBeLessThanOrEqual(2);
    expect(pen.width).toBeLessThanOrEqual(24);
    expect(chev.width).toBeLessThanOrEqual(24);
  });

  test("the chevron expands and collapses, even for a category that isn't selected", async ({ page }) => {
    const sports = category(page, "Sports");
    await sports.hover();
    const chevron = sports.locator(".expand-btn");
    await expect(chevron).toHaveAttribute("aria-expanded", "false");

    await chevron.click();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".feed-list .feed-item")).toHaveText(["NBA"]);
    await expect(sports).not.toHaveClass(/active/); // using the chevron doesn't select

    await chevron.click();
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("the pencil opens the editor without selecting or expanding", async ({ page }) => {
    const news = category(page, "News");
    await news.hover();
    await news.locator(".edit-category-btn").click();
    await expect(page.locator(".edit-category-form")).toBeVisible();
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("a feed's pencil appears on hover, right after its name, and opens its editor", async ({ page }) => {
    const news = category(page, "News");
    await news.hover();
    await news.locator(".expand-btn").click();
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
