import { describe, expect, it } from "vitest";
import { suggestOrgName } from "./naming";

describe("suggestOrgName", () => {
  it("uses the company domain", () => {
    expect(suggestOrgName({ email: "ann@acme.com" })).toBe("Acme");
    expect(suggestOrgName({ email: "ann@eu.acme.co.uk" })).toBe("Acme");
    expect(suggestOrgName({ email: "ann@northwind.io" })).toBe("Northwind");
  });
  it("uses the person's name for personal mail", () => {
    expect(suggestOrgName({ email: "ann.lee@gmail.com" })).toBe("Ann's team");
    expect(suggestOrgName({ email: "x@outlook.com", name: "Bo Chen" })).toBe("Bo's team");
  });
});
