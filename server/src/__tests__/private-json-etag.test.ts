import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { privateJsonEtag } from "../middleware/private-json-etag.js";

describe("privateJsonEtag", () => {
  it("returns 304 for unchanged private JSON and changes when the payload changes", async () => {
    let revision = 1;
    const app = express();
    app.get("/issue", privateJsonEtag(), (_req, res) => res.json({ revision }));

    const first = await request(app).get("/issue");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, must-revalidate");
    expect(first.headers.etag).toBeTruthy();

    const unchanged = await request(app).get("/issue").set("If-None-Match", first.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.text).toBe("");

    revision = 2;
    const changed = await request(app).get("/issue").set("If-None-Match", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
  });

  it("preserves explicit no-store for sensitive browser JSON", async () => {
    const app = express();
    app.get("/browser/screenshot", privateJsonEtag(), (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: "sensitive-image" });
    });
    const response = await request(app).get("/browser/screenshot");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBeUndefined();
  });
});
