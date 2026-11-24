import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { test, expect, collapseScratchpad, isMobileLayout } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
  appendEntry,
} from "../lib/sessions";

const SAMPLE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC";

test("leaving a running conversation isolates its completion from the next conversation", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "running"),
    entries,
  );
  let originalPolls = 0;
  let finishOriginal!: () => void;
  const completion = new Promise<void>((resolve) => (finishOriginal = resolve));
  await page.exposeFunction("navigationWorker", async (session: string) => {
    if (session !== id) return { state: "idle" };
    if (++originalPolls === 1) return { state: "running" };
    await completion;
    return { state: "idle" };
  });
  await page.addInitScript((oldId) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.href);
      if (url.pathname === "/api/worker-status") {
        const worker = (window as any).navigationWorker;
        const session = url.searchParams.get("id");
        const status = await worker(session);
        if (session === oldId && status.state === "idle") {
          document.documentElement.dataset.oldPoll = init?.signal?.aborted
            ? "aborted"
            : "active";
        }
        return Response.json(status);
      }
      return original(input, init);
    };
    window.addEventListener("pi-worker-done", () => {
      document.documentElement.dataset.workerDone = "true";
    });
  }, id);
  await collapseScratchpad(page);
  try {
    await page.goto("/session?id=" + encodeURIComponent(id));
    test.skip(!(await isMobileLayout(page)), "mobile layout");
    await expect(page.locator("#pi-chat-status")).toHaveClass(/\brunning\b/);
    await expect.poll(() => originalPolls).toBe(2);

    await page.locator(".session-header-back").click();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await expect(page.locator("#pi-chat-composer")).toBeVisible();
    const newId = new URL(page.url()).searchParams.get("id");
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(id);
    finishOriginal();
    await expect(page.locator("html")).toHaveAttribute(
      "data-old-poll",
      "aborted",
    );
    expect(
      await page.locator("html").getAttribute("data-worker-done"),
    ).toBeNull();
    expect(originalPolls).toBe(2);

    await page.goBack();
    await expect(page.locator(".mobile-home")).toBeVisible();
    await page.locator(`.session-card[data-session-id="${id}"]`).click();
    await expect(page.locator("#messages")).toContainText("Initial reply.");
    await expect(page.locator("#pi-chat-composer")).toBeVisible();
  } finally {
    finishOriginal();
  }
});

test("an unseen completed reply keeps its dot until the conversation is opened", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = realWorkingDir();
  const { entries } = buildSession({ cwd });
  const first = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "completed"),
    entries,
  );
  const second = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "other"),
    buildSession({ cwd }).entries,
  );
  await page.goto("/");
  const card = (id: string) =>
    page.locator(`.session-card[data-session-id="${id}"]`);
  const dot = card(first).locator(".session-completion-dot");
  await expect(card(first)).toBeVisible();
  await expect(dot).toHaveCount(0);

  const accepted = await page.evaluate(async (id) => {
    const body = new FormData();
    body.set("message", "Reply in the background [[slow:1500]]");
    const response = await fetch("/api/chat?id=" + encodeURIComponent(id), {
      method: "POST",
      body,
    });
    return response.ok;
  }, first);
  expect(accepted).toBe(true);
  await expect(dot).toHaveCount(0);
  await expect(dot).toBeVisible({ timeout: 12000 });
  await expect(card(second).locator(".session-completion-dot")).toHaveCount(0);

  await page.reload();
  await expect(dot).toBeVisible();
  await card(first).click();
  await expect(page.locator("#messages")).toContainText(
    "Reply in the background",
  );
  await page.locator(".session-header-back").click();
  await expect(card(first)).toBeVisible();
  await expect(dot).toHaveCount(0);
  await page.reload();
  await expect(card(first)).toBeVisible();
  await expect(dot).toHaveCount(0);
});

test("the session failure badge persists after reading and clears after recovery", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  const failure = assistantTextEntry(lastId, "");
  const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "failed-badge"), [
    ...entries,
    { ...failure.entry, message: { ...failure.entry.message, stopReason: "error", errorMessage: "Request failed" } },
  ]);
  const card = page.locator(`.session-card[data-session-id="${id}"]`);
  const badge = card.getByRole("img", { name: "Failed" });
  await page.goto("/");
  await expect(badge).toBeVisible();
  await card.click();
  await expect(page.locator("#messages")).toContainText("Failed");
  await page.locator(".session-header-back").click();
  await expect(badge).toBeVisible();
  await expect(card.locator(".session-completion-dot")).toHaveCount(0);

  appendEntry(sessionsDir, id, assistantTextEntry(failure.id, "Recovered.").entry);
  await expect(badge).toHaveCount(0);
  await expect(card.locator(".session-completion-dot")).toBeVisible();
});

test("a stalled session stays navigable and can be retried in place", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "load-recovery"),
    entries,
  );
  const session = page.locator(`.session-card[data-session-id="${id}"]`);
  let recovered = false;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  await page.exposeFunction("navigationStall", async () => {
    if (recovered) return false;
    await stalled;
    return true;
  });
  await page.addInitScript((sessionId) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.href);
      if (
        url.pathname === "/api/session" &&
        url.searchParams.get("id") === sessionId &&
        (await (window as any).navigationStall())
      ) {
        return Response.json({}, { status: 503 });
      }
      return original(input, init);
    };
  }, id);
  try {
    await page.goto("/");
    test.skip(!(await isMobileLayout(page)), "mobile layout");
    await session.click();
    const back = page.getByRole("link", { name: "Back to sessions" });
    await expect(
      page.getByText("Loading session…", { exact: true }),
    ).toBeVisible();
    await expect(back).toBeVisible();
    release();
    await expect(
      page.getByText("Failed to load session", { exact: true }),
    ).toBeVisible();
    recovered = true;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#messages")).toContainText("Initial reply.");
    await page.goBack();
    await expect(page.locator(".mobile-home")).toBeVisible();
  } finally {
    release();
  }
});

