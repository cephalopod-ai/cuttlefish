import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { compressStream, isCompressibleExt, pickEncoding } from "../compress.js";

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedCorsOrigin(origin: string | undefined, requestHost?: string): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]") {
    return true;
  }
  const reqHostname = hostnameOf(requestHost);
  if (reqHostname && reqHostname === host) return true;
  return false;
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

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(webDir))) {
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
