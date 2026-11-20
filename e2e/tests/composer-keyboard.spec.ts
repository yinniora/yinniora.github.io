import { test, expect, isMobileLayout, collapseScratchpad } from "../lib/test";
import { buildSession, realWorkingDir, uniqueSessionName, writeSession } from "../lib/sessions";

// Simulate the visual viewport resize from the iOS keyboard. This exercises
// the same event and sizing path as Safari and checks the dismissal control.

test.describe("composer stays above the keyboard (mobile)", () => {
  test("composer follows the visual viewport when the keyboard opens", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    // Chat must be available (cwd exists) so the composer textarea renders.
    const cwd = realWorkingDir();
    const { entries } = buildSession({ cwd });
    const name = uniqueSessionName(testInfo, "kbd");
    const id = writeSession(sessionsDir, name, entries);

    await collapseScratchpad(page);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);

    test.skip(!(await isMobileLayout(page)), "mobile-only behavior");

    const composer = page.locator("#pi-chat-composer");
    await expect(composer).toHaveAttribute("data-chat-available", "true");

    const textarea = page.locator("#pi-chat-message");
    await expect(textarea).toBeVisible();

    // At rest the textarea sits within the layout viewport.
    const innerHeight = await page.evaluate(() => window.innerHeight);
    const restBottom = (await textarea.boundingBox())!.y + (await textarea.boundingBox())!.height;
    expect(restBottom).toBeLessThanOrEqual(innerHeight + 1);

    const keyboard = 320;
    const reduced = innerHeight - keyboard;
    await textarea.focus();
    await page.evaluate((h) => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", { configurable: true, value: h });
      viewport.dispatchEvent(new Event("resize"));
    }, reduced);

    // The composer must now sit within the reduced (visible) area, not below it.
    // A few px of tolerance for borders/sub-pixel rounding.
    await expect
      .poll(async () => {
        const box = (await textarea.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(reduced + 4);
    await page.getByRole("button", { name: "Dismiss keyboard" }).click();
    await expect(textarea).not.toBeFocused();
  });
});
