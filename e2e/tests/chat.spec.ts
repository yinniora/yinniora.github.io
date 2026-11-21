import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, collapseScratchpad } from "../lib/test";
import {
  appendEntry,
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

test("streamed thinking preserves composition and stays in the same panel when saved", async ({ page, sessionsDir }, testInfo) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  const name = uniqueSessionName(testInfo, "thinking-handoff");
  const promptId = "new-prompt";
  const timestamp = Date.now();
  const id = writeSession(sessionsDir, name, [
    ...entries,
    { type: "message", id: promptId, parentId: lastId, timestamp: new Date().toISOString(),
      message: { role: "user", timestamp, content: "Continue the task." } },
  ]);
  await page.addInitScript(() => {
    const events = new Map<string, EventSource>();
    const runningBySource = new WeakMap<EventSource, Set<string>>();
    const native = window.EventSource;
    (window as any).fixtureEventsReady = (id: string, running: boolean) => {
      const statusSource = events.get("__all__");
      const runningIds = statusSource && runningBySource.get(statusSource);
      return runningIds?.has(id) === running && events.get(id)?.readyState === native.OPEN;
    };
    (window as any).sendFixturePreview = (id: string, data: unknown) =>
      events.get(id)?.dispatchEvent(new MessageEvent("chat-preview", { data: JSON.stringify(data) }));
    window.EventSource = class extends native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        const id = new URL(url, location.href).searchParams.get("id");
        if (id) events.set(id, this);
        if (id === "__all__") {
          this.addEventListener("status-snapshot", (event: MessageEvent<string>) => {
            runningBySource.set(this, new Set(JSON.parse(event.data).running));
          });
          this.addEventListener("status-delta", (event: MessageEvent<string>) => {
            const { id, running } = JSON.parse(event.data);
            const ids = runningBySource.get(this);
            if (running) ids?.add(id);
            else ids?.delete(id);
          });
        }
      }
    };
  });
  await collapseScratchpad(page);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator("#messages")).toContainText("Continue the task.");
  // Wait for the initial file-activity grace period before taking the real
  // running/idle channel under fixture control. The preview stays synthetic.
  await page.waitForFunction((id) => (window as any).fixtureEventsReady(id, false), id);
  const statusFile = join(dirname(sessionsDir), "session-status", id);
  try {
    writeFileSync(statusFile, JSON.stringify({ state: "running", updatedAt: new Date().toISOString() }));
    await page.waitForFunction((id) => (window as any).fixtureEventsReady(id, true), id);
    const thought = page.locator("#messages-list .activity-thinking-text").filter({ hasText: "Fixture thought" });
    const preview = { content: "", thinking: "Fixture thought", messageTimestamp: timestamp + 1, thinkingIndex: 0 };
    await page.evaluate(({ id, preview }) => {
      (window as any).sendFixturePreview(id, { ...preview, phase: "thinking", revision: 9999 });
    }, { id, preview });
    await expect(thought).toBeVisible();
    const panel = page.locator("#messages-list .activity-group").filter({ hasText: "Fixture thought" });
    await expect(panel).toHaveAttribute("data-running", "true");
    await panel.evaluate((el) => el.setAttribute("data-fixture-node", "original"));

    const composer = page.locator("#pi-chat-message");
    const draft = "未发送的";
    await composer.fill(draft);
    await composer.evaluate((field: HTMLTextAreaElement) => {
      field.setAttribute("data-fixture-node", "original");
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.setRangeText("草", field.value.length, field.value.length, "end");
      field.dispatchEvent(new InputEvent("input", {
        data: "草", inputType: "insertCompositionText", isComposing: true, bubbles: true,
      }));
    });
    const history = page.locator(`#entry-${lastId} .markdown-content`).first();
    const historicalText = await history.elementHandle();
    await page.evaluate(async ({ id, preview }) => {
      for (let index = 1; index <= 32; index++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        (window as any).sendFixturePreview(id, {
          ...preview,
          thinking: `Fixture thought ${index}`,
          phase: "thinking",
          revision: 9999 + index,
        });
      }
    }, { id, preview });
    await expect(thought).toHaveText("Fixture thought 32");
    await expect(thought).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(`${draft}草`);
    expect(await composer.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]))
      .toEqual([draft.length + 1, draft.length + 1]);
    expect(await history.evaluate((current, original) => current === original, historicalText)).toBe(true);
    await composer.evaluate((field: HTMLTextAreaElement) => {
      field.setRangeText("草稿", field.value.length - 1, field.value.length, "end");
      field.dispatchEvent(new CompositionEvent("compositionend", { data: "草稿", bubbles: true }));
      field.dispatchEvent(new InputEvent("input", { data: "草稿", inputType: "insertText", bubbles: true }));
    });

    appendEntry(sessionsDir, name, {
      type: "message", id: "saved-thought", parentId: promptId, timestamp: new Date().toISOString(),
      message: { role: "assistant", timestamp: timestamp + 1, stopReason: "toolUse",
        content: [{ type: "thinking", thinking: "Fixture thought finished" },
                  { type: "toolCall", id: "fixture-tool", name: "bash", arguments: { command: "pwd" } }] },
    });
    await page.evaluate(({ id, preview }) => {
      (window as any).sendFixturePreview(id, { ...preview, phase: "working", revision: 10040, done: true });
    }, { id, preview });
    await expect(thought).toHaveText("Fixture thought finished");
    await expect(thought).toBeVisible();
    await expect(thought).toHaveCount(1);
    await expect(panel).toHaveAttribute("data-fixture-node", "original");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveAttribute("data-fixture-node", "original");
    await expect(composer).toHaveValue(`${draft}草稿`);
  } finally {
    rmSync(statusFile, { force: true });
  }
});

