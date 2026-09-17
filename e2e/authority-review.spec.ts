import { expect, test } from "@playwright/test"

test("CUT-EA-014: displayed review revision, visible denial, retained draft, and delegated history", async ({ page }) => {
  const checkpoint = { id: "fixture-bound-checkpoint", sessionId: "e2e-scroll-session", type: "checkpoint", state: "pending",
    createdAt: "2026-09-16T00:00:00.000Z", payload: { decisionNeeded: "Continue the bounded fixture task", why: "Review required",
      options: ["approved", "revised", "deferred"], resumePrompt: "Continue reviewed task", reviewBinding: { version: 1, revision: "revision-a" } },
    resolvedByKind: null as string | null }
  const submissions: Record<string, unknown>[] = []
  const errors: string[] = []
  const currentRevision = "revision-b"
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/checkpoints?*", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state")
    await route.fulfill({ json: state === "all" || state === checkpoint.state ? [checkpoint] : [] })
  })
  await page.route("**/api/checkpoints/fixture-bound-checkpoint/decision", async (route) => {
    const body = route.request().postDataJSON()
    submissions.push(body)
    if (body.reviewedRevision !== currentRevision) {
      return route.fulfill({ status: 409, json: { error: "Reviewed approval material or target policy changed", code: "approval_authority_denied" } })
    }
    checkpoint.state = body.decision
    checkpoint.resolvedByKind = "operator_delegate"
    await route.fulfill({ json: { checkpoint, session: { id: checkpoint.sessionId, status: "running", transportState: "queued" } } })
  })
  await page.goto("/approvals")
  await expect(page.getByRole("button", { name: "Revise & resume" })).toBeVisible()
  const draft = page.getByPlaceholder("Tell the agent what to change before continuing.")
  await draft.fill("Retain this decision draft")
  await page.getByRole("button", { name: "Revise & resume" }).click()
  await expect(page.getByText("Reviewed approval material or target policy changed")).toBeVisible()
  await expect(draft).toHaveValue("Retain this decision draft")
  expect(submissions[0]).toMatchObject({ decision: "revised", reviewedRevision: "revision-a", resumePrompt: "Retain this decision draft" })
  checkpoint.payload.reviewBinding.revision = currentRevision
  await page.reload()
  await page.getByRole("button", { name: "Approve", exact: true }).click()
  await expect.poll(() => checkpoint.state).toBe("approved")
  expect(submissions[1]).toMatchObject({ decision: "approved", reviewedRevision: "revision-b" })
  await page.getByRole("button", { name: "Continue the bounded fixture task e2e-scro Operator delegate Approved" }).click()
  await expect(page.getByText("Operator delegate").first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("authority-review.png"), fullPage: true })
  expect(errors).toEqual([])
})
