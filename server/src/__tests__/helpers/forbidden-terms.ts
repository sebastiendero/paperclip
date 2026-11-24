import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { HttpError } from "../../errors.js";
import {
  FORBIDDEN_TERM_ERROR_CODE,
  FORBIDDEN_TERMS_FILE_ENV,
  resetForbiddenTermsCache,
} from "../../services/forbidden-terms.js";

// Invented names only.
export const FORBIDDEN_TEST_TERM = "Zéphirine Duploux";
export const FORBIDDEN_TEST_TEXT = "Ask zephirine DUPLOUX for the invoice";
// Distinctive fragments that must never appear in what a refused caller sees.
const LEAK_MARKERS = ["zephirine", "zéphirine", "duploux"];

/** Points the filter at a temp list holding FORBIDDEN_TEST_TERM; returns the restore function. */
export function enableForbiddenTermsForTest(): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-forbidden-terms-test-"));
  const file = path.join(dir, "terms.txt");
  writeFileSync(file, `# test list\n${FORBIDDEN_TEST_TERM}\n`, "utf8");
  const previous = process.env[FORBIDDEN_TERMS_FILE_ENV];
  process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
  resetForbiddenTermsCache();
  return () => {
    if (previous === undefined) delete process.env[FORBIDDEN_TERMS_FILE_ENV];
    else process.env[FORBIDDEN_TERMS_FILE_ENV] = previous;
    resetForbiddenTermsCache();
    rmSync(dir, { recursive: true, force: true });
  };
}

export function expectNoForbiddenTermLeak(value: unknown): void {
  const serialized = (typeof value === "string" ? value : JSON.stringify(value)).toLowerCase();
  for (const marker of LEAK_MARKERS) expect(serialized).not.toContain(marker);
}

/** HTTP response refused by the filter: 422, stable code, no term in the body. */
export function expectForbiddenTermResponse(res: { status: number; body: unknown; text?: string }): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  const body = res.body as { details?: { code?: string }; code?: string };
  expect(body.details?.code ?? body.code).toBe(FORBIDDEN_TERM_ERROR_CODE);
  expectNoForbiddenTermLeak(res.text ?? res.body);
}

/** Service call refused by the filter: a 422 HttpError whose message and details omit the term. */
export async function expectForbiddenTermRejection(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  expect(httpError.status).toBe(422);
  expect((httpError.details as { code?: string } | undefined)?.code).toBe(FORBIDDEN_TERM_ERROR_CODE);
  expectNoForbiddenTermLeak({ message: httpError.message, details: httpError.details });
}
