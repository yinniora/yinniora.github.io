import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { test, expect, collapseScratchpad, isMobileLayout } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
} from "../lib/sessions";

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
    await expect(
      page.locator(".model-applied-row").filter({ hasText: label }),
    ).toHaveCount(0);
    await page
      .getByRole("checkbox", { name: "yugo-chat-one", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "yugo-chat-two", exact: true })
      .check();
    await page
      .getByRole("button", { name: "Apply 2 selected models", exact: true })
      .click();
    await expect(
      page.locator(".model-applied-row").filter({ hasText: label }),
    ).toHaveCount(2);
    let payload = await (await page.request.get("/api/models")).json();
    expect(
      payload.models.filter((m: any) => m.providerLabel === label),
    ).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain("fixture-e2e-key-only");
    await page
      .getByRole("button", {
        name: `Remove yugo-chat-one from ${label}`,
        exact: true,
      })
      .click();
    await expect(
      page.locator(".model-applied-row").filter({ hasText: label }),
    ).toHaveCount(1);
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
      "![Pinch preview](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8z0AAAAASUVORK5CYII=)",
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
      const viewport = new EventTarget();
      Object.assign(viewport, {
        height,
        offsetTop: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", {
        value: viewport,
        configurable: true,
      });
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
  await page.locator(".mobile-model-heading button").click();
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

test("installed app recovers a stationary touch when the browser omits click", async ({
  page,
  context,
  sessionsDir,
}, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Chrome", "trusted touch via CDP");
  const { entries } = buildSession({ cwd: realWorkingDir() });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(testInfo, "lost-tap"),
    entries,
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const composer = page.locator("#pi-chat-message");
  await expect(composer).toBeEditable();
  const cdp = await context.newCDPSession(page);
  const tap = async (selector: string, drag = false) => {
    const box = (await page.locator(selector).boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    if (drag) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, y: point.y + 36 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  const trigger = page.locator(".session-header-bar #pi-btw-button");
  const popup = page.getByRole("dialog", { name: "btw" });
  await trigger.tap();
  await expect(popup).toBeVisible();
  await page.waitForTimeout(400);
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Close", exact: true }).tap();
  await expect(popup).toBeHidden();
  await expect(page.locator("#pi-git-bar")).toBeHidden();

  // Preserve trusted touch events but omit the separate browser click.
  await page.evaluate(() =>
    window.addEventListener("touchend", (event) => event.preventDefault(), {
      passive: false,
    }),
  );
  await tap("#pi-chat-message");
  await expect(composer).toBeFocused();
  await tap(".session-header-back", true);
  await expect(page.locator(".mobile-home")).toBeHidden();
  await tap(".session-header-back");
  await expect(page.locator(".mobile-home")).toBeVisible();
  await tap("#web-menu-btn");
  const settings = '[role="menuitem"][href="/settings"]';
  await expect(page.locator(settings)).toBeVisible();
  await tap(settings);
  await expect(page.locator(".settings-page")).toBeVisible();
});

test("mobile images zoom independently and BTW explains itself before opening the keyboard", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = realWorkingDir();
  const { entries, lastId } = buildSession({ cwd });
  const image = assistantTextEntry(
    lastId,
    "![A sample diagram](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8z0AAAAASUVORK5CYII=)",
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
      content: ["clip.mp4", "diagram.svg"].map((path) => ({
        type: "toolCall",
        name: "read",
        id: "read-" + path,
        arguments: { path },
      })),
    },
  } as any);
  copyFileSync(
    new URL("../fixtures/media/clip.mp4", import.meta.url),
    join(cwd, "clip.mp4"),
  );
  writeFileSync(
    join(cwd, "diagram.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="steelblue"/></svg>',
  );
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
  await expect(
    page.locator(".output-gallery img.output-inline-preview"),
  ).toBeVisible();
  await expect(page.locator(".output-gallery iframe")).toHaveCount(0);
  await page
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
  await page
    .getByRole("button", { name: "Enlarge diagram.svg", exact: true })
    .click();
  await expect(page.locator("#image-modal")).toBeVisible();
  await page
    .locator("#image-modal")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const video = page.locator(".output-video").first();
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
  const card = page.locator(".output-card").filter({ has: video });
  await card.getByRole("button", { name: "Open", exact: true }).click();
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
    await expect(page.locator(".output-inline-preview")).toBeVisible();
    await expect(page.locator(".session-header-back")).toBeVisible();
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
