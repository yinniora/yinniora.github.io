import { test, expect, collapseScratchpad } from "../lib/test";
import { buildSession, realWorkingDir, uniqueSessionName, writeSession } from "../lib/sessions";
import { remoteEventSource } from "../../web/src/remote/event-source.js";

test("thinking and two reply chunks are visible before completion", async ({ page, sessionsDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, "streaming"), buildSession({ cwd: realWorkingDir() }).entries);
  await collapseScratchpad(page);
  if (info.project.name === "Mobile Safari") {
    // Use the same stream parser as the published iPhone client.
    await page.addInitScript({
      content: `window.EventSource = (${remoteEventSource.toString()})({ fetch: window.fetch.bind(window) });`,
    });
  }
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.locator("#pi-chat-message").fill("[[hold-stream]]");
  await page.locator("#pi-chat-send").click();
  const preview = page.locator("#chat-preview-stream");
  const answer = preview.locator(".message-content");
  await expect(preview.locator(".preview-progress")).toBeVisible();

  const step = async (message: string) => {
    const status = await page.evaluate(async ({ id, message }) => {
      const body = new FormData();
      body.set("message", message);
      return (await fetch("/api/chat?id=" + encodeURIComponent(id), { method: "POST", body })).status;
    }, { id, message });
    expect(status).toBe(202);
  };
  await step("[[preview-thinking]]");
  await expect(preview.locator(".activity-thinking-text")).toHaveText("Fixture thinking before reconnect.");
  await expect(preview.locator(".activity-thinking-text")).toBeVisible();
  await step("[[preview-reply]]");
  await expect(answer).toBeVisible();
  await expect(answer).toHaveText("Fixture final");
  await expect(page.locator("#messages-list")).not.toContainText("Fixture final");

  await page.reload();
  await expect(answer).toHaveText("Fixture final");
  await step("[[preview-reply]]");
  await expect(answer).toHaveText("Fixture final answer.");
  await expect(page.locator("#messages-list")).not.toContainText("Fixture final");
  await step("[[complete-preview]]");
  await expect(page.locator("#messages-list")).toContainText("Fixture final answer.");
  await expect(page.getByText("Fixture final answer.", { exact: true })).toHaveCount(1);
  await expect(page.locator(".session-progress")).toHaveCount(0);
});

test("returning to a running session restores its thinking and progress before the next update", async ({ page, sessionsDir }, info) => {
  const cwd = realWorkingDir();
  const current = writeSession(sessionsDir, uniqueSessionName(info, "progress"), buildSession({ cwd }).entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, "unrelated"), buildSession({ cwd }).entries);
  const url = (id: string) => "/session?id=" + encodeURIComponent(id);
  const go = (path: string) => page.evaluate((route) => {
    history.pushState({}, "", route);
    window.dispatchEvent(new Event("pi:locationchange"));
  }, path);
  const send = (message: string) => page.evaluate(async ({ id, message }) => {
    const body = new FormData();
    body.set("message", message);
    return (await fetch("/api/chat?id=" + encodeURIComponent(id), { method: "POST", body })).status;
  }, { id: current, message });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await collapseScratchpad(page);
  await page.goto(url(current));
  const progress = page.locator(".session-progress");
  const thinking = page.locator(".preview-thinking .activity-thinking-text");
  await page.locator("#pi-chat-message").fill("[[hold-preview]]");
  await page.locator("#pi-chat-send").click();
  await expect(thinking).toHaveText("Fixture thinking before reconnect.");
  await expect(thinking).toBeVisible();

  await go("/");
  await expect(page.locator(".personal-home-main")).toBeVisible();
  await go(url(other));
  await expect(page.locator("#messages")).toContainText("Initial reply.");
  await expect(progress).toHaveCount(0);
  await expect(thinking).toHaveCount(0);
  await go(url(current));
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveText("Fixture thinking before reconnect.");
  await expect(progress).toContainText("Thinking");
  await expect(progress.locator(".session-progress-spinner")).toHaveCSS("animation-name", "session-activity-spin");
  const spinner = page.locator(".preview-thinking .preview-spinner");
  const first = await spinner.textContent();
  await expect.poll(() => spinner.textContent()).not.toBe(first);

  expect(await send("[[preview-tool]]")).toBe(202);
  await expect(progress).toContainText("Tool calls");
  await expect(progress.locator(".session-progress-tool")).toHaveText("bash");
  await expect(progress.locator(".session-progress-duration")).toHaveText(/^0:0[1-9]$/);
  await go("/");
  await expect(page.locator(".personal-home-main")).toBeVisible();
  await go(url(current));
  await expect(progress.locator(".session-progress-duration")).toHaveText(/^0:0[1-9]$/);
  await expect(page.locator("#messages-list .activity-thinking")).toHaveCount(1);
  await expect(thinking).toBeHidden();
  expect(await send("[[complete-preview]]")).toBe(202);
  await expect(page.locator("#messages-list")).toContainText("Fixture final answer.");
  await expect(progress).toHaveCount(0);
  const timedOut = page.locator('[data-collapse-key="tool:fixture-live-tool"]');
  await expect(timedOut.locator(".activity-status.timed-out")).toHaveText("Timed out");
  await timedOut.locator("summary").click();
  await expect(timedOut.locator(".tool-output")).toContainText("Captured output.");
});

