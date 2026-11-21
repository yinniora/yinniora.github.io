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

test("streamed thinking stays in the same activity panel when saved", async ({ page, sessionsDir }, testInfo) => {
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
    appendEntry(sessionsDir, name, {
      type: "message", id: "saved-thought", parentId: promptId, timestamp: new Date().toISOString(),
      message: { role: "assistant", timestamp: timestamp + 1, stopReason: "toolUse",
        content: [{ type: "thinking", thinking: "Fixture thought finished" },
                  { type: "toolCall", id: "fixture-tool", name: "bash", arguments: { command: "pwd" } }] },
    });
    await page.evaluate(({ id, preview }) => {
      (window as any).sendFixturePreview(id, { ...preview, phase: "working", revision: 10000, done: true });
    }, { id, preview });
    await expect(thought).toHaveText("Fixture thought finished");
    await expect(thought).toBeVisible();
    await expect(thought).toHaveCount(1);
    await expect(panel).toHaveAttribute("data-fixture-node", "original");
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
});
