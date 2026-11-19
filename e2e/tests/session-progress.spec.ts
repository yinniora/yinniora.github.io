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
  const preview = page.locator("#chat-preview-stream .preview-progress");
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
  // The transcript preview owns progress; the composer line stays hidden.
  await expect(progress).toHaveCount(0);
  const spinner = page.locator(".preview-thinking .preview-spinner");
  const first = await spinner.textContent();
  await expect.poll(() => spinner.textContent()).not.toBe(first);

  expect(await send("[[preview-tool]]")).toBe(202);
  await expect(preview.locator(".preview-tool")).toHaveText("bash");
  await expect(preview.locator(".preview-duration")).toHaveText(/^0:0[1-9]$/);
  await go("/");
  await expect(page.locator(".personal-home-main")).toBeVisible();
  await go(url(current));
  await expect(preview.locator(".preview-duration")).toHaveText(/^0:0[1-9]$/);
  await expect(page.locator("#messages-list .activity-thinking")).toHaveCount(1);
  await expect(thinking).toBeHidden();
  expect(await send("[[complete-preview]]")).toBe(202);
  await expect(page.locator("#messages-list")).toContainText("Fixture final answer.");
  await expect(progress).toHaveCount(0);
  const timedOut = page.locator('[data-collapse-key="tool:fixture-live-tool"]');
  await expect(timedOut.locator(".activity-status.timed-out")).toHaveText("Timed out");
  await timedOut.locator('xpath=ancestor::details[@data-display-kind="group"]/summary').click();
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
  // The transcript preview is the only progress line while a reply runs.
  // Wait for server thinking: the local placeholder appears before the run starts.
  await expect(page.locator("#chat-preview-stream .activity-thinking-text")).toHaveText(
    "Fixture thinking before reconnect.",
  );
  await expect(page.locator(".session-progress")).toHaveCount(0);
  await page.locator("#pi-chat-cancel").click();

  const stopped = page.locator(".assistant-message").last();
  await expect(stopped.locator(".reply-interrupted")).toHaveText("回复已中止");
  await expect(page.locator(".session-progress")).toHaveCount(0);
  await page.reload();
  const footer = stopped.locator(".reply-footer");
  await expect(stopped.locator(".reply-interrupted")).toHaveText("回复已中止");
  await expect(footer.locator(".reply-model")).not.toBeEmpty();
  await expect(footer.locator(".reply-copy")).toHaveCount(0);
  await stopped.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("Stub reply: Track preview state");
});

test("successive tool messages stay in one folded group above the reply", async ({ page, sessionsDir }, info) => {
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
    {
      type: "message", id: "finished", parentId: "second-result", timestamp,
      message: { role: "assistant", stopReason: "stop", content: [
        { type: "thinking", thinking: "Reasoning included in the final message." },
        { type: "text", text: "Visible reply after tools." },
      ] },
    },
  ]);
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  const group = page.locator('details[data-collapse-key="activity:first"]');
  await expect(group.locator(":scope > summary")).toHaveText(/2 tool calls/);
  const first = page.locator("#entry-first .activity-disclosure > summary");
  const second = page.locator("#entry-second .activity-disclosure > summary");
  const answer = page.locator("#entry-finished").getByText("Visible reply after tools.", { exact: true });
  await expect(first).toBeHidden();
  await expect(answer).toBeVisible();
  await group.locator(":scope > summary").click();
  await expect(first).toBeVisible();
  await expect(page.getByText("Reasoning included in the final message.")).toBeHidden();
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
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(first).toBeHidden();
  await expect(answer).toBeVisible();
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByText("Reasoning included in the final message.")).toBeVisible();
});