test("plugin settings register a skill and manage a native MCP server", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "Desktop Chrome",
    "local Mac configuration workflow",
  );
  const path = join(realWorkingDir(), "SKILL.md");
  writeFileSync(
    path,
    "---\nname: e2e-skill\ndescription: Local test fixture\n---\n",
  );
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/settings?section=plugins");
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByLabel("Mac path to a skill folder or SKILL.md").fill(path);
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(page.getByText(path, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(path, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "MCP servers", exact: true }).click();
  await page.getByLabel("Server name", { exact: true }).fill("e2e-tool");
  await page
    .getByLabel("Server URL", { exact: true })
    .fill("https://example.invalid/mcp");
  await page
    .getByRole("button", { name: "Add MCP server", exact: true })
    .click();
  const row = page
    .locator(".plugin-settings li")
    .filter({ hasText: "e2e-tool" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("model settings refresh labeled keys and explicitly apply and remove multiple models", async ({
  page,
}, testInfo) => {
  let sawKey = false;
  const endpoint = createServer((request, response) => {
    sawKey = request.headers.authorization === "Bearer fixture-e2e-key-only";
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: [{ id: "yugo-chat-one" }, { id: "yugo-chat-two" }],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    endpoint.listen(0, "127.0.0.1", resolve),
  );
  try {
    const port = (endpoint.address() as { port: number }).port;
    const label = "Personal " + testInfo.project.name;
    await page.goto("/settings?section=models");
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    await page.getByLabel("Key label", { exact: true }).fill(label);
    await page
      .getByLabel("API base URL", { exact: true })
      .fill(`http://127.0.0.1:${port}`);
    await page
      .getByLabel("API key", { exact: true })
      .fill("fixture-e2e-key-only");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Refresh models", exact: true })
      .click();
    await expect(
      page.getByText("Model list refreshed. Select models, then apply them."),
    ).toBeVisible();
    expect(sawKey).toBe(true);
    const group = page.getByRole("region", { name: label, exact: true });
    await expect(group).toHaveCount(0);
    await page
      .getByRole("checkbox", { name: /^yugo-chat-one(?:\s|$)/ })
      .check();
    await page
      .getByRole("checkbox", { name: /^yugo-chat-two(?:\s|$)/ })
      .check();
    await page
      .getByRole("button", { name: "Apply 2 selected models", exact: true })
      .click();
    await expect(group.locator(".model-applied-row")).toHaveCount(2);
    let payload = await (await page.request.get("/api/models")).json();
    expect(
      payload.models.filter((m: any) => m.providerLabel === label),
    ).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain("fixture-e2e-key-only");
    await expect(group.getByRole("button", { name: "Check effort" })).toHaveCount(0);
    await page
      .getByRole("button", {
        name: `Remove yugo-chat-one from ${label}`,
        exact: true,
      })
      .click();
    await expect(group.locator(".model-applied-row")).toHaveCount(1);
    payload = await (await page.request.get("/api/models")).json();
    expect(
      payload.models
        .filter((m: any) => m.providerLabel === label)
        .map((m: any) => m.id),
    ).toEqual(["yugo-chat-two"]);
    await page.screenshot({
      path: testInfo.outputPath("model-settings.png"),
      scale: "css",
    });
    const deleteKey = page.getByRole("button", { name: "Remove API key", exact: true });
    page.once("dialog", (dialog) => dialog.dismiss());
    await deleteKey.click();
    await expect(group.locator(".model-applied-row")).toHaveCount(1);
    page.once("dialog", (dialog) => dialog.accept());
    await deleteKey.click();
    await expect(group).toHaveCount(0);
    await expect(page.locator(".model-source").filter({ hasText: label })).toHaveCount(0);
    payload = await (await page.request.get("/api/models")).json();
    expect(payload.models.some((m: any) => m.providerLabel === label)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("two-finger image gestures scale only the image and leave the viewer open", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  entries.push(
    assistantTextEntry(
      lastId,
      `![Pinch preview](data:image/png;base64,${SAMPLE_PNG})`,
    ).entry as any,
  );
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "pinch"),
    entries,
  );
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.locator("#messages img").first().click();
  const viewer = page.locator("#image-modal"),
    image = page.locator("#modal-image");
  await expect(viewer).toBeVisible();
  const box = (await page.locator(".image-viewport").boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  if (testInfo.project.name.includes("Chrome")) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { id: 1, x: x - 40, y },
        { id: 2, x: x + 40, y },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: x - 80, y },
        { id: 2, x: x + 80, y },
      ],
    });
    await expect(page.locator(".image-zoom-reset")).toHaveText("200%");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await image.dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: x - 40,
      clientY: y,
    });
    await image.dispatchEvent("pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      clientX: x + 40,
      clientY: y,
    });
    await image.dispatchEvent("pointermove", {
      pointerId: 2,
      pointerType: "touch",
      clientX: x + 120,
      clientY: y,
    });
    await expect(page.locator(".image-zoom-reset")).toHaveText("200%");
    await image.dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
    });
    await image.dispatchEvent("pointerup", {
      pointerId: 2,
      pointerType: "touch",
    });
  }
  await expect(viewer).toBeVisible();
  expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBe(1);
  await page.locator(".image-zoom-reset").click();
  await expect(page.locator(".image-zoom-reset")).toHaveText("100%");
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(viewer).not.toBeVisible();
});

