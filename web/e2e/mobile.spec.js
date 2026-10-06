import { test, expect, category, openSidebar, showAllFeeds } from "./fixtures";

// Touch + phone width: the sidebar is a drawer, a tap on a category only selects it, and
// the selected row shows a pencil and a chevron right after the name.

const drawer = (page) => page.locator("#sidebar");
const isOpen = (page) => expect(drawer(page)).toHaveClass(/open/);
const isClosed = async (page) => {
  await expect(drawer(page)).not.toHaveClass(/open/);
  // Closed means out of the accessibility tree and tab order, not just off-screen.
  await expect(drawer(page)).toBeHidden();
};

test.describe("phone drawer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".article-item, .empty-state").first()).toBeVisible();
  });

  test("starts closed with articles on screen, on a no-hover device", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await isClosed(page);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    const viewportHeight = page.viewportSize().height;
    const box = await page.locator(".article-item").first().boundingBox();
    expect(box.y + box.height).toBeLessThan(viewportHeight);
  });

  test("closes on the backdrop, on Escape, and on the close button", async ({ page }) => {
    await openSidebar(page);
    await page.locator(".drawer-backdrop").click({ position: { x: 380, y: 400 } });
    await isClosed(page);

    await openSidebar(page);
    await page.keyboard.press("Escape");
    await isClosed(page);

    await openSidebar(page);
    await page.getByRole("button", { name: "Close menu" }).click();
    await isClosed(page);
  });

  test("choosing a destination closes it, even the one already selected", async ({ page }) => {
    await openSidebar(page);
    await page.getByRole("button", { name: /^Today/ }).click(); // Today is the default view
    await isClosed(page);

    await openSidebar(page);
    await page.locator("#sidebar .all-item").click();
    await isClosed(page);
  });
});

test.describe("phone category rows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openSidebar(page);
  });

  test("tapping a category selects it only: no expanding, drawer stays open", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").tap();
    await expect(news).toHaveClass(/active/);
    await expect(page.locator(".feed-list")).toHaveCount(0);
    await isOpen(page);
  });

  test("only the selected category shows a pencil and a chevron", async ({ page }) => {
    await category(page, "News").locator(".sidebar-item").tap();
    await expect(category(page, "News").locator(".edit-category-btn")).toBeVisible();
    await expect(category(page, "News").locator(".expand-btn")).toBeVisible();
    await expect(category(page, "Sports").locator(".edit-category-btn")).toBeHidden();
    await expect(category(page, "Sports").locator(".expand-btn")).toBeHidden();
  });

  test("pencil and chevron are thumb-tall, narrow, and touch each other and the name", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").tap();
    const name = await news.locator(".sidebar-item").boundingBox();
    const pen = await news.locator(".edit-category-btn").boundingBox();
    const chev = await news.locator(".expand-btn").boundingBox();
    expect(pen.height).toBeGreaterThanOrEqual(44);
    expect(chev.height).toBeGreaterThanOrEqual(44);
    expect(pen.width).toBeLessThanOrEqual(24);
    expect(chev.width).toBeLessThanOrEqual(24);
    expect(Math.abs(pen.x - (name.x + name.width))).toBeLessThanOrEqual(2);
    expect(Math.abs(chev.x - (pen.x + pen.width))).toBeLessThanOrEqual(2);
  });

  test("the chevron expands and collapses the selected category", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").tap();
    const chevron = news.locator(".expand-btn");
    await expect(chevron).toHaveAttribute("aria-expanded", "false");

    await chevron.tap();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".feed-list .feed-item")).toHaveText(["BBC", "New York Times"]);
    await expect(news).toHaveClass(/active/);

    await chevron.tap();
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("the pencil opens the editor without selecting or expanding anything else", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").tap();
    await news.locator(".edit-category-btn").tap();
    await expect(page.locator(".edit-category-form")).toBeVisible();
    await expect(page.locator(".feed-list")).toHaveCount(0);
  });

  test("tapping a feed closes the drawer; only the selected feed shows a pencil", async ({ page }) => {
    const news = category(page, "News");
    await news.locator(".sidebar-item").tap();
    await news.locator(".expand-btn").tap();
    await page.locator(".feed-item", { hasText: "BBC" }).tap();
    await isClosed(page);

    await openSidebar(page);
    await expect(page.locator(".feed-row.active .edit-feed-btn")).toBeVisible();
    await expect(page.locator(".feed-row", { hasText: "New York Times" }).locator(".edit-feed-btn")).toBeHidden();
  });
});

test.describe("phone article list", () => {
  test("rows are the compact stack: no snippet, title over feed and time, big star", async ({ page }) => {
    await showAllFeeds(page);
    const row = page.locator(".article-item").first();
    await expect(row.locator(".article-snippet")).toBeHidden();
    await expect(row.locator(".article-feed")).toBeVisible();
    await expect(row.locator(".article-date")).toBeVisible();
    const star = await row.locator(".save-btn").boundingBox();
    expect(star.width).toBeGreaterThanOrEqual(44);
    expect(star.height).toBeGreaterThanOrEqual(44);
    const { height } = await row.boundingBox();
    expect(height).toBeLessThan(100);
  });

  test("tapping anywhere on a row opens the article and marks it read", async ({ page }) => {
    await showAllFeeds(page);
    const row = page.locator(".article-item.unread").first();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      // A tap on the icon's spot (not the title text): the row's link overlays the whole row.
      row.tap({ position: { x: 24, y: 24 } }),
    ]);
    await popup.close();
    await expect(row).toHaveClass(/read/);
  });

  test("tapping the star saves without opening the article", async ({ page }) => {
    await showAllFeeds(page);
    let opened = false;
    page.on("popup", () => (opened = true));
    const row = page.locator(".article-item.unread").first();
    const star = row.locator(".save-btn");
    await star.tap();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    expect(opened).toBe(false);
    await star.tap(); // leave the shared database as we found it
    await expect(star).toHaveAttribute("aria-pressed", "false");
  });
});