// Chat is driven by a `pi --mode rpc` worker. CI has no real pi, so a stub pi
// (e2e/lib/stub-pi/pi, prepended to PATH by the server harness) answers the rpc
// protocol and writes a deterministic reply into the session file, which the
// browser then picks up via the live-reload SSE path.

test.describe("chat (stubbed pi)", () => {
  test("sending a message shows the assistant reply", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    // Session cwd must exist on disk or chat is disabled ("View only").
    const cwd = realWorkingDir();
    const { entries } = buildSession({ cwd });
    const name = uniqueSessionName(testInfo, "chat");
    const id = writeSession(sessionsDir, name, entries);

    await collapseScratchpad(page);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);

    // Composer should be enabled (cwd exists -> chat available).
    const composer = page.locator("#pi-chat-composer");
    await expect(composer).toHaveAttribute("data-chat-available", "true");

    const textarea = page.locator("#pi-chat-message");
    const prompt = `e2e-chat-${testInfo.workerIndex}-${Date.now()}`;
    await textarea.fill(prompt);
    await page.locator("#pi-chat-send").click();

    // The stub echoes "Stub reply: <prompt>" and writes it to the session file;
    // it surfaces in the message pane via the fsnotify -> SSE reload.
    await expect(page.locator("#messages")).toContainText(`Stub reply: ${prompt}`, {
      timeout: 20000,
    });
  });

  test("a fresh browser follows the saved running-send mode on its only send button", async ({
    page,
    browser,
    baseURL,
    sessionsDir,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chrome", "Shared server settings; run once");
    const key = "pi-web:v1:chat-running-send-mode";
    const settings = await (await page.request.get("/api/settings")).json();
    const previous = settings.settings[key] === "queue" ? "queue" : "steer";
    const setMode = (mode: string) => page.request.post("/api/settings", {
      data: { settings: { [key]: mode } },
    });
    const waitForSave = (mode: string) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/settings" &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().settings?.[key] === mode,
    );

    try {
      expect((await setMode("steer")).ok()).toBeTruthy();
      await page.goto("/settings");
      await page.locator('[data-settings-nav="sessionDisplay"]').click();
      const mode = page.locator(`[data-setting="${key}"]`);
      await expect(mode).toHaveValue("steer");
      const save = waitForSave("queue");
      await mode.selectOption("queue");
      expect((await save).ok()).toBeTruthy();

      const { entries } = buildSession({ cwd: realWorkingDir() });
      const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "running-send-mode"), entries);
      const otherBrowser = await browser.newContext({ baseURL });
      try {
        const otherPage = await otherBrowser.newPage();
        await collapseScratchpad(otherPage);
        await otherPage.goto(`/session?id=${encodeURIComponent(id)}`);
        const composer = otherPage.locator("#pi-chat-composer");
        const send = composer.locator('button[type="submit"]');
        const input = composer.locator("#pi-chat-message");
        await input.fill("Start the work [[slow:30000]]");
        await expect(send).toHaveAccessibleName("Send");
        await send.click();

        await expect(composer.locator("#pi-chat-cancel")).toBeVisible();
        const followUp = `queue after this task ${testInfo.workerIndex}`;
        await input.fill(followUp);
        await expect(send).toHaveAccessibleName("Queue");
        await expect(composer.locator("#pi-chat-queue")).toHaveCount(0);
        await send.click();
        await expect(composer.locator(".pi-queue-item-text")).toHaveText([followUp]);
        await expect(otherPage.locator("#messages .user-message").filter({ hasText: followUp })).toHaveCount(0);

        const change = waitForSave("steer");
        await mode.selectOption("steer");
        expect((await change).ok()).toBeTruthy();
        await input.fill("A new direction");
        await expect(send).toHaveAccessibleName("Steer");
        await send.click();
        await expect(composer.locator(".pi-queue-item--steer .pi-queue-item-text")).toHaveText("A new direction");
      } finally {
        await otherBrowser.close();
      }
    } finally {
      expect((await setMode(previous)).ok()).toBeTruthy();
    }
  });
});