test("mobile workspace collapses projects, returns home and fits the keyboard viewport", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = realWorkingDir();
  const { entries } = buildSession({ cwd });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "workspace"),
    entries,
  );
  await collapseScratchpad(page);
  await page.addInitScript(
    ({ height }) => {
      Object.defineProperty(navigator, "standalone", { value: true });
      const viewport = new EventTarget();
      Object.assign(viewport, {
        height,
        layoutHeight: height,
        offsetTop: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", {
        value: viewport,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        get: () => (viewport as any).layoutHeight,
      });
      const scrollTo = window.scrollTo.bind(window);
      window.scrollTo = (options: ScrollToOptions | number, y?: number) => {
        if (typeof options === "object" && options.top === 0) {
          (viewport as any).offsetTop = 0;
          viewport.dispatchEvent(new Event("scroll"));
        }
        if (typeof options === "object") scrollTo(options);
        else scrollTo(options, y ?? 0);
      };
      (window as any).__testViewport = viewport;
    },
    { height: page.viewportSize()!.height },
  );
  await page.goto("/");
  test.skip(!(await isMobileLayout(page)), "mobile layout");
  await expect(page.locator(".mobile-home")).toBeVisible();
  await expect(page.locator(".personal-start-box")).toHaveCount(0);
  const project = page
    .locator("[data-home-project]")
    .filter({ has: page.locator(`.session-card[data-session-id="${id}"]`) });
  await expect(project).toHaveCount(1);
  const projectPath = await project.getAttribute("data-home-project");
  const stableProject = page.locator(`[data-home-project="${projectPath}"]`);
  await stableProject.locator(".home-project-toggle").click();
  await expect(
    page.locator(`[data-home-project="${projectPath}"] .session-card`),
  ).toHaveCount(0);
  await stableProject.locator(".home-project-toggle").click();
  await stableProject.locator(`.session-card[data-session-id="${id}"]`).click();
  await expect(page.locator(".session-header-back")).toBeVisible();
  await expect(page.locator("#tree-toggle")).toBeHidden();
  await expect(page.locator("#new-session-header-btn")).toBeHidden();
  await expect(page.locator(".session-device-button")).toBeHidden();
  await page.locator("#pi-chat-message").fill("A draft");
  expect(
    await page
      .locator("#pi-chat-message")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("16px");
  await page.evaluate(() => {
    const viewport = (window as any).__testViewport;
    viewport.height = 420;
    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#spa-root")).toHaveCSS("height", "420px");
  const root = await page.locator("#spa-root").boundingBox(),
    composer = await page.locator("#pi-chat-composer").boundingBox();
  expect(root!.y).toBe(0);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(421);
  expect(composer!.y + composer!.height).toBeGreaterThan(418);
  await page.locator("#pi-chat-model-label").click();
  await expect(page.locator("#pi-chat-model-popup")).toBeVisible();
  await page.locator("#pi-chat-model-search").focus();
  await expect(page.locator("#spa-root")).toHaveCSS("height", "420px");
  expect(
    await page
      .locator("#pi-chat-model-search")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("16px");
  const picker = await page.locator("#pi-chat-model-popup").boundingBox();
  expect(picker!.y + picker!.height).toBeLessThanOrEqual(421);
  await page.locator("#pi-chat-model-close").click();
  const message = page.locator("#pi-chat-message");
  await message.tap();
  await page.evaluate(() => {
    const viewport = (window as any).__testViewport;
    Object.assign(viewport, { layoutHeight: 436, height: 415, offsetTop: 376 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).toHaveCSS("height", "415px");
  await expect(page.locator("body")).toHaveCSS("height", "415px");
  await expect
    .poll(() => page.evaluate(() => visualViewport?.offsetTop))
    .toBe(0);
  await expect(message).toBeFocused();
  await expect(message).toHaveValue("A draft");
  const dock = (await page.locator("#pi-chat-composer").boundingBox())!;
  expect(dock.y + dock.height).toBeCloseTo(415, 0);

  const expand = page.locator("#pi-chat-expand");
  const collapsed = (await message.boundingBox())!.height;
  await expand.tap();
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await message.boundingBox())!.height).toBeGreaterThan(collapsed + 40);
  await expect(message).toBeFocused();
  await expect(message).toHaveValue("A draft");
  await expand.tap();
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await expect(message).toBeFocused();
  await expect.poll(async () => Math.round((await message.boundingBox())!.height)).toBe(Math.round(collapsed));

  await page.locator(".composer-add summary").tap();
  const attachmentMenu = page.locator(".composer-add-menu");
  const upload = attachmentMenu.getByRole("button", { name: "Upload files" });
  await expect(upload).toHaveCSS("font-size", "16px");
  expect((await upload.boundingBox())!.height).toBeGreaterThanOrEqual(52);
  expect((await attachmentMenu.boundingBox())!.width).toBeLessThanOrEqual(224);
  const draftBounds = (await message.boundingBox())!;
  await message.tap({ position: { x: draftBounds.width - 64, y: draftBounds.height / 2 } });
  await expect(attachmentMenu).toBeHidden();

  const fullHeight = page.viewportSize()!.height;
  await page.evaluate((height) => {
    const viewport = (window as any).__testViewport;
    Object.assign(viewport, { layoutHeight: height, height, offsetTop: 0 });
    viewport.dispatchEvent(new Event("resize"));
  }, fullHeight);
  await expect(page.locator("html")).toHaveCSS("height", `${fullHeight}px`);
  await expect(page.locator("html")).not.toHaveClass(/pi-keyboard-open/);
  await expect(message).toHaveValue("A draft");
  await expect(page.locator(".session-header-back")).toBeInViewport();
  await page.locator(".session-header-back").click();
  await expect(page.locator(".mobile-home")).toBeVisible();
  await expect(page.locator(".home-project").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-home.png"),
    scale: "css",
  });
});

test("installed app taps work after reload, swipes, and closing a sheet", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "standalone-taps"),
    entries,
  );
  await collapseScratchpad(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", {
      value: true,
      configurable: true,
    });
  });
  await page.goto("/");
  test.skip(!(await isMobileLayout(page)), "mobile layout");
  const initialLength = await page.evaluate(() => history.length);
  const session = page.locator(`a[data-session-id="${id}"]`);
  const composer = page.locator("#pi-chat-message");
  const home = page.locator(".mobile-home");
  const swipe = (from: "left" | "right") =>
    page.evaluate((from) => {
      const start = from === "left" ? 8 : innerWidth - 8;
      const x = start + (from === "left" ? 105 : -105);
      const touch = { clientX: start, clientY: 150, identifier: 1 };
      function fire(
        type: string,
        touches: unknown[],
        changedTouches: unknown[] = [],
      ) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          changedTouches: { value: changedTouches },
        });
        return document.querySelector("#spa-root")!.dispatchEvent(event);
      }
      return [
        fire("touchstart", [touch]),
        fire("touchmove", [{ ...touch, clientX: x }]),
        fire("touchend", [], [{ ...touch, clientX: x }]),
      ];
    }, from);

  await session.tap();
  await expect(composer).toBeVisible();
  await expect(page.locator("html[data-nav-motion], #spa-root[data-route-motion]")).toHaveCount(0);
  await page.reload();
  await composer.tap();
  await expect(composer).toBeFocused();
  for (let i = 0; i < 5; i += 1) {
    expect(await swipe("left")).toEqual([true, true, true]);
    expect(await swipe("right")).toEqual([true, true, true]);
    await page.locator(".session-header-back").tap();
    await expect(home).toBeVisible();
    await session.tap();
    await composer.tap();
    await expect(composer).toBeFocused();
  }
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("pi:devices")),
  );
  const sheet = page.getByRole("dialog", { name: "Devices", exact: true });
  await expect(sheet).toBeVisible();
  await swipe("left");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close Devices", exact: true }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/\bpi-sheet-open\b/);
  await expect(composer).toBeEditable();
  await composer.fill("still editable");
  await page.locator(".session-header-back").tap();
  await expect(home).toBeVisible();
  await page.locator("#web-menu-btn").tap();
  await page.locator('[role="menuitem"][href="/settings"]').tap();
  await expect(page.locator(".settings-page")).toBeVisible();
  await page.locator(".session-header-back").tap();
  await expect(home).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(initialLength);
});

