import { readFileSync, statSync } from "node:fs";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * Forbidden-terms filter.
 *
 * When `PAPERCLIP_FORBIDDEN_TERMS_FILE` points to a UTF-8 file (one term per
 * line, `#` comments and blank lines ignored), issue text writes (comments,
 * issue title/description, issue documents and their revisions) that contain
 * one of the terms are refused. This turns "agents must not copy real names
 * into tickets" from a convention into an invariant.
 *
 * The matched term and the list contents are never returned to the caller nor
 * logged: only the field name and the character offset are.
 */

export const FORBIDDEN_TERMS_FILE_ENV = "PAPERCLIP_FORBIDDEN_TERMS_FILE";
export const FORBIDDEN_TERM_ERROR_CODE = "forbidden_term";
export const FORBIDDEN_TERMS_UNAVAILABLE_ERROR_CODE = "forbidden_terms_unavailable";
const MIN_TERM_LENGTH = 3;

const COMBINING_MARKS = /\p{M}+/gu;
const WHITESPACE = /\s/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function foldCodePoint(char: string): string {
  // Lowercasing can itself produce combining marks (e.g. U+0130), so strip
  // marks again after it.
  return char
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "");
}

/**
 * Case-folds, strips diacritics and collapses whitespace runs to one space.
 * `origin[i]` is the UTF-16 index in the input of folded unit `i`, so a match
 * can be reported against the text the author actually sent.
 */
function fold(text: string): { folded: string; origin: number[] } {
  const parts: string[] = [];
  const origin: number[] = [];
  let index = 0;
  let previousWasSpace = false;
  for (const char of text) {
    if (WHITESPACE.test(char)) {
      if (!previousWasSpace) {
        parts.push(" ");
        origin.push(index);
      }
      previousWasSpace = true;
    } else {
      const folded = foldCodePoint(char);
      for (let unit = 0; unit < folded.length; unit += 1) {
        parts.push(folded[unit]!);
        origin.push(index);
      }
      if (folded.length > 0) previousWasSpace = false;
    }
    index += char.length;
  }
  return { folded: parts.join(""), origin };
}

export function parseForbiddenTerms(content: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const term = fold(line).folded.trim();
    if ([...term].length < MIN_TERM_LENGTH || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function isWordCharBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(start)!));
}

function isWordCharAt(text: string, index: number): boolean {
  if (index >= text.length) return false;
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(index)!));
}

/**
 * Returns the offset (UTF-16 index in `text`) of the earliest whole-word match
 * of any already-folded term, or null. Terms come from `parseForbiddenTerms`.
 */
export function findForbiddenTerm(text: string, terms: readonly string[]): { offset: number } | null {
  if (!text || terms.length === 0) return null;
  const { folded, origin } = fold(text);
  let earliest = -1;
  for (const term of terms) {
    let from = 0;
    while (from <= folded.length - term.length) {
      const at = folded.indexOf(term, from);
      if (at < 0 || (earliest >= 0 && at >= earliest)) break;
      if (!isWordCharBefore(folded, at) && !isWordCharAt(folded, at + term.length)) {
        earliest = at;
        break;
      }
      from = at + 1;
    }
  }
  return earliest < 0 ? null : { offset: origin[earliest]! };
}

type CachedList = { path: string; mtimeMs: number; ctimeMs: number; size: number; ino: number; terms: string[] };
let cache: CachedList | null = null;

/** Test hook: forget the cached list so the next check re-reads the file. */
export function resetForbiddenTermsCache(): void {
  cache = null;
}

function loadTerms(path: string): string[] {
  // A stat per write keeps reloads immediate without a watcher; a failure here
  // (file removed, permissions) must not fall back to a stale cached list.
  const stat = statSync(path);
  if (
    cache &&
    cache.path === path &&
    cache.mtimeMs === stat.mtimeMs &&
    cache.ctimeMs === stat.ctimeMs &&
    cache.size === stat.size &&
    cache.ino === stat.ino
  ) {
    return cache.terms;
  }
  const terms = parseForbiddenTerms(readFileSync(path, "utf8"));
  cache = { path, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino, terms };
  return terms;
}

export type ForbiddenTermsField = { field: string; text: string | null | undefined };

export type ForbiddenTermsContext = {
  /** Which write path refused, for the server log (e.g. "issue_comment"). */
  surface: string;
  issueId?: string | null;
  companyId?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
};

/**
 * Throws a 422 `forbidden_term` HttpError when a field contains a listed term,
 * or a 503 `forbidden_terms_unavailable` when the filter is configured but its
 * list cannot be read (fail closed). No-op when the variable is unset.
 */
export function assertNoForbiddenTerms(
  fields: readonly ForbiddenTermsField[],
  context: ForbiddenTermsContext,
): void {
  const path = process.env[FORBIDDEN_TERMS_FILE_ENV]?.trim();
  if (!path) return;
  if (!fields.some((entry) => typeof entry.text === "string" && entry.text.length > 0)) return;

  let terms: string[];
  try {
    terms = loadTerms(path);
  } catch (error) {
    cache = null;
    logger.error(
      {
        surface: context.surface,
        issueId: context.issueId ?? null,
        errorCode: (error as NodeJS.ErrnoException | null)?.code ?? "unknown",
      },
      `Forbidden-terms filter: ${FORBIDDEN_TERMS_FILE_ENV} is set but the list cannot be read; refusing the write`,
    );
    throw new HttpError(
      503,
      "Refused: the forbidden-terms filter is enabled but its list cannot be read, so issue text writes are blocked until an operator fixes the server configuration.",
      { code: FORBIDDEN_TERMS_UNAVAILABLE_ERROR_CODE },
    );
  }

  for (const entry of fields) {
    if (typeof entry.text !== "string") continue;
    const match = findForbiddenTerm(entry.text, terms);
    if (!match) continue;
    logger.warn(
      {
        surface: context.surface,
        issueId: context.issueId ?? null,
        companyId: context.companyId ?? null,
        authorAgentId: context.authorAgentId ?? null,
        authorUserId: context.authorUserId ?? null,
        field: entry.field,
        offset: match.offset,
      },
      "Forbidden-terms filter refused an issue text write",
    );
    throw unprocessable(
      `Refused: this text contains a name from the forbidden-terms list (field "${entry.field}", match at character ${match.offset}). Replace real names with a code or a role and retry.`,
      { code: FORBIDDEN_TERM_ERROR_CODE, field: entry.field, offset: match.offset },
    );
  }
}
