import { expect, test } from "@playwright/test"

test("Team project feed supports inspection, structured mention routing, and reload state", async ({ page }) => {
  await page.goto("/?lane=team&project=e2e-scroll-session")
  await expect(page.getByText("E2E collaboration project").first()).toBeVisible()
  await expect(page.getByText("Collaboration feed is ready")).toBeVisible()
  await page.getByRole("button", { name: "Inspect session" }).click()
  await expect(page.getByRole("complementary", { name: "Session inspector" })).toBeVisible()
  await expect(page).toHaveURL(/session=e2e-scroll-session.*inspector=1/)
  await page.reload()
  await expect(page.getByRole("complementary", { name: "Session inspector" })).toBeVisible()
  await page.getByRole("button", { name: "Close session inspector" }).click()
  const composer = page.getByLabel("Team message")
  await page.getByRole("button", { name: "Select recipients" }).click()
  await page.getByRole("menuitemcheckbox", { name: /Builder/ }).click()
  await composer.fill("Browser structured Team send")
  await page.getByRole("button", { name: "Send collaboration message" }).click()
  // Scope sent-message assertions to the feed. Until onSend resolves the
  // composer is disabled but still holds the text (collaboration-composer.tsx
  // clears it only after the await), so an unscoped getByText matches both the
  // feed bubble and the textarea and trips strict mode. The composer is a
  // sibling of the feed in collaboration-pane.tsx, so role="feed" excludes it
  // structurally rather than by timing.
  await expect(page.getByRole("feed").getByText("Browser structured Team send")).toBeVisible()
  await expect(page.getByText("builder: queued")).toBeVisible()
})

test("Management defaults safely and exposes explicit one-turn authority", async ({ page }) => {
  await page.goto("/?lane=management&project=e2e-scroll-session")
  await expect(page.getByText("Management feed")).toBeVisible()
  await expect(page.getByText("Default: Program Manager")).toBeVisible()
  const composer = page.getByLabel("Management message")
  await composer.fill("Default management route")
  await page.getByRole("button", { name: "Send collaboration message" }).click()
  await expect(page.getByText("program-manager: queued")).toBeVisible()
  await page.getByRole("button", { name: "Select recipients" }).click()
  await page.getByRole("menuitemcheckbox", { name: /Cuttlefish/ }).click()
  await page.getByRole("checkbox", { name: "approve" }).check()
  await composer.fill("Explicit COO authority turn")
  await page.getByRole("button", { name: "Send collaboration message" }).click()
  // Feed-scoped for the same reason as the Team case above.
  await expect(page.getByRole("feed").getByText("Explicit COO authority turn")).toBeVisible()
  await expect(page.getByText("cuttlefish: queued")).toBeVisible()
})