test("a right swipe in the conversation returns to mobile Home", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  const code = assistantTextEntry(lastId, "```text\nA code example\n```");
  const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "swipe-home"), [
    ...entries,
    code.entry,
  ]);
  await collapseScratchpad(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
  });
  await page.goto("/session?id=" + encodeURIComponent(id));
  test.skip(!(await isMobileLayout(page)), "mobile layout");

  const transcript = page.locator("#content");
  const home = page.locator(".mobile-home");
  const initialHistoryLength = await page.evaluate(() => history.length);
  const swipe = (target: string, dx: number, dy: number, startX = 24) =>
    transcript.evaluate((content, { target, dx, dy, startX }) => {
      const rect = content.getBoundingClientRect();
      const start = { clientX: rect.left + startX, clientY: rect.top + 100, identifier: 1 };
      const end = { ...start, clientX: start.clientX + dx, clientY: start.clientY + dy };
      const node = target ? content.querySelector(target)! : content;
      function fire(type: string, touches: object[], changedTouches: object[] = []) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          changedTouches: { value: changedTouches },
        });
        node.dispatchEvent(event);
      }
      fire("touchstart", [start]);
      fire("touchmove", [end]);
      fire("touchend", [], [end]);
    }, { target, dx, dy, startX });

  await swipe("", 35, 4);
  await swipe("", -115, 4);
  await swipe("", 120, 4, 120);
  await swipe("", 105, 120);
  await swipe(`#entry-${code.id} pre`, 120, 0);
  await expect(transcript).toBeVisible();
  await expect(home).toHaveCount(0);

  await swipe("", 120, 9);
  await expect(home).toBeVisible();
  await page.locator(`a[data-session-id="${id}"]`).tap();
  await page.locator("#pi-chat-message").tap();
  await expect(page.locator("#pi-chat-message")).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength);
});

test("mobile Settings supports one-level swipe back", async ({ page }) => {
  await collapseScratchpad(page);
  await page.goto("/settings");
  test.skip(!(await isMobileLayout(page)), "mobile layout");
  const settings = page.locator(".settings-page");
  const language = page.locator('[data-settings-nav="language"]');
  await language.tap();
  await expect(settings).toHaveClass(/settings-page-mobile-pane/);
  const swipe = (selector: string) => page.locator(selector).evaluate((element) => {
    const touch = { identifier: 1, clientX: 24, clientY: 136 };
    const end = { ...touch, clientX: 155 };
    for (const [type, touches, changedTouches] of [
      ["touchstart", [touch], []],
      ["touchmove", [end], []],
      ["touchend", [], [end]],
    ] as const) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
      element.dispatchEvent(event);
    }
  });
  await swipe(".settings-pane");
  await expect(language).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await swipe('[data-settings-nav="language"]');
  await expect(page.locator(".mobile-home")).toBeVisible();
});

test("mobile Settings keeps a focused key field visible through keyboard pan and animates navigation", async ({ page }) => {
  await collapseScratchpad(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript((height) => {
    Object.defineProperty(navigator, "standalone", { value: true });
    const viewport = Object.assign(new EventTarget(), { height, layoutHeight: height, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    Object.defineProperty(window, "innerHeight", { get: () => viewport.layoutHeight });
    const scroll = window.scrollTo.bind(window);
    window.scrollTo = (options: ScrollToOptions | number, y?: number) => {
      if (typeof options === "object" && options.top === 0) {
        viewport.offsetTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      }
      if (typeof options === "object") scroll(options);
      else scroll(options, y ?? 0);
    };
    (window as any).__settingsViewport = viewport;
    document.addEventListener("animationstart", (event) => {
      const name = event.animationName;
      if (name === "pi-route-forward" || name === "pi-nav-push-in")
        document.documentElement.dataset.routeAnimation = "forward";
      if (name === "pi-route-back" || name === "pi-nav-pop-out")
        document.documentElement.dataset.routeAnimation = "back";
    });
  }, page.viewportSize()!.height);
  await page.goto("/settings");
  test.skip(!(await isMobileLayout(page)), "mobile layout");
  await page.locator('[data-settings-nav="models"]').tap();
  await expect(page.locator("html")).toHaveAttribute("data-route-animation", "forward");
  await page.getByRole("button", { name: "Add key", exact: true }).tap();
  const key = page.getByLabel("API key", { exact: true });
  await key.fill("fixture-only");
  await page.evaluate(() => {
    const viewport = (window as any).__settingsViewport;
    Object.assign(viewport, { height: 315, layoutHeight: 340, offsetTop: 376 });
    viewport.dispatchEvent(new Event("resize"));
  });
  const settings = page.locator(".settings-page");
  await expect(page.locator("#spa-root")).toHaveCSS("height", "315px");
  await expect(settings).toHaveCSS("overflow-y", "auto");
  await expect(key).toBeFocused();
  await expect(key).toHaveValue("fixture-only");
  await expect.poll(() => page.evaluate(() => visualViewport?.offsetTop)).toBe(0);
  await expect.poll(async () => {
    const box = (await key.boundingBox())!;
    return box.y >= 54 && box.y + box.height <= 315;
  }).toBe(true);
  await expect(page.locator("#pi-chat-composer, .pi-chat-shell")).toHaveCount(0);
  await key.blur();
  await page.evaluate((height) => {
    const viewport = (window as any).__settingsViewport;
    Object.assign(viewport, { height, layoutHeight: height, offsetTop: 0 });
    viewport.dispatchEvent(new Event("resize"));
  }, page.viewportSize()!.height);
  await page.locator(".session-header-back").tap();
  await expect(page.locator("html")).toHaveAttribute("data-route-animation", "back");
  await expect(page.locator('[data-settings-nav="models"]')).toBeVisible();
});

test("a failed turn has a single expandable error and can copy or retry its prompt", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const prompt = entries.at(-2)!;
  const first = assistantTextEntry(prompt.id, "");
  const last = assistantTextEntry(first.id, "");
  const failures = [first, last].map(({ entry }, index) => ({
    ...entry,
    message: { ...entry.message, provider: "fixture", model: "denied", stopReason: "error",
      errorMessage: `503 {"error":{"type":"model_not_found","message":"No available channel ${index}"}}` },
  }));
  const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "retry-card"), [
    ...entries.slice(0, -1), ...failures,
  ]);
  await collapseScratchpad(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => { document.documentElement.dataset.copied = value; },
    } });
    const fetchFromServer = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = new URL(String(input), location.href);
      if (url.pathname === "/api/worker-status") return Response.json({ state: "idle" });
      if (url.pathname === "/api/models") return Response.json({
        models: [{ id: "replacement", name: "Working model", provider: "fixture" }],
      });
      if (url.pathname === "/api/set-model") {
        document.documentElement.dataset.selectedModel = JSON.parse(String(options?.body)).modelId;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/chat") {
        document.documentElement.dataset.retry = String((options?.body as FormData).get("message"));
        return Response.json({ ok: true, status: "queued" }, { status: 202 });
      }
      return fetchFromServer(input, options);
    };
  });
  await page.goto("/session?id=" + encodeURIComponent(id));
  const copy = page.locator(`#entry-${prompt.id} + .message-copy-row`).getByRole("button", { name: "Copy", exact: true });
  await copy.click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", "Initial prompt.");
  await expect(page.locator(".reply-error")).toHaveCount(1);
  const failed = page.locator(`#entry-${last.id}`);
  await expect(failed.locator(".reply-error-detail")).toBeHidden();
  await failed.locator(".reply-error summary").click();
  await expect(failed.locator(".reply-error-detail")).toContainText("No available channel 1");
  await failed.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Working model", exact: true }).click();
  await expect(page.locator("#pi-chat-model-label")).toHaveAccessibleName("Working model @ fixture");
  await expect(page.locator("html")).toHaveAttribute("data-selected-model", "replacement");
  const picker = page.getByRole("dialog", { name: "Switch model", exact: true });
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await expect(picker).toBeHidden();
  const input = page.locator("#pi-chat-message");
  await input.fill("An unsent draft");
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-retry", "Initial prompt.");
  await expect(input).toHaveValue("An unsent draft");
});

