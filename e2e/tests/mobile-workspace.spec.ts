import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, collapseScratchpad, isMobileLayout } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
} from "../lib/sessions";

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
  expect(root!.y).toBe(24);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(445);
  await page.locator("#pi-chat-model-label").click();
  await expect(page.locator("#pi-chat-model-popup")).toBeVisible();
  expect(
    await page
      .locator("#pi-chat-model-search")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("16px");
  const picker = await page.locator("#pi-chat-model-popup").boundingBox();
  expect(picker!.y + picker!.height).toBeLessThanOrEqual(445);
  await page.locator(".mobile-model-heading button").click();
  await page.locator(".session-header-back").click();
  await expect(page.locator(".mobile-home")).toBeVisible();
  await expect(page.locator(".home-project").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-home.png"),
    scale: "css",
  });
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
  await page.locator("#pi-btw-button").click();
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
  const { entries } = buildSession({ cwd });
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
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
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
    ).toBe("fixed");
    await page.touchscreen.tap(8, 80);
    await page.touchscreen.tap(8, 80);
    expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBe(
      1,
    );
  }
});
