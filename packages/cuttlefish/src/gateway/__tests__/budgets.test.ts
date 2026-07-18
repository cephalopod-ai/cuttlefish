import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// checkBudget() only needs getEmployeeSpendSince() from the sessions registry;
// mock it so we can capture the "since" boundary it's called with instead of
// standing up a real database.
const getEmployeeSpendSince = vi.fn<(employee: string, sinceIsoDate: string) => number>();

vi.mock("../../sessions/registry.js", () => ({
  getEmployeeSpendSince: (employee: string, sinceIsoDate: string) => getEmployeeSpendSince(employee, sinceIsoDate),
}));

import { checkBudget } from "../budgets.js";

describe("checkBudget month window", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    getEmployeeSpendSince.mockReset();
    getEmployeeSpendSince.mockReturnValue(0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("uses the UTC month boundary, not the host-local one, right after a UTC month rollover", () => {
    // A host in a negative UTC offset (e.g. US Pacific, UTC-8) is still on the
    // previous local day/month a few hours after UTC midnight on the 1st.
    process.env.TZ = "America/Los_Angeles";
    // 2026-07-01T03:00:00Z is 2026-06-30T20:00:00 in America/Los_Angeles (PDT, UTC-7).
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 1, 3, 0, 0)));

    checkBudget("alice", { alice: 100 });

    expect(getEmployeeSpendSince).toHaveBeenCalledWith("alice", "2026-07-01");
  });

  it("computes the same UTC month window regardless of host timezone", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 1, 15, 12, 0, 0))); // 2026-02-15T12:00:00Z

    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    checkBudget("bob", { bob: 100 });
    expect(getEmployeeSpendSince).toHaveBeenLastCalledWith("bob", "2026-02-01");

    process.env.TZ = "Etc/GMT+12"; // UTC-12
    checkBudget("bob", { bob: 100 });
    expect(getEmployeeSpendSince).toHaveBeenLastCalledWith("bob", "2026-02-01");
  });
});