test("finished replies show their own model and time and copy only reply text", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries, lastId } = buildSession({
    cwd: realWorkingDir(),
    provider: "earlier-provider",
    modelId: "earlier-model",
  });
  const now = "2026-10-10T09:44:23.000Z";
  const prelude = assistantTextEntry(lastId, "Checking the workspace...");
  const reply = assistantTextEntry(prelude.id, "");
  const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "reply-details"), [
    ...entries,
    { ...prelude.entry, message: { ...prelude.entry.message, stopReason: "toolUse" } },
    {
      ...reply.entry,
      timestamp: now,
      message: {
        ...reply.entry.message,
        provider: "saved-provider",
        model: "saved-model",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "Test thinking block" },
          { type: "text", text: "Complete **reply**." },
          { type: "text", text: "Another paragraph." },
        ],
      },
    },
  ]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => { document.documentElement.dataset.copiedReply = text; },
      },
    });
  });
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  const older = page.locator(`#entry-${lastId} .reply-footer`);
  const newer = page.locator(`#entry-${reply.id} .reply-footer`);
  await expect(older.locator(".reply-model")).toHaveText("earlier-model");
  await expect(page.locator(`#entry-${prelude.id} .reply-footer`)).toHaveCount(0);
  await expect(newer.locator(".reply-model")).toHaveText("saved-model");
  await expect(newer.locator(".reply-model")).toHaveAttribute("title", /^saved-provider\/saved-model\n/);
  await newer.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-reply",
    "Complete **reply**.\n\nAnother paragraph.",
  );
});

test("opening and following a conversation keeps standalone iOS scroll inside the transcript", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries, lastId } = buildSession({ cwd: realWorkingDir() });
  const reply = Array.from(
    { length: 100 },
    (_, n) => `Paragraph ${n}: read the conversation.`,
  ).join("\n\n");
  entries.push(assistantTextEntry(lastId, reply).entry as any);
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "viewport-pan"),
    entries,
  );
  await collapseScratchpad(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
    let stalePan = true;
    const viewport = Object.assign(new EventTarget(), { scale: 1 });
    Object.defineProperties(viewport, {
      height: { get: () => innerHeight },
      offsetTop: { get: () => (stalePan ? innerHeight : 0) },
    });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    const rootScrolls: number[] = [];
    (window as any).__rootScrolls = rootScrolls;
    window.scrollTo = (arg?: ScrollToOptions | number, top?: number) => {
      const y = typeof arg === "number" ? (top ?? 0) : (arg?.top ?? 0);
      rootScrolls.push(y);
      // Model WebKit keeping a whole-screen visual pan after a document scroll.
      stalePan = y > 0;
      viewport.dispatchEvent(new Event("scroll"));
    };
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  test.skip(!(await isMobileLayout(page)), "mobile standalone layout");

  const content = page.locator("#content");
  await expect(content).toContainText("Paragraph 99");
  await expect
    .poll(() => content.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await content.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.locator(".follow-button.visible").tap();
  await expect
    .poll(() =>
      content.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThan(3);

  const composer = page.locator("#pi-chat-message");
  await composer.tap();
  await expect(composer).toBeFocused();
  await page.locator(".session-header-back").tap();
  await expect(page.locator(".mobile-home")).toBeVisible();
  await page.locator(`.session-card[data-session-id="${id}"]`).tap();
  await expect(composer).toBeVisible();
  expect(
    await page.evaluate(() => ({
      rootScrolls: (window as any).__rootScrolls,
      offset: window.visualViewport?.offsetTop,
      restoration: history.scrollRestoration,
    })),
  ).toEqual({ rootScrolls: [0], offset: 0, restoration: "manual" });
});

test("mobile images zoom independently and BTW explains itself before opening the keyboard", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = realWorkingDir();
  const { entries, lastId } = buildSession({ cwd });
  const image = assistantTextEntry(
    lastId,
    `![A sample diagram](data:image/png;base64,${SAMPLE_PNG})`,
  );
  entries.push(image.entry as any);
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "media"),
    entries,
  );
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  test.skip(!(await isMobileLayout(page)), "mobile layout");
  const img = page.locator("#messages img").first();
  await expect(img).toBeVisible();
  await img.click();
  await expect(page.locator("#image-modal")).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator("#modal-image")).toHaveCSS(
    "width",
    `${testInfo.project.use.viewport!.width * 1.5}px`,
  );
  await page
    .locator("#image-modal")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.locator(".session-header-bar #pi-btw-button").tap();
  await expect(page.locator("#pi-git-bar")).toBeHidden();
  await expect(page.locator(".pi-btw-window")).toBeVisible();
  await expect(page.locator(".pi-btw-intro")).toContainText(
    "without the main chat history",
  );
  expect(
    await page
      .locator("#pi-btw-input")
      .evaluate((el) => document.activeElement === el),
  ).toBe(false);
  await expect(page.locator(".pi-btw-close")).toBeVisible();
  expect(
    (await page.locator(".pi-btw-close svg").boundingBox())!.width,
  ).toBeGreaterThan(12);
  await page.screenshot({
    path: testInfo.outputPath("mobile-btw.png"),
    scale: "css",
  });
});

