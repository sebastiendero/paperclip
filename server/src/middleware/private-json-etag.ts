import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

function matchesEtag(header: string | undefined, etag: string) {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

export function privateJsonEtag(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }

    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      const contentType = res.getHeader("Content-Type");
      if (
        res.statusCode < 200
        || res.statusCode >= 300
        || typeof contentType !== "string"
        || !contentType.includes("application/json")
      ) return originalSend(body);
      const serialized = typeof body === "string" ? body : JSON.stringify(body);
      const cacheControl = res.getHeader("Cache-Control");
      if (typeof cacheControl === "string" && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) {
        // Browser screenshots and other sensitive JSON must never receive the
        // middleware's revalidation policy or an Express-generated ETag.
        res.removeHeader("ETag");
        res.end(serialized);
        return res;
      }
      const etag = `"${createHash("sha256").update(serialized).digest("base64url")}"`;
      res.setHeader("Cache-Control", "private, must-revalidate");
      res.setHeader("ETag", etag);
      if (matchesEtag(req.header("if-none-match"), etag)) {
        res.status(304).end();
        return res;
      }
      return originalSend(body);
    }) as typeof res.send;
    next();
  };
}
