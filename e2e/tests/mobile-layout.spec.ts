import { test, expect, isMobileLayout, collapseScratchpad } from "../lib/test";
import type { Page } from "@playwright/test";

// Layout is driven by the 900px breakpoint, not by device type: iPad portrait
// (810px) lands on mobile, iPad landscape (~1080px) on desktop. Each test
// resolves the active layout at runtime (after navigation) and skips the half
// that doesn't apply, so every project runs exactly the relevant assertions.

async function openDemoSession(page: Page) {
  // Keep the scratchpad collapsed so it doesn't overlay the header on narrow
  // viewports; we're exercising the tree (left) sidebar.
  await collapseScratchpad(page);
  await page.goto("/");
  await page
    .locator(".session-card", { hasText: "add deepseek-v4-pro" })
    .click();
  await expect(page).toHaveURL(/\/session\?id=/);
  await page.locator("#sidebar").waitFor({ state: "attached" });
}

test.describe("responsive layout", () => {
  test("mobile: returns to the workspace instead of opening a redundant sidebar", async ({
    page,
  }) => {
    await openDemoSession(page);
    test.skip(!(await isMobileLayout(page)), "mobile-only behavior");
    await expect(page.locator("#tree-toggle")).toBeHidden();
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator(".session-header-back")).toBeVisible();
    await expect(page.locator("#new-session-header-btn")).toBeHidden();
    await expect(page.locator(".session-device-button")).toBeHidden();
    await page.locator(".session-header-back").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".mobile-home")).toBeVisible();
    await expect(page.locator(".personal-start-box")).toHaveCount(0);
  });

  test("desktop: tree sidebar is persistent and collapses in place", async ({
    page,
  }) => {
    await openDemoSession(page);
    test.skip(await isMobileLayout(page), "desktop-only behavior");

    const body = page.locator("body");
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(body).not.toHaveClass(/sidebar-open/);

    // On desktop the toggle collapses the sidebar in place (no overlay drawer).
    await page.locator("#tree-toggle").click();
    await expect(body).toHaveClass(/sidebar-collapsed/);
    await expect(body).not.toHaveClass(/sidebar-open/);
  });
});