test("gallery SVGs enlarge and H.264 video plays with authenticated range support", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = realWorkingDir();
  const { entries, lastId } = buildSession({ cwd });
  const assetEntry = assistantTextEntry(lastId, "");
  entries.push({
    ...assetEntry.entry,
    message: {
      ...assetEntry.entry.message,
      content: ["./clip.mp4", join(cwd, "diagram.svg"), "./read-only.svg"].map((path, index) => ({
        type: "toolCall",
        name: "read",
        id: "read-" + index,
        arguments: { path },
      })),
    },
  } as any);
  const reply = assistantTextEntry(
    assetEntry.id,
    "The SVG and video are ready. [Download SVG](./diagram.svg) · [Video](./clip.mp4) · [Missing file](./missing.svg)",
  );
  const model = "claude-opus-" + "extended-model-identifier-".repeat(4) + "thinking";
  const modelReply = { ...reply.entry, message: { ...reply.entry.message, provider: "test", model } };
  const nextPrompt = {
    type: "message",
    id: "next-gallery-prompt",
    parentId: reply.id,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: "Thanks, could you summarize?" }],
      timestamp: Date.now(),
    },
  };
  const nextReply = assistantTextEntry(nextPrompt.id, "Here is a summary.");
  entries.push(modelReply, nextPrompt, nextReply.entry);
  copyFileSync(
    new URL("../fixtures/media/clip.mp4", import.meta.url),
    join(cwd, "clip.mp4"),
  );
  writeFileSync(
    join(cwd, "diagram.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="steelblue"/></svg>',
  );
  writeFileSync(join(cwd, "read-only.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "gallery"),
    entries,
  );
  const other = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "empty-gallery"),
    entries.slice(0, 1).map((entry) => ({ ...entry, id: "empty-gallery" })),
  );
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  const mediaReply = page.locator(`#entry-${reply.id}`);
  const gallery = mediaReply.getByRole("region", { name: "Outputs", exact: true });
  await expect(gallery.locator("img.output-inline-preview")).toBeVisible();
  await expect(mediaReply.locator(".assistant-text + .output-gallery + .reply-footer")).toBeVisible();
  await expect(gallery.locator(".output-card")).toHaveCount(2);
  await expect(gallery.getByText("read-only.svg")).toHaveCount(0);
  const conversationURL = page.url();
  const saving = page.waitForEvent("download");
  await mediaReply.getByRole("button", { name: "Download SVG", exact: true }).click();
  const saved = await saving;
  expect(saved.suggestedFilename()).toBe("diagram.svg");
  expect(readFileSync((await saved.path())!)).toEqual(readFileSync(join(cwd, "diagram.svg")));
  await expect(page).toHaveURL(conversationURL);
  await mediaReply.getByRole("button", { name: "Missing file", exact: true }).click();
  await expect(page.locator("#session-file-download")).toContainText("This file is unavailable");
  await expect(page).toHaveURL(conversationURL);
  await expect(page.locator(".assistant-message .output-gallery")).toHaveCount(1);
  await expect(page.locator(`#entry-${nextReply.id} .reply-footer`)).toBeVisible();
  await expect(mediaReply.locator(".reply-model")).toHaveText(model);
  if (await isMobileLayout(page)) {
    const layout = await mediaReply.locator(".reply-footer").evaluate((footer) => {
      const copy = footer.querySelector(".reply-copy")!.getBoundingClientRect();
      const model = footer.querySelector(".reply-model")!.getBoundingClientRect();
      return {
        copyAndModelShareRow: Math.abs((copy.top + copy.bottom - model.top - model.bottom) / 2) < 1,
        modelStaysInside: model.right <= footer.getBoundingClientRect().right,
      };
    });
    expect(layout).toEqual({ copyAndModelShareRow: true, modelStaysInside: true });
  }
  await expect(gallery.locator("iframe")).toHaveCount(0);
  await gallery
    .getByRole("button", { name: "Enlarge diagram.svg", exact: true })
    .click();
  await expect(page.locator("#image-modal")).toBeVisible();
  await expect(page.locator("#modal-image")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml/,
  );
  await expect
    .poll(() =>
      page
        .locator("#modal-image")
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await testInfo.attach("image-layout", {
    contentType: "application/json",
    body: JSON.stringify(
      await page.locator("#modal-image").evaluate((image) => {
        const img = image as HTMLImageElement;
        const box = img.getBoundingClientRect();
        const viewport = img.parentElement!.getBoundingClientRect();
        return {
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          viewport: {
            x: viewport.x,
            y: viewport.y,
            width: viewport.width,
            height: viewport.height,
          },
          natural: [img.naturalWidth, img.naturalHeight],
        };
      }),
    ),
  });
  await page.screenshot({
    path: testInfo.outputPath("image-viewer.png"),
    scale: "css",
  });
  await page.locator(".image-viewport").click({ position: { x: 10, y: 10 } });
  await expect(page.locator("#image-modal")).toBeHidden();
  await gallery
    .getByRole("button", { name: "Enlarge diagram.svg", exact: true })
    .click();
  await expect(page.locator("#image-modal")).toBeVisible();
  await page
    .locator("#image-modal")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const video = gallery.locator("video.output-video");
  await expect(video).toBeVisible();
  const src = await video.getAttribute("src");
  const range = await page.request.get(src!, {
    headers: { range: "bytes=0-99" },
  });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(100);
  await video.evaluate(async (element) => {
    const v = element as HTMLVideoElement;
    v.muted = true;
    await v.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).videoWidth),
    )
    .toBe(64);
  const card = gallery.locator(".output-card").filter({ has: page.locator("video.output-video") });
  await card.getByRole("button", { name: "Open clip.mp4", exact: true }).click();
  await expect(page.locator(".output-full-video")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".output-full-video")).toBeHidden();
  if (await isMobileLayout(page)) {
    await page.locator(".session-header-back").tap();
    const otherAssets = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/assets" && url.searchParams.get("id") === other
      );
    });
    await page.locator(`a[data-session-id="${other}"]`).tap();
    await expect(page.locator("#pi-chat-composer")).toHaveAttribute(
      "data-session-id",
      other,
    );
    await expect(page.locator("#messages-list .assistant-message")).toHaveCount(
      0,
    );
    expect((await (await otherAssets).json()).assets).toEqual([]);
    await expect(page.locator(".output-gallery")).toHaveCount(0);
    await page.goBack();
    await expect(page.locator(".mobile-home")).toBeVisible();
    await page.locator(`a[data-session-id="${id}"]`).tap();
    await expect(gallery.locator("img.output-inline-preview")).toBeVisible();
    await expect(gallery.locator("video.output-video")).toBeVisible();
    await expect(page.locator(".session-header-back")).toBeVisible();
  }
});

