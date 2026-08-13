import { describe, it, expect, vi, afterEach } from "vitest";
import type { LookupAddress } from "node:dns";
import { checkPublicUrl, createPinnedLookup, isPrivateAddress, safeFetch, SsrfError, validateUrlForServerFetch } from "../ssrf-guard.js";

const { undiciFetchMock } = vi.hoisted(() => ({ undiciFetchMock: vi.fn() }));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: undiciFetchMock };
});

describe("ssrf-guard: isPrivateAddress", () => {
  it("flags loopback, private, link-local and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("flags loopback / ULA / link-local IPv6 and IPv4-mapped loopback", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("allows public IPv4 literals", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("ssrf-guard: checkPublicUrl (SEC-F-003)", () => {
  it("blocks non-http(s) schemes", async () => {
    expect((await checkPublicUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await checkPublicUrl("ftp://example.com/x")).ok).toBe(false);
    expect((await checkPublicUrl("gopher://example.com")).ok).toBe(false);
  });

  it("blocks loopback hostnames without touching DNS", async () => {
    expect((await checkPublicUrl("http://localhost/x")).ok).toBe(false);
    expect((await checkPublicUrl("http://foo.localhost/x")).ok).toBe(false);
  });

  it("blocks private / loopback IP literals", async () => {
    expect((await checkPublicUrl("http://127.0.0.1:8888/api/status")).ok).toBe(false);
    expect((await checkPublicUrl("http://169.254.169.254/latest/meta-data/")).ok).toBe(false);
    expect((await checkPublicUrl("http://10.0.0.5/secret")).ok).toBe(false);
    expect((await checkPublicUrl("http://[::1]/x")).ok).toBe(false);
  });

  it("rejects malformed input", async () => {
    expect((await checkPublicUrl("not a url")).ok).toBe(false);
    expect((await checkPublicUrl("")).ok).toBe(false);
  });

  it("allows a public IP literal", async () => {
    expect((await checkPublicUrl("https://8.8.8.8/x")).ok).toBe(true);
  });

  it("can allow loopback/private targets for explicit local webhook use", async () => {
    expect((await validateUrlForServerFetch("http://127.0.0.1:9999/x", { allowPrivateHosts: true })).ok).toBe(true);
    expect((await validateUrlForServerFetch("http://localhost:9999/x", { allowPrivateHosts: true })).ok).toBe(true);
  });
});

describe("ssrf-guard: safeFetch redirect re-validation (SEC-SSRF-001)", () => {
  afterEach(() => {
    undiciFetchMock.mockReset();
    vi.restoreAllMocks();
  });

  function mockResponse(status: number, headers: Record<string, string> = {}): Response {
    return new Response(null, { status, headers });
  }

  it("refuses to follow a redirect to a private/metadata address", async () => {
    // Public URL 302s to the cloud metadata endpoint — the classic SSRF bypass.
    undiciFetchMock.mockResolvedValueOnce(
      mockResponse(302, { location: "http://169.254.169.254/latest/meta-data/" }),
    );
    await expect(safeFetch("https://8.8.8.8/redirector")).rejects.toBeInstanceOf(SsrfError);
    // The second hop (to the private address) must never be fetched.
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to loopback", async () => {
    undiciFetchMock.mockResolvedValueOnce(
      mockResponse(301, { location: "http://127.0.0.1:8787/api/config" }),
    );
    await expect(safeFetch("https://8.8.8.8/x")).rejects.toBeInstanceOf(SsrfError);
  });

  it("follows a redirect to another public target and returns the final response", async () => {
    undiciFetchMock
      .mockResolvedValueOnce(mockResponse(302, { location: "https://1.1.1.1/final" }))
      .mockResolvedValueOnce(mockResponse(200));
    const res = await safeFetch("https://8.8.8.8/start");
    expect(res.status).toBe(200);
    expect(undiciFetchMock).toHaveBeenCalledTimes(2);
    expect(undiciFetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("bounds the redirect chain", async () => {
    // Always redirect to a fresh public host → must hit the hop cap and throw.
    let n = 0;
    undiciFetchMock.mockImplementation(async () =>
      mockResponse(302, { location: `https://8.8.8.${(n++ % 8) + 1}/loop` }),
    );
    await expect(safeFetch("https://8.8.8.8/start")).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("ssrf-guard: DNS pinning (SEC-CUT-017)", () => {
  it("returns only the addresses captured by validation", async () => {
    const validated: LookupAddress[] = [{ address: "93.184.216.34", family: 4 }];
    const pinned = new Map([["rebind.example", validated.map((address) => ({ ...address }))]]);
    const lookup = createPinnedLookup(pinned);
    validated[0] = { address: "127.0.0.1", family: 4 };

    const result = await new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
      lookup("rebind.example", { all: false }, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });

    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects any hostname that was not validated for the request", async () => {
    const lookup = createPinnedLookup(new Map([["allowed.example", [{ address: "93.184.216.34", family: 4 }]]]));
    await expect(new Promise((resolve, reject) => {
      lookup("rebound.example", { all: false }, (err, address) => err ? reject(err) : resolve(address));
    })).rejects.toThrow(/No validated address/);
  });

  it("passes a pinned dispatcher to the network fetch", async () => {
    undiciFetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await safeFetch("https://8.8.8.8/resource");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://8.8.8.8/resource",
      expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }),
    );
  });
});
