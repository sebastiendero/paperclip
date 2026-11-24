import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  FORBIDDEN_TERM_ERROR_CODE,
  FORBIDDEN_TERMS_FILE_ENV,
  FORBIDDEN_TERMS_UNAVAILABLE_ERROR_CODE,
  assertNoForbiddenTerms,
  findForbiddenTerm,
  parseForbiddenTerms,
  resetForbiddenTermsCache,
} from "../services/forbidden-terms.js";

// Invented names only: these fixtures must never contain a real person,
// restaurant or supplier.
const LIST = [
  "# Fictional people",
  "Zéphirine Duploux",
  "",
  "   ",
  "# Fictional venues and suppliers",
  "Bistrot Imaginaire",
  "Ana",
  "Xo",
  "Maraîcher Fantôme",
].join("\n");

function capture(fn: () => void): HttpError | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
}

describe("parseForbiddenTerms", () => {
  it("ignores blank lines, # comments and terms shorter than 3 characters", () => {
    expect(parseForbiddenTerms(LIST)).toEqual([
      "zephirine duploux",
      "bistrot imaginaire",
      "ana",
      "maraicher fantome",
    ]);
  });

  it("accepts CRLF files and collapses inner whitespace", () => {
    expect(parseForbiddenTerms("Bistrot   Imaginaire\r\n\tAna\t\r\n")).toEqual([
      "bistrot imaginaire",
      "ana",
    ]);
  });
});

describe("findForbiddenTerm", () => {
  const terms = parseForbiddenTerms(LIST);

  it("matches case-insensitively", () => {
    expect(findForbiddenTerm("lunch at BISTROT imaginaire today", terms)).toEqual({ offset: 9 });
  });

  it("matches accent-insensitively in both directions", () => {
    expect(findForbiddenTerm("Ask zephirine duploux", terms)).toEqual({ offset: 4 });
    expect(findForbiddenTerm("Delivery from MARAICHER FANTÔME", terms)).toEqual({ offset: 14 });
    // Already-decomposed input (e + combining acute) still matches.
    expect(findForbiddenTerm("Zéphirine Duploux called", terms)).toEqual({ offset: 0 });
  });

  it("matches across line breaks and repeated spaces between words", () => {
    expect(findForbiddenTerm("see Bistrot\n  Imaginaire", terms)).toEqual({ offset: 4 });
  });

  it("only matches whole words", () => {
    expect(findForbiddenTerm("a banana split", terms)).toBeNull();
    expect(findForbiddenTerm("Anatole and Ana2", terms)).toBeNull();
    expect(findForbiddenTerm("ping Ana.", terms)).toEqual({ offset: 5 });
    expect(findForbiddenTerm("(Ana)", terms)).toEqual({ offset: 1 });
    expect(findForbiddenTerm("Ana", terms)).toEqual({ offset: 0 });
  });

  it("ignores terms shorter than 3 characters", () => {
    expect(findForbiddenTerm("Xo was here", terms)).toBeNull();
  });

  it("reports the earliest match in the original text", () => {
    expect(findForbiddenTerm("é Ana then Bistrot Imaginaire", terms)).toEqual({ offset: 2 });
  });

  it("returns null for clean text", () => {
    expect(findForbiddenTerm("Supplier S1 delivered to restaurant R2", terms)).toBeNull();
  });
});

describe("assertNoForbiddenTerms", () => {
  let dir: string;
  let file: string;
  const previous = process.env[FORBIDDEN_TERMS_FILE_ENV];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "paperclip-forbidden-terms-"));
    file = path.join(dir, "terms.txt");
    writeFileSync(file, LIST, "utf8");
    resetForbiddenTermsCache();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[FORBIDDEN_TERMS_FILE_ENV];
    else process.env[FORBIDDEN_TERMS_FILE_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
    resetForbiddenTermsCache();
  });

  it("is disabled when the variable is unset", () => {
    delete process.env[FORBIDDEN_TERMS_FILE_ENV];
    expect(() =>
      assertNoForbiddenTerms([{ field: "body", text: "Zéphirine Duploux" }], { surface: "test" }),
    ).not.toThrow();
  });

  it("refuses with 422 and a stable code without echoing the term", () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    const error = capture(() =>
      assertNoForbiddenTerms(
        [
          { field: "title", text: "Weekly review" },
          { field: "body", text: "Call zephirine DUPLOUX tomorrow" },
        ],
        { surface: "test", issueId: "issue-1" },
      ),
    );
    expect(error?.status).toBe(422);
    expect(error?.details).toEqual({ code: FORBIDDEN_TERM_ERROR_CODE, field: "body", offset: 5 });
    expect(error?.message).toContain("character 5");
    expect(error?.message.toLowerCase()).not.toContain("zephirine");
    expect(error?.message.toLowerCase()).not.toContain("duploux");
  });

  it("accepts clean text and null/undefined fields", () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    expect(() =>
      assertNoForbiddenTerms(
        [
          { field: "body", text: "Supplier S1 is late" },
          { field: "description", text: null },
          { field: "title", text: undefined },
        ],
        { surface: "test" },
      ),
    ).not.toThrow();
  });

  it("fails closed when the configured file cannot be read", () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = path.join(dir, "missing.txt");
    const error = capture(() =>
      assertNoForbiddenTerms([{ field: "body", text: "anything" }], { surface: "test" }),
    );
    expect(error?.status).toBe(503);
    expect(error?.details).toEqual({ code: FORBIDDEN_TERMS_UNAVAILABLE_ERROR_CODE });
  });

  it("fails closed when a previously readable file becomes unreadable", () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    expect(() => assertNoForbiddenTerms([{ field: "body", text: "ok" }], { surface: "test" })).not.toThrow();
    rmSync(file);
    const error = capture(() =>
      assertNoForbiddenTerms([{ field: "body", text: "ok" }], { surface: "test" }),
    );
    expect(error?.status).toBe(503);
  });

  it.skipIf(process.getuid?.() === 0)("fails closed when the file exists but is not readable", () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    chmodSync(file, 0o000);
    const error = capture(() =>
      assertNoForbiddenTerms([{ field: "body", text: "ok" }], { surface: "test" }),
    );
    chmodSync(file, 0o600);
    expect(error?.status).toBe(503);
  });

  it("reloads the list when the file changes, without a restart", () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    expect(() =>
      assertNoForbiddenTerms([{ field: "body", text: "Traiteur Chimérique" }], { surface: "test" }),
    ).not.toThrow();
    writeFileSync(file, `${LIST}\nTraiteur Chimérique\n`, "utf8");
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const error = capture(() =>
      assertNoForbiddenTerms([{ field: "body", text: "Traiteur Chimérique" }], { surface: "test" }),
    );
    expect(error?.status).toBe(422);
  });

  it("renders as a 422 JSON response with the stable code and no term", async () => {
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    const app = express();
    app.use(express.json());
    app.post("/comments", (req, _res, next) => {
      try {
        assertNoForbiddenTerms([{ field: "body", text: req.body.body }], { surface: "test" });
        _res.status(201).json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);

    const refused = await request(app).post("/comments").send({ body: "Dinner at Bistrot Imaginaire" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe(FORBIDDEN_TERM_ERROR_CODE);
    expect(refused.body.error).toContain("character 10");
    expect(JSON.stringify(refused.body).toLowerCase()).not.toContain("imaginaire");

    const accepted = await request(app).post("/comments").send({ body: "Dinner at restaurant R1" });
    expect(accepted.status).toBe(201);
  });
});