test("image operations follow tool results, then fold above the completed reply", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = realWorkingDir();
  const { entries, lastId } = buildSession({ cwd });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg>';
  const png = { type: "image", mimeType: "image/png", data: SAMPLE_PNG };
  let parentId = lastId;
  function recordTool(key: string, name: string, path: string, result: object, thinking = "") {
    const assistant = assistantTextEntry(parentId, "");
    const call = { type: "toolCall", id: key, name, arguments: { path } };
    entries.push({
      ...assistant.entry,
      message: {
        ...assistant.entry.message,
        stopReason: "toolUse",
        content: thinking ? [{ type: "thinking", thinking }, call] : [call],
      },
    } as any);
    parentId = key + "-result";
    entries.push({
      type: "message",
      id: parentId,
      parentId: assistant.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: key,
        toolName: name,
        content: [result],
        isError: false,
      },
    } as any);
  }
  recordTool("read-svg", "read", "./reviewed.svg", {
    type: "text",
    text: '<svg xmlns="http://www.w3.org/2000/svg">\n[3 more lines in file. Use offset=2 to continue.]',
  });
  recordTool("read-png", "read", "/tmp/check.png", png);
  const initial = entries.length;
  recordTool("edit-svg", "edit", "edited.svg", { type: "text", text: "Updated edited.svg" },
    "Adjust the circle.");
  recordTool("screenshot", "mcp__browser__screenshot", "/tmp/capture.png", png);
  recordTool("recheck", "view_image", "/tmp/rechecked.png", png);
  recordTool("write-svg", "write", "finished.svg", { type: "text", text: "Wrote finished.svg" });
  const reply = assistantTextEntry(
    parentId,
    "[Download the SVG](./finished.svg) · [Documentation](https://example.test/docs)",
  );
  for (const file of ["reviewed.svg", "edited.svg", "finished.svg"]) {
    writeFileSync(join(cwd, file), svg);
  }

  const name = uniqueSessionName(testInfo, "image-operations");
  const id = writeSession(sessionsDir, name, entries.slice(0, initial));
  const statusFile = join(dirname(sessionsDir), "session-status", id);
  const summary = page.locator('details[data-display-kind="image-summary"]');
  const activity = page.locator(".activity-group").last();
  const files = ["reviewed.svg", "check.png", "edited.svg", "capture.png", "rechecked.png"];
  let svgRequests = 0;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/asset" && url.searchParams.get("path") === "reviewed.svg") {
      svgRequests++;
    }
  });
  if (/Mobile Safari|iPad/.test(testInfo.project.name)) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { value: true });
    });
  }
  await collapseScratchpad(page);
  try {
    writeFileSync(statusFile, JSON.stringify({ state: "running", updatedAt: new Date().toISOString() }));
    await page.goto("/session?id=" + encodeURIComponent(id));
    await expect(activity).toHaveAttribute("data-running", "true");
    await expect(summary).toHaveCount(0);
    await expect(activity.locator("figcaption")).toHaveText(files.slice(0, 2));
    const firstPreview = activity.getByRole("button", { name: "Enlarge reviewed.svg" });
    await firstPreview.scrollIntoViewIfNeeded();
    await expect(firstPreview.locator("img")).toHaveAttribute("decoding", "async");
    expect(svgRequests).toBe(1);

    const composer = page.locator("#pi-chat-message");
    await composer.fill("未发出的草稿");
    for (const entry of entries.slice(initial)) appendEntry(sessionsDir, name, entry);
    await expect(activity.locator("figcaption")).toHaveText(files);
    await expect(activity.locator(".activity-thinking")).toBeVisible();
    expect(await activity.evaluate((group) => Array.from(group.querySelectorAll(
      ".activity-thinking, .tool-image-strip",
    )).map((row) => row.getAttribute("aria-label") || "thinking")))
      .toEqual(["Viewed images", "Viewed images", "thinking", "Edited images", "Other operations", "Viewed images"]);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("未发出的草稿");
    await expect(summary).toHaveCount(0);

    appendEntry(sessionsDir, name, reply.entry);
    await expect(summary).toHaveAttribute("open", "");
    await expect(summary.locator("figcaption")).toHaveText(files);
    await expect(summary.locator(".activity-label")).toHaveText("Image operations");
    await expect(summary.locator(".activity-count")).toHaveText("5");
    const orderedActions = await summary.locator(".tool-image-strip").evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("aria-label")),
    );
    expect(orderedActions).toEqual(["Viewed images", "Edited images", "Other operations", "Viewed images"]);
    await expect(activity.locator(".tool-image-reference")).toHaveCount(5);
    await expect(activity.locator(".tool-preview")).toHaveCount(0);

    const assistant = page.locator("#entry-" + reply.id);
    const output = assistant.getByRole("region", { name: "Outputs", exact: true });
    expect(await assistant.evaluate((reply) => reply.previousElementSibling?.getAttribute("data-display-kind")))
      .toBe("image-summary");
    await expect(assistant.locator(".assistant-text + .output-gallery + .reply-footer")).toBeVisible();
    await expect(output.locator(".output-file-name").getByText("finished.svg", { exact: true })).toHaveCount(1);
    await expect(output.locator(".output-file-name").getByText("edited.svg", { exact: true })).toHaveCount(1);
    await expect(page.locator(".output-file-name")).toHaveCount(2);

    const heading = summary.locator(":scope > summary");
    await heading.click();
    await expect(summary.locator(".tool-preview")).toHaveCount(0);
    await heading.click();
    for (const [filename, source] of [
      ["reviewed.svg", /^data:image\/svg\+xml/],
      ["check.png", /^data:image\/png/],
      ["edited.svg", /^data:image\/svg\+xml/],
    ] as const) {
      const thumbnail = summary.getByRole("button", { name: "Enlarge " + filename, exact: true });
      await thumbnail.scrollIntoViewIfNeeded();
      await thumbnail.click();
      await expect(page.locator("#modal-image")).toHaveAttribute("src", source);
      await expect.poll(() => page.locator("#modal-image").evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      )).toBeGreaterThan(0);
      await page.locator("#image-modal").getByRole("button", { name: "Close", exact: true }).click();
    }
    expect(svgRequests).toBe(1);
    const linkColors = await assistant.evaluate((element) =>
      [".session-file-link", "a", ".output-download"].map((selector) =>
        getComputedStyle(element.querySelector(selector)!).color,
      ),
    );
    expect(linkColors).toEqual([linkColors[0], linkColors[0], linkColors[0]]);
    const [red, green, blue] = linkColors[0].match(/\d+/g)!.map(Number);
    expect(blue).toBeGreaterThan(Math.max(red, green));
    await expect(assistant.locator('a[href="./finished.svg"]')).toHaveCount(0);
    const url = page.url();
    const download = page.waitForEvent("download");
    await assistant.getByRole("button", { name: "Download the SVG" }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("finished.svg");
    expect(readFileSync((await saved.path())!, "utf8")).toBe(svg);
    await expect(page).toHaveURL(url);
  } finally {
    rmSync(statusFile, { force: true });
  }
});

test("all phone routes keep the outer page fixed and disable page zoom", async ({
  page,
}) => {
  for (const route of ["/", "/settings", "/schedules"]) {
    await page.goto(route);
    test.skip(!(await isMobileLayout(page)), "mobile layout");
    await expect(page.locator("#spa-root")).not.toBeEmpty();
    expect(
      await page.locator('meta[name="viewport"]').getAttribute("content"),
    ).toContain("user-scalable=no");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    expect(
      await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).overflowX),
    ).toBe("hidden");
    expect(
      await page
        .locator("#spa-root")
        .evaluate((el) => getComputedStyle(el).position),
    ).toBe("relative");
    await page.touchscreen.tap(8, 80);
    await page.touchscreen.tap(8, 80);
    expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBe(
      1,
    );
  }
});