test("computer approval stays visible without opening the permission menu", async ({ page, sessionsDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, "approval"), buildSession({ cwd: realWorkingDir() }).entries);
  await page.addInitScript(() => {
    const fetchFromServer = window.fetch.bind(window);
    let pending = true;
    window.fetch = async (input, init) => {
      if (new URL(String(input), location.href).pathname !== "/api/computer-use") return fetchFromServer(input, init);
      if (init?.method === "POST") {
        const { action, requestID, allow } = JSON.parse(String(init.body));
        document.documentElement.dataset.approvalRejected = String(action === "answer" && requestID === "fixture-request" && allow === false);
        pending = false;
      }
      return Response.json({
        mode: "ask",
        installed: true,
        loaded: true,
        requests: pending ? [{ id: "fixture-request", tool: "find_roots", detail: "Fixture scope" }] : [],
      });
    };
  });
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.locator("#pi-chat-message").fill("[[hold-preview]]");
  await page.locator("#pi-chat-send").click();
  const approval = page.getByRole("region", { name: "Computer action awaiting approval" });
  await expect(approval).toBeInViewport();
  await expect(approval).toContainText("find_roots");
  await expect(page.locator(".computer-permission")).not.toHaveAttribute("open", "");
  await approval.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-approval-rejected", "true");
  await expect(approval).toHaveCount(0);
  await expect(page.locator("#chat-preview-stream")).toBeVisible();
});

test("one activity summary holds interleaved tool calls and commentary", async ({ page, sessionsDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  const timestamp = new Date().toISOString();
  const id = writeSession(sessionsDir, uniqueSessionName(info, "reply-activity"), [
    ...entries,
    ...["one", "two"].flatMap((name, i) => [{
      type: "message", id: name, parentId: i ? "result-one" : lastId, timestamp,
      message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: "Intermediate note " + name },
        { type: "toolCall", id: "call-" + name, name: "read", arguments: { path: name + ".txt" } },
      ] },
    }, {
      type: "message", id: "result-" + name, parentId: name, timestamp,
      message: { role: "toolResult", toolCallId: "call-" + name, content: [{ type: "text", text: name }] },
    }]),
    {
      type: "message", id: "answer", parentId: "result-two", timestamp,
      message: { role: "assistant", stopReason: "stop", content: [
        { type: "text", text: "Final answer" },
        { type: "thinking", thinking: "Model summary after a text block." },
      ] },
    },
  ]);
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  const group = page.locator(".activity-group");
  await expect(group).toHaveCount(1);
  await expect(group.locator(":scope > summary")).toContainText("2 tool calls");
  await expect(group.getByText("Intermediate note one", { exact: true })).toBeHidden();
  await expect(page.locator("#entry-answer").getByText("Final answer")).toBeVisible();
  await group.locator(":scope > summary").click();
  await expect(group.getByText("Intermediate note one", { exact: true })).toBeVisible();
  await expect(group.getByText("Intermediate note two", { exact: true })).toBeVisible();
  await group.locator('[data-collapse-key="thinking:answer:1"] > summary').click();
  await expect(group.getByText("Model summary after a text block.")).toBeVisible();
});

test("allow for session approves an already waiting RPC computer request", async ({ page, sessionsDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, "approval-policy"), buildSession({ cwd: realWorkingDir() }).entries);
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.locator("#pi-chat-message").fill("[[computer-approval]]");
  await page.locator("#pi-chat-send").click();
  const approval = page.getByRole("region", { name: "Computer action awaiting approval" });
  await expect(approval).toBeInViewport();
  const permission = page.locator(".computer-permission");
  await expect(permission).toHaveAttribute("data-mode", "ask");
  await permission.locator(":scope > summary").click();
  page.once("dialog", (dialog) => dialog.accept());
  await permission.getByRole("button", { name: "Allow for session", exact: true }).click();
  await expect(permission).toHaveAttribute("data-mode", "allow");
  await expect(approval).toBeHidden();
  await expect(page.locator("#messages-list")).toContainText("The session policy approved the tool.");
  await page.reload();
  await expect(permission).toHaveAttribute("data-mode", "allow");
});

test("the default theme tracks system changes while the conversation stays open", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme-preference", "system");
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
});
