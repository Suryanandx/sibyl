import { describe, expect, it } from "vitest";
import { chatPath, conversationIdOf, isChatPath, legacyRedirect, placeOf } from "./routes";

const at = (url: string) => {
  const parsed = new URL(url, "http://sibyl.test");
  return { pathname: parsed.pathname, search: parsed.search };
};

describe("routes", () => {
  it("knows the rail group of every address", () => {
    expect(placeOf("/")).toBe("chat");
    expect(placeOf("/c/abc_1")).toBe("chat");
    expect(placeOf("/agents")).toBe("agents");
    expect(placeOf("/agents/a1/computer")).toBe("agents");
    expect(placeOf("/meetings")).toBe("meetings");
    expect(placeOf("/meetings/m1")).toBe("meetings");
    expect(placeOf("/call/m1")).toBe("meetings");
    expect(placeOf("/library/slides")).toBe("spaces");
    expect(placeOf("/media")).toBe("spaces");
    expect(placeOf("/media/item1")).toBe("spaces");
    expect(placeOf("/knowledge")).toBe("library");
    expect(placeOf("/skills")).toBe("library");
    expect(placeOf("/skills/plugins")).toBe("library");
    expect(placeOf("/integrations")).toBe("library");
    expect(placeOf("/routines")).toBe("automations");
    expect(placeOf("/monitors")).toBe("automations");
    expect(placeOf("/inbox")).toBe("inbox");
    expect(placeOf("/settings")).toBe("settings");
    expect(placeOf("/settings/usage")).toBe("settings");
    expect(placeOf("/admin")).toBe("settings");
    expect(placeOf("/admin/audit")).toBe("settings");
    // Not app places (inherited object keys must not match).
    expect(placeOf("/constructor")).toBeNull();
    expect(placeOf("/toString")).toBeNull();
    // The guest link stands alone (no account, no frame).
    expect(placeOf("/join/m1")).toBeNull();
    expect(placeOf("/login")).toBeNull();
    expect(placeOf("/nope")).toBeNull();
  });

  it("reads and builds chat addresses", () => {
    expect(conversationIdOf("/c/xyz")).toBe("xyz");
    expect(conversationIdOf("/c/xyz/")).toBe("xyz");
    expect(conversationIdOf("/c/a/b")).toBeNull();
    expect(isChatPath("/c/a/b")).toBe(false);
    expect(chatPath(null)).toBe("/");
    expect(chatPath("xyz")).toBe("/c/xyz");
  });

  it("redirects old ?panel= links to screens", () => {
    expect(legacyRedirect(at("/"))).toBeNull();
    expect(legacyRedirect(at("/?panel=routines"))).toEqual({ to: "/routines" });
    expect(legacyRedirect(at("/?open=inbox"))).toEqual({ to: "/inbox" });
    expect(legacyRedirect(at("/?panel=connections"))).toEqual({ to: "/integrations" });
    expect(legacyRedirect(at("/?panel=secrets"))).toEqual({ to: "/settings/secrets" });
    expect(legacyRedirect(at("/?panel=settings"))).toEqual({ to: "/settings/models" });
    expect(legacyRedirect(at("/?panel=settings&tab=usage"))).toEqual({ to: "/settings/usage" });
    expect(legacyRedirect(at("/?panel=settings&tab=presets"))).toEqual({ to: "/settings/models" });
    expect(legacyRedirect(at("/c/abc?panel=inbox"))).toEqual({ to: "/inbox", conversationId: "abc" });
    expect(legacyRedirect(at("/?panel=history"))).toEqual({ to: "/", openHistory: true });
    expect(legacyRedirect(at("/c/abc?panel=history"))).toEqual({ to: "/c/abc", openHistory: true, conversationId: "abc" });
    expect(legacyRedirect(at("/c/abc?panel=bogus"))).toEqual({ to: "/c/abc", conversationId: "abc" });
  });
});