test("composer switches effort on model change and sends a file using the attachment menu", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "composer"), entries);
  await page.addInitScript(() => {
    const realHeight = window.innerHeight;
    const viewport = Object.assign(new EventTarget(), { height: realHeight, scale: 1, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    Object.assign(window, {
      setKeyboardVisible(visible: boolean) {
        viewport.height = visible ? 415 : window.innerHeight;
        viewport.dispatchEvent(new Event("resize"));
      },
    });
    const fetchOriginal = window.fetch.bind(window);
    let active: { provider: string; modelId: string } | undefined;
    let level = "off";
    window.fetch = async (input, init) => {
      switch (new URL(String(input), location.href).pathname) {
        case "/api/models":
          return Response.json({ models: [
            { provider: "catalog", providerLabel: "Pro key", id: "parameter-model", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, medium: null, max: "max" } },
            { provider: "other-key", id: "parameter-model", reasoning: true, thinkingLevelMap: { off: null, minimal: null, high: null, low: null, xhigh: "xhigh" } },
            { provider: "catalog", id: "fixed-model-thinking", reasoning: false },
          ] });
        case "/api/set-model":
          active = JSON.parse(String(init?.body));
          level = active?.provider === "other-key" ? "medium" : "off";
          return Response.json(active?.provider === "catalog" && active?.modelId === "parameter-model"
            ? { ok: true, thinkingLevel: "off", thinkingLevels: ["off", "low", "max"] }
            : { ok: true });
        case "/api/set-thinking-level":
          level = JSON.parse(String(init?.body)).level;
          return Response.json({ ok: true, thinkingLevel: level });
        case "/api/worker-status":
          return Response.json(active
            ? { state: "idle", modelProvider: active.provider, model: active.modelId, thinkingLevel: level }
            : { state: "idle" });
        default:
          return fetchOriginal(input, init);
      }
    };
  });
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  const modelControl = page.locator("#pi-chat-model-label");
  const effortRow = page.locator("#pi-chat-effort-controls");
  const picker = page.locator("#pi-chat-model-popup");
  const search = page.locator("#pi-chat-model-search");
  await expect(modelControl).toHaveText("");
  await expect(modelControl.locator("svg")).toBeVisible();
  await modelControl.click();
  await expect(picker).toBeVisible();
  await expect(modelControl).toHaveAttribute("aria-expanded", "true");
  const draft = page.locator("#pi-chat-message");
  await draft.fill("Preserve this draft");
  await search.fill("no matching catalog entry");
  await search.press("Enter");
  await expect(picker.locator(".model-item")).toHaveCount(0);
  await expect(draft).toHaveValue("Preserve this draft");
  await search.fill("Pro key");
  await expect(picker.locator(".model-item")).toHaveCount(2);
  await search.clear();
  const model = picker.locator('.model-item[data-provider="catalog"][data-model-id="parameter-model"]');
  await model.click();
  await expect(model).toHaveAttribute("aria-pressed", "true");
  await expect(modelControl).toHaveAccessibleName("Pro key · parameter-model · none");
  await expect(picker.locator("#pi-chat-model-current")).toHaveText("parameter-model @ Pro key");
  await expect(picker.locator(".thinking-level-item")).toHaveCount(3);
  await expect(picker.locator(".thinking-level-item[data-level=high]")).toHaveCount(0);
  await expect(picker.locator(".thinking-level-item[data-level=off]")).toHaveAttribute("aria-pressed", "true");
  await expect(picker.locator(".thinking-level-item[data-level=off]")).toHaveText("none");
  await picker.locator(".thinking-level-item[data-level=max]").click();
  await expect(modelControl).toHaveAccessibleName("Pro key · parameter-model · max");
  await expect(picker.locator(".thinking-level-item[data-level=max]")).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("button", { name: "none", exact: true }).click();
  await expect(modelControl).toHaveAccessibleName("Pro key · parameter-model · none");
  if (await isMobileLayout(page)) {
    await search.focus();
    await page.evaluate(() => (window as Window & { setKeyboardVisible?: (value: boolean) => void }).setKeyboardVisible?.(true));
    await expect(page.locator("html")).toHaveClass(/pi-keyboard-open/);
    await expect.poll(async () => {
      const rect = (await picker.boundingBox())!;
      return rect.y >= 0 && rect.y + rect.height <= 416;
    }).toBe(true);
    await search.blur();
    await page.evaluate(() => (window as Window & { setKeyboardVisible?: (value: boolean) => void }).setKeyboardVisible?.(false));
    await expect(page.locator("html")).not.toHaveClass(/pi-keyboard-open/);
  }
  await picker.locator('.model-item[data-provider="other-key"][data-model-id="parameter-model"]').click();
  await expect(picker.locator(".thinking-level-item")).toHaveCount(2);
  await expect(picker.locator(".thinking-level-item[data-level=xhigh]")).toHaveText("xhigh");
  await picker.locator('.model-item[data-model-id="fixed-model-thinking"]').click();
  await expect(modelControl).toHaveText("");
  await expect(effortRow).toBeHidden();
  await page.locator("#pi-chat-model-close").click();
  await expect(picker).toHaveAttribute("inert", "");
  await expect(modelControl).toHaveAttribute("aria-expanded", "false");
  await draft.clear();

  const permission = page.locator(".computer-permission summary");
  await permission.click();
  await expect(page.getByRole("button", { name: "Ask each time" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Off", exact: true }).click();
  await expect(page.getByRole("button", { name: "Off", exact: true })).toHaveAttribute("aria-pressed", "true");
  await permission.click();

  await page.locator(".composer-add summary").click();
  await expect(page.getByRole("button", { name: "Take a photo", exact: true })).toBeVisible();
  await expect(page.locator("#pi-chat-camera")).toHaveAttribute("capture", "environment");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("test notes") });
  await expect(page.locator("#pi-chat-attachments")).toContainText("notes.txt");
  const requested = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/chat");
  await page.locator("#pi-chat-send").click();
  expect((await requested).status()).toBe(202);
  await expect(page.locator("#messages")).toContainText("notes.txt");
});

test("the attachment menu and per-session permissions use the selected Chinese locale", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "composer-zh"), entries);
  await page.addInitScript(() => {
    localStorage.setItem("pi-web:v1:locale", "zh");
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input), location.href).pathname !== "/api/settings" ||
          (init?.method && init.method !== "GET") || !response.ok) return response;
      const { settings } = await response.json();
      return Response.json({ settings: { ...settings, "pi-web:v1:locale": "zh" } });
    };
  });
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.locator(".composer-add summary").click();
  await expect(page.getByRole("button", { name: "上传文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拍照", exact: true })).toBeVisible();
  await page.locator(".computer-permission summary").click();
  await expect(page.getByRole("button", { name: "每次询问" })).toBeVisible();
  await expect(page.getByRole("button", { name: "本会话允许" })).toBeVisible();
});
