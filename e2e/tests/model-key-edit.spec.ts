import { test, expect } from "../lib/test";

test("edits a saved key and shows the detected API without returning the credential", async ({ page }) => {
  await page.addInitScript(() => {
    const fetchFromServer = window.fetch.bind(window);
    const profile = {
      id: "saved-key", label: "Relay key", baseUrl: "https://example.invalid/v1",
      api: "openai-completions", hasKey: true, catalogVerified: false,
      available: [
        { id: "existing", name: "Existing model", api: "anthropic-messages" },
        { id: "response", name: "Response model", api: "openai-responses" },
      ],
      applied: [{ id: "existing", name: "Existing model" }],
    };
    window.fetch = (input, init) => {
      const path = new URL(String(input), location.href).pathname;
      if (path !== "/api/model-settings") return fetchFromServer(input, init);
      if (init?.method === "POST") {
        const saved = JSON.parse(String(init.body));
        document.documentElement.dataset.updated = String(saved.action === "edit" && saved.id === profile.id && saved.key === "fixture-replacement");
        document.documentElement.dataset.checked = String(saved.checkApi === true && !saved.key);
        profile.label = saved.label;
        profile.baseUrl = saved.baseUrl;
        profile.api = "anthropic-messages";
        profile.catalogVerified = true;
      }
      return Promise.resolve(Response.json({ profiles: [profile], revision: "fixture" }));
    };
  });
  await page.goto("/settings?section=models");
  await page.getByRole("button", { name: "Edit key", exact: true }).click();
  const key = page.getByLabel("API key", { exact: true });
  await expect(key).toHaveValue("");
  await expect(page.getByLabel("Key label")).toHaveValue("Relay key");
  await page.getByLabel("Key label").fill("Updated relay");
  await page.getByLabel("API base URL").fill("https://other.invalid/v1");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await key.fill("fixture-replacement");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-updated", "true");
  await expect(page.getByText("API type · Claude / Anthropic compatible", { exact: true })).toBeVisible();
  await expect(page.getByText("Model list verified · 2", { exact: true })).toBeVisible();
  await expect(page.getByText(/Model protocols.*Claude.*Responses/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Updated relay" })).toContainText("Existing model");
  await page.getByRole("button", { name: "Check API", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-checked", "true");
  await expect(page.getByText("API connection checked.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit key", exact: true }).click();
  await expect(key).toHaveValue("");
});
