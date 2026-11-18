import { test, expect, collapseScratchpad } from "../lib/test";
import { buildSession, realWorkingDir, uniqueSessionName, writeSession } from "../lib/sessions";

test("balances are shown once per key in settings and the model picker", async ({ page, sessionsDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, "balances"), buildSession({ cwd: realWorkingDir() }).entries);
  const profiles = [
    { id: "wallet", label: "Wallet key", hasKey: true, applied: [], available: [] },
    { id: "uncapped", label: "Uncapped key", hasKey: true, applied: [], available: [] },
  ];
  await page.addInitScript((payloads) => {
    const actual = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const path = new URL(String(input), location.href).pathname;
      const payload = (payloads as Record<string, unknown>)[path];
      return payload ? Promise.resolve(Response.json(payload)) : actual(input, options);
    };
  }, {
    "/api/model-settings": { profiles, revision: "fixture" },
    "/api/model-balances": { balances: {
      wallet: { status: "available", scope: "account", unit: "CNY", amount: 12.5 },
      uncapped: { status: "unlimited" },
    } },
    "/api/models": { models: [
      { id: "alpha", name: "Alpha", provider: "wallet", providerLabel: "Wallet key" },
      { id: "beta", name: "Beta", provider: "wallet", providerLabel: "Wallet key" },
      { id: "gamma", name: "Gamma", provider: "uncapped", providerLabel: "Uncapped key" },
    ] },
  });
  await collapseScratchpad(page);
  await page.goto("/session?id=" + encodeURIComponent(id));
  await page.locator("#pi-chat-model-label").click();
  await expect(page.locator('[data-balance-provider="wallet"]')).toContainText(/Account balance .*12\.50/);
  await expect(page.locator('[data-balance-provider="uncapped"]')).toHaveText("Key uncapped · account balance unavailable");
  await expect(page.locator(".model-item")).toHaveCount(3);

  await page.goto("/settings?section=models");
  await expect(page.locator(".model-source").filter({ hasText: "Wallet key" })).toContainText(/Account balance .*12\.50/);
  await expect(page.locator(".model-source").filter({ hasText: "Uncapped key" })).toContainText("Key uncapped · account balance unavailable");
});
