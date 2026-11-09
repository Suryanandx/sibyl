import { describe, expect, it } from "vitest";
import { pageLinkOf } from "./tool-loop.js";

describe("pageLinkOf (the page a tool read, for the chat's side panel)", () => {
  it("prefers the final URL after redirects and keeps the title", () => {
    expect(pageLinkOf({ url: "http://example.com", finalUrl: "https://example.com/", title: " Example Domain " })).toEqual({
      url: "https://example.com/",
      title: "Example Domain"
    });
  });

  it("falls back to the asked URL", () => {
    expect(pageLinkOf({ url: "https://example.org/a?b=1" })).toEqual({ url: "https://example.org/a?b=1" });
  });

  it("ignores anything that is not an http(s) page", () => {
    expect(pageLinkOf(undefined)).toBeUndefined();
    expect(pageLinkOf("https://example.com")).toBeUndefined();
    expect(pageLinkOf({ url: "javascript:alert(1)" })).toBeUndefined();
    expect(pageLinkOf({ url: "file:///etc/passwd" })).toBeUndefined();
    expect(pageLinkOf({ url: "not a url" })).toBeUndefined();
    expect(pageLinkOf({ results: [] })).toBeUndefined();
  });
});