test("stopping an empty reply keeps its status, model, time and retry action on reopen", async ({ page, sessionsDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, "stopped"), buildSession({ cwd: realWorkingDir() }).entries);
  const url = "/session?id=" + encodeURIComponent(id);
  await collapseScratchpad(page);
  await page.addInitScript(() => {
    localStorage.setItem("pi-web:v1:locale", "zh");
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input), location.href).pathname !== "/api/settings" || !response.ok) return response;
      const { settings } = await response.json();
      return Response.json({ settings: { ...settings, "pi-web:v1:locale": "zh" } });
    };
  });
  await page.goto(url);
  await page.locator("#pi-chat-message").fill("[[hold-preview]]");
  await page.locator("#pi-chat-send").click();
  await expect(page.locator(".session-progress")).toContainText("思考");
  await page.locator("#pi-chat-cancel").click();

  const stopped = page.locator(".assistant-message").last();
  await expect(stopped.locator(".reply-interrupted")).toHaveText("回复已中止");
  await expect(page.locator(".session-progress")).toHaveCount(0);
  await page.reload();
  const footer = stopped.locator(".reply-footer");
  await expect(stopped.locator(".reply-interrupted")).toHaveText("回复已中止");
  await expect(footer.locator(".reply-model")).not.toBeEmpty();
  await expect(footer.locator("time")).toBeVisible();
  await expect(footer.locator(".reply-copy")).toHaveCount(0);
  await stopped.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("Stub reply: Track preview state");
});

test("successive tool messages are compact and actions sit beside the tool summary", async ({ page, sessionsDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  const timestamp = new Date().toISOString();
  const id = writeSession(sessionsDir, uniqueSessionName(info, "compact-tools"), [
    ...entries,
    ...["first", "second"].flatMap((step, index) => {
      const callID = `call-${step}`;
      return [{
        type: "message", id: step, parentId: index ? "first-result" : lastId, timestamp,
        message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: callID, name: "read", arguments: { path: `${step}.txt` } }] },
      }, {
        type: "message", id: `${step}-result`, parentId: step, timestamp,
        message: { role: "toolResult", toolCallId: callID, toolName: "read", content: [{ type: "text", text: `Result ${step}` }] },
      }];
    }),
  ]);
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.getByRole("button", { name: "Collapse all" }).click();
  const first = page.locator("#entry-first .activity-disclosure > summary");
  const second = page.locator("#entry-second .activity-disclosure > summary");
  const hits = await page.locator("#entry-first").evaluate((entry) => {
    const summary = entry.querySelector(".activity-disclosure > summary")!.getBoundingClientRect();
    const menu = entry.querySelector(".entry-actions-menu > summary")!.getBoundingClientRect();
    return { overlapped: menu.left < summary.right, menuVisible: menu.width > 0 };
  });
  expect(hits).toEqual({ overlapped: false, menuVisible: true });
  await expect.poll(async () => {
    const a = (await first.boundingBox())!;
    const b = (await second.boundingBox())!;
    return b.y - a.y - a.height;
  }).toBeLessThanOrEqual(10);
  await second.click();
  await expect(page.locator("#entry-second-result")).toContainText("Result second");
  await expect(page.locator("#entry-second-result")).toBeVisible();
  await page.locator("#entry-second .entry-actions-menu > summary").click();
  await expect(page.locator("#entry-second .entry-action-buttons .label-btn")).toBeVisible();
});
