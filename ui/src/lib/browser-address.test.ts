import { describe, expect, it } from "vitest";
import { resolveBrowserAddress } from "./browser-address";

describe("browser address bar", () => {
  it("searches for a word instead of opening it as a hostname", () => {
    expect(resolveBrowserAddress("google")).toBe("https://duckduckgo.com/?q=google");
  });

  it("searches for phrases with URL encoding", () => {
    expect(resolveBrowserAddress("restaurants near me")).toBe(
      "https://duckduckgo.com/?q=restaurants+near+me",
    );
  });

  it("opens domain names and explicit addresses directly", () => {
    expect(resolveBrowserAddress("google.com")).toBe("https://google.com");
    expect(resolveBrowserAddress("https://example.com/path")).toBe("https://example.com/path");
    expect(resolveBrowserAddress("http://localhost:3000")).toBe("http://localhost:3000");
  });
});
