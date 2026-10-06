import { test, expect, category, openSidebar, showAllFeeds } from "./fixtures";

// Behavior that must hold on both desktop and phone (this file runs in both projects).

test("loads without script errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".article-item, .empty-state").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("Customization card", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openSidebar(page);
  });

  test("Add feed asks for a category and defaults to the selected one", async ({ page }) => {
    await category(page, "Sports").locator(".sidebar-item").click();
    await page.getByRole("button", { name: "Add feed" }).click();
    await expect(page.locator("#new-feed-url")).toBeVisible();
    await expect(page.locator("#new-feed-category option:checked")).toHaveText("Sports");
    // Other tests add categories to the shared database, so check for ours, not an exact list.
    const options = await page.locator("#new-feed-category option").allTextContents();
    expect(options).toEqual(expect.arrayContaining(["News", "Sports", "Tech"]));
  });

  test("Add category / Add feed highlight while their form is open, and swap", async ({ page }) => {
    const addCategory = page.getByRole("button", { name: "Add category" });
    const addFeed = page.getByRole("button", { name: "Add feed" });

    await addCategory.click();
    await expect(addCategory).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#new-category-name")).toBeVisible();

    await addFeed.click();
    await expect(addFeed).toHaveAttribute("aria-expanded", "true");
    await expect(addCategory).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#new-category-name")).toHaveCount(0);

    await addFeed.click();
    await expect(page.locator(".customize-form")).toHaveCount(0);
  });

  test("Add category adds it to the list", async ({ page }) => {
    const name = `Zz e2e ${Date.now()}`;
    await page.getByRole("button", { name: "Add category" }).click();
    await page.locator("#new-category-name").fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(category(page, name)).toBeVisible();
    await expect(page.locator(".customize-form")).toHaveCount(0);
  });

  test("the four buttons match the appearance control's style and size", async ({ page }) => {
    const theme = page.locator(".theme-option").first();
    const themeBox = await theme.boundingBox();
    for (const label of ["Add category", "Add feed", "Import OPML", "Export OPML"]) {
      const button = page.getByRole("button", { name: label });
      await expect(button).toHaveCSS("border-radius", "6px");
      await expect(button).toHaveCSS("font-weight", "600");
      await expect(button).toHaveCSS("font-size", await theme.evaluate((e) => getComputedStyle(e).fontSize));
      expect((await button.boundingBox()).height).toBeCloseTo(themeBox.height, 0);
    }
  });

  test("forcing Light or Dark updates the browser-bar color, and System restores it", async ({ page }) => {
    const colors = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content)
      );
    await page.getByRole("button", { name: "Dark" }).click();
    expect(await colors()).toEqual(["#0a0c11", "#0a0c11"]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByRole("button", { name: "Light" }).click();
    expect(await colors()).toEqual(["#f7f8fa", "#f7f8fa"]);

    await page.getByRole("button", { name: "System" }).click();
    expect(await colors()).toEqual(["#f7f8fa", "#0a0c11"]);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });
});

test.describe("article list", () => {
  test("renders 100 rows at first and grows on 'Show more'", async ({ page }) => {
    await showAllFeeds(page);
    await expect(page.locator(".article-item")).toHaveCount(100);
    const more = page.getByRole("button", { name: /^Show more/ });
    await expect(more).toBeVisible();

    await more.scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator(".article-item").count()).toBeGreaterThan(100);
  });

  test("images load lazily and rows show feed icons, not article photos", async ({ page }) => {
    await showAllFeeds(page);
    const img = page.locator(".article-item img").first();
    await expect(img).toHaveAttribute("loading", "lazy");
    await expect(page.locator(".article-image--photo")).toHaveCount(0);
  });
});
