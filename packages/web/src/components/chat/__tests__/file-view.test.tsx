import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileView } from "../file-view";

vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("@/lib/syntax-highlighter", () => ({ SyntaxHighlighter: ({ children }: { children: string }) => <pre>{children}</pre>, syntaxTheme: () => ({}) }));
afterEach(() => { vi.unstubAllGlobals(); });

function preview(mime: string, path = "/owned/image.png") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ mime, size: 42, binary: true, path }) }));
  return render(<FileView path={path} />);
}

describe("FileView binary representations", () => {
  it("links a binary download to the byte representation", async () => {
    const path = "/owned/weird α #1.zip";
    preview("application/zip", path);
    const link = await screen.findByRole("link", { name: "Download file" });
    expect(link.getAttribute("href")).toBe(`/api/files/read?path=${encodeURIComponent(path)}&download=1`);
  });

  it("renders a raster image through the protected byte representation", async () => {
    preview("image/png");
    const image = await screen.findByRole("img", { name: "image.png" });
    expect(image.getAttribute("src")).toBe("/api/files/read?path=%2Fowned%2Fimage.png&download=1");
    expect(screen.queryByText(/cannot preview/)).toBeNull();
  });

  it("shows decode failure and keeps the download available", async () => {
    preview("image/png");
    fireEvent.error(await screen.findByRole("img"));
    expect(await screen.findByText("Unable to preview image.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download file" })).toBeTruthy();
  });

  it("does not embed SVG or arbitrary binary documents", async () => {
    preview("image/svg+xml", "/owned/vector.svg");
    expect(await screen.findByText(/Binary file/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("object")).toBeNull();
  });
});
