import { describe, expect, it } from "vitest";
import { WORKSPACE_ROLE_PERMISSIONS, ORG_ROLE_PERMISSIONS, type Role } from "@open-gpt-live/core";
import { NAV_GROUPS, tabOf, visibleNavGroups } from "./nav";
import { ADMIN_SECTIONS, SETTINGS_SECTIONS, paths, placeOf } from "./routes";

const roleCan = (role: Role) => {
  const granted = new Set<string>([...WORKSPACE_ROLE_PERMISSIONS[role], ...ORG_ROLE_PERMISSIONS[role]]);
  return (permission: string) => granted.has(permission);
};
const summary = (can: (permission: string) => boolean) =>
  visibleNavGroups(can).map((group) => [group.place, group.href, group.tabs.map((tab) => tab.id)]);

describe("rail groups", () => {
  it("puts every address in its group and tab", () => {
    const cases: Array<[string, string, string | null]> = [
      ["/", "chat", null],
      ["/c/abc", "chat", null],
      ["/agents", "agents", null],
      ["/agents/a1/computer", "agents", null],
      ["/meetings", "meetings", "meetings"],
      ["/meetings/m1", "meetings", "meetings"],
      ["/meetings/recordings", "meetings", "recordings"],
      ["/call/m1", "meetings", null],
      ["/library/slides", "spaces", "slides"],
      ["/media", "spaces", "media"],
      ["/media/x", "spaces", "media"],
      ["/knowledge", "library", "knowledge"],
      ["/skills", "library", "skills"],
      ["/skills/plugins", "library", "plugins"],
      ["/integrations", "library", "integrations"],
      ["/routines", "automations", "routines"],
      ["/monitors", "automations", "monitors"],
      ["/inbox", "inbox", null],
      ["/settings", "settings", null],
      ...SETTINGS_SECTIONS.map((section): [string, string, null] => [paths.settings(section), "settings", null]),
      ["/admin", "settings", null],
      ...ADMIN_SECTIONS.map((section): [string, string, null] => [paths.admin(section), "settings", null])
    ];
    for (const [address, group, tab] of cases) {
      expect([address, placeOf(address), tabOf(address)?.id ?? null]).toEqual([address, group, tab]);
    }
  });

  it("keeps every tab's address inside its own group", () => {
    for (const group of NAV_GROUPS) {
      if (group.href) expect(placeOf(group.href)).toBe(group.place);
      for (const tab of group.tabs ?? []) {
        expect(placeOf(tab.href)).toBe(group.place);
        expect(tabOf(tab.href)?.id).toBe(tab.id);
      }
    }
  });

  it("shows an owner every group and tab", () => {
    expect(summary(roleCan("owner"))).toEqual([
      ["chat", "/", []],
      ["agents", "/agents", []],
      ["meetings", "/meetings", ["meetings"]],
      ["spaces", "/library/slides", ["slides", "media"]],
      ["library", "/knowledge", ["knowledge", "skills", "plugins", "integrations"]],
      ["automations", "/routines", ["routines", "monitors"]],
      ["settings", "/settings", []]
    ]);
  });

  it("hides what a viewer can't use", () => {
    expect(summary(roleCan("viewer"))).toEqual([
      ["chat", "/", []],
      ["agents", "/agents", []],
      ["meetings", "/meetings", ["meetings"]],
      ["spaces", "/library/slides", ["slides", "media"]],
      ["library", "/knowledge", ["knowledge", "skills", "plugins"]],
      ["automations", "/routines", ["routines", "monitors"]],
      ["settings", "/settings", []]
    ]);
  });

  it("drops empty groups and opens a group on its first visible tab", () => {
    const only = (...granted: string[]) => (permission: string) => granted.includes(permission);
    expect(summary(only("monitors.use", "integrations.use"))).toEqual([
      ["chat", "/", []],
      ["library", "/integrations", ["integrations"]],
      ["automations", "/monitors", ["monitors"]],
      ["settings", "/settings", []]
    ]);
    expect(summary(() => false).map(([place]) => place)).toEqual(["chat", "settings"]);
  });
});

describe("enterprise tabs", () => {
  it("shows Recordings only with the recordings licence and calls.record", () => {
    const owner = roleCan("owner");
    const tabsOf = (hasFeature?: (feature: string) => boolean) =>
      visibleNavGroups(owner, hasFeature).find((group) => group.place === "meetings")!.tabs.map((tab) => tab.id);
    expect(tabsOf()).toEqual(["meetings"]);
    expect(tabsOf(() => false)).toEqual(["meetings"]);
    expect(tabsOf((feature) => feature === "recordings")).toEqual(["meetings", "recordings"]);
    const member = visibleNavGroups(roleCan("member"), () => true).find((group) => group.place === "meetings")!;
    expect(member.tabs.map((tab) => tab.id)).toEqual(["meetings"]);
  });
});
