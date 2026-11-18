import { readFile } from "node:fs/promises";
import { test, expect, collapseScratchpad, isMobileLayout } from "../lib/test";
import { buildSession, realWorkingDir, uniqueSessionName, writeSession } from "../lib/sessions";

test("native session tools and interactive extension commands work in one conversation", async ({ page, sessionsDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, "native-tools"), buildSession({ cwd: realWorkingDir() }).entries);
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  const commandButton = page.locator("#command-menu-btn");
  const menu = page.locator(".mobile-command-panel.open, .command-menu-popover.open");
  await commandButton.click();
  await menu.getByRole("button", { name: "Session tools" }).click();
  const session = page.getByRole("dialog", { name: "Session tools" });
  await expect(session.locator("dl")).toContainText("12");
  await expect(session.locator("dl")).toContainText("250");
  const download = page.waitForEvent("download");
  await session.getByRole("button", { name: "Download HTML" }).click();
  const file = await download;
  expect(await readFile((await file.path())!, "utf8")).toContain("Fixture conversation");
  await session.getByRole("button", { name: "Compact context", exact: true }).click();
  await session.getByRole("button", { name: "Compact now" }).click();
  await expect(session.getByText("Context compacted.")).toBeVisible();
  await session.getByRole("button", { name: "Close Session tools" }).click();

  const editor = page.locator("#pi-chat-message");
  await editor.fill("keep my draft");
  await commandButton.click();
  await menu.getByRole("button", { name: "Pi commands" }).click();
  const commands = page.getByRole("dialog", { name: "Pi commands" });
  await commands.getByRole("searchbox").fill("picker");
  await commands.getByRole("button", { name: /fixture-picker/ }).click();
  await expect(editor).toHaveValue("/fixture-picker keep my draft");
  await page.locator("#pi-chat-send").click();
  const request = page.getByRole("dialog", { name: "Pi extension request" });
  await expect(request).toContainText("Pick a fixture option");
  await request.getByRole("button", { name: "Beta" }).click();
  await request.getByLabel("Response", { exact: true }).fill("Fixture answer");
  await request.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#pi-extension-notice")).toHaveText("Extension response received");
  await expect(request).toBeHidden();
  await expect(page.locator("#pi-chat-cancel")).toBeHidden();
  await editor.fill("Ready for the next turn");
  await expect(page.locator("#pi-chat-send")).toBeEnabled();
});

test("mobile project sheet creates nested folders beside the selected path above the keyboard", async ({ page }) => {
  const fullHeight = page.viewportSize()!.height;
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
    Object.assign(window, { projectTestViewport: viewport });
  }, fullHeight);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname === "/api/project-folders") {
        if (options?.method === "POST") {
          const req = JSON.parse(String(options.body));
          return Promise.resolve(Response.json({ path: req.parent + "/" + req.name, name: req.name }));
        }
        const path = new URL(String(input), location.href).searchParams.get("path") || "/fixture";
        return Promise.resolve(Response.json({ path, folders: [], parent: path === "/fixture" ? "" : path.slice(0, path.lastIndexOf("/")) }));
      }
      return original(input, options);
    };
  });
  await page.goto("/");
  test.skip(!(await isMobileLayout(page)), "mobile layout");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const panel = page.locator("#projectsModalOverlay .modal");
  await panel.locator(".mac-folder-browse").click();
  await expect(panel.locator(".mac-folder-current").getByRole("button", { name: "New folder" })).toBeVisible();
  await panel.getByRole("button", { name: "Choose this folder" }).click();
  const path = page.locator("#projectsAddPath");
  await expect(path).toHaveValue("/fixture");
  const newFolder = panel.locator(".mac-folder-field").getByRole("button", { name: "New folder" });
  await newFolder.click();
  const name = panel.getByLabel("Folder name");
  await expect(name).toBeFocused();
  await expect(page.locator("#projectsAddBtn")).toBeDisabled();
  await name.fill("My project");
  await page.evaluate(() => {
    const viewport = (window as any).projectTestViewport;
    Object.assign(viewport, { height: 315, layoutHeight: 340, offsetTop: 376 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#spa-root")).toHaveCSS("height", "315px");
  await expect.poll(() => page.evaluate(() => visualViewport?.offsetTop)).toBe(0);
  await expect(name).toBeFocused();
  await expect.poll(async () => {
    const rect = (await name.boundingBox())!;
    return rect.y >= 0 && rect.y + rect.height < 315;
  }).toBe(true);
  await expect.poll(() => name.evaluate((input) => {
    const rect = input.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
  })).toBe(true);
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  await expect(path).toHaveValue("/fixture/My project");
  await page.evaluate((height) => {
    const viewport = (window as any).projectTestViewport;
    Object.assign(viewport, { height, layoutHeight: height, offsetTop: 0 });
    viewport.dispatchEvent(new Event("resize"));
  }, fullHeight);
  await newFolder.click();
  await name.fill("Documents");
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  await expect(path).toHaveValue("/fixture/My project/Documents");
  await expect(page.locator("#projectsAddBtn")).toBeEnabled();

  await panel.locator(".mac-folder-browse").click();
  await panel.locator(".mac-folder-current").getByRole("button", { name: "New folder" }).click();
  await name.fill("Drafts");
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  await expect(path).toHaveValue("/fixture/My project/Documents/Drafts");
  await expect(panel.locator(".mac-folder-current code")).toHaveText("/fixture/My project/Documents/Drafts");
});
