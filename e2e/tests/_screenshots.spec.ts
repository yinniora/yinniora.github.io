// One-shot screenshot capture for the chat queue + steer flow.
// Not part of the regular suite — opt in with `--grep "@screenshots"`.
// Saves PNGs into docs/screenshots/queue-and-steer/ for use in the README / PR.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, collapseScratchpad } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(__dirname, "../../docs/screenshots/queue-and-steer");

test.describe("@screenshots queue + steer panel @screenshots", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("captures queue + steer states @screenshots", async ({ page, sessionsDir }, testInfo) => {
    const cwd = realWorkingDir();
    const { entries } = buildSession({ cwd });
    const name = uniqueSessionName(testInfo, "shots");
    const id = writeSession(sessionsDir, name, entries);

    await collapseScratchpad(page);
    const sendModeKey = "pi-web:v1:chat-running-send-mode";
    // Keep the test's preference local even when the server sends its settings snapshot.
    await page.addInitScript((key) => {
      const mode = sessionStorage.getItem(key) ?? "steer";
      const storage = window.localStorage;
      const setItem = Storage.prototype.setItem;
      storage.setItem(key, mode);
      Storage.prototype.setItem = function (itemKey, value) {
        setItem.call(this, itemKey, this === storage && itemKey === key ? mode : value);
      };
    }, sendModeKey);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator("#pi-chat-composer")).toHaveAttribute("data-chat-available", "true");

    const textarea = page.locator("#pi-chat-message");
    const composer = page.locator("#pi-chat-composer");
    const send = page.locator("#pi-chat-send");

    // Hold the run open for a long time so the autonomous drainer can't pull
    // items out from under the screenshots.
    await textarea.fill("audit the cwd's tests and report findings [[slow:60000]]");
    await send.click();

    // ── 1. Steering actions before delivery ──────────────────────────────────
    await textarea.fill("focus on the integration tests first");
    await expect(send).toHaveAccessibleName("Steer");
    await send.click();
    await expect(page.locator(".pi-queue-item.pi-queue-item--steer")).toBeVisible();
    await composer.screenshot({
      path: path.join(SHOT_DIR, "01-steer-in-flight.png"),
      animations: "disabled",
    });
    await expect(page.locator("#messages .user-message").filter({
      hasText: "focus on the integration tests first",
    })).toBeVisible({ timeout: 10000 });

    // ── 2. Queue stacked with multiple items ─────────────────────────────────
    await page.evaluate((key) => sessionStorage.setItem(key, "queue"), sendModeKey);
    await page.reload();
    const queued = [
      "and don't forget the auth tests",
      "summarize at the end",
      "open a PR if anything is broken",
    ];
    for (let i = 0; i < queued.length; i++) {
      await textarea.fill(queued[i]);
      await expect(send).toHaveAccessibleName("Queue");
      await send.click();
      await expect(page.locator(".pi-queue-item:not(.pi-queue-item--steer)")).toHaveCount(i + 1);
    }
    await composer.screenshot({
      path: path.join(SHOT_DIR, "02-queue-stacked.png"),
      animations: "disabled",
    });

    // ── 3. Keyboard focus on a row + shortcut hints visible ──────────────────
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await composer.screenshot({
      path: path.join(SHOT_DIR, "03-keyboard-focused.png"),
      animations: "disabled",
    });

    // ── 4. Paused state ──────────────────────────────────────────────────────
    await page.getByRole("button", { name: /^Pause$/ }).click();
    await expect(page.locator(".pi-queue-panel--paused")).toBeVisible();
    await composer.screenshot({
      path: path.join(SHOT_DIR, "04-paused.png"),
      animations: "disabled",
    });
  });
});
