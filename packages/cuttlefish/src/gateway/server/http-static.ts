import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { compressStream, isCompressibleExt, pickEncoding } from "../compress.js";

function authorityOf(hostHeader: string | undefined): string | null {
  // Normalize a Host header to a lowercase `host[:port]` authority for comparison.
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedCorsOrigin(origin: string | undefined, requestHost?: string): boolean {
  if (!origin) return true; // No Origin header — same-origin navigation or a CLI/curl client.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Same-origin only: the Origin's authority (host *and* port) must equal the
  // request's Host header. There is deliberately no blanket loopback grant — a
  // different local app (e.g. a page on http://localhost:3999 targeting the
  // gateway on localhost:8888) is cross-origin and same-*site* on loopback, so
  // reflecting it with credentialed CORS would let it read authenticated
  // responses. Comparing the full authority (not just the hostname) closes that
  // per-port hole (AR-06).
  const reqAuthority = authorityOf(requestHost);
  if (!reqAuthority) return false;
  return parsed.host.toLowerCase() === reqAuthority;
}

export function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const allowed = isAllowedCorsOrigin(origin, req.headers.host);
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  return allowed;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
): boolean {
  if (!fs.existsSync(webDir)) return false;

  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(webDir, urlPath);
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  const root = path.resolve(webDir);
  const resolved = path.resolve(filePath);
  // Containment via path.relative so it respects a real path boundary: a sibling
  // directory that merely shares the prefix (webDir `/tmp/web` vs
  // `/tmp/web_evil/secret`) yields a `..`-prefixed relative path and is rejected
  // (AR-05). Using path.relative also stays correct when `root` is a filesystem
  // root (`/`, `C:\`) — where a `root + sep` prefix check would double the
  // separator and wrongly 403 every file.
  const rel = path.relative(root, resolved);
  if (rel !== "" && (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  const isHashedAsset = urlPath.startsWith("/assets/");
  const cacheControl = isHashedAsset ? "public, max-age=31536000, immutable" : "no-store";

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    if (urlPath.startsWith("/assets/")) {
      res.writeHead(404, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("Not found");
      return true;
    }

    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const enc = isCompressibleExt(ext) ? pickEncoding(req.headers["accept-encoding"]) : null;
  const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": cacheControl };
  if (enc) {
    headers["Content-Encoding"] = enc;
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(compressStream(enc)).pipe(res);
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}
