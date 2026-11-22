import { describe, expect, it } from "vitest";
import { excerptOf } from "@/core/reader";

describe("release excerpts on cards", () => {
  it("returns a short opening unchanged and nothing for an empty body", () => {
    expect(excerptOf("  India has crossed one crore HPV vaccine doses.\n\n")).toBe("India has crossed one crore HPV vaccine doses.");
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf("   ")).toBeNull();
  });

  it("cuts at the first sentence end in range, ignoring honorifics", () => {
    const body = `Union Health Secretary Smt. Punya Salila Srivastava today launched NCG VISHWAS, a patient education initiative of the National Cancer Grid. ${"Addressing the sessions, she highlighted digital health. ".repeat(6)}`;
    expect(excerptOf(body)).toBe("Union Health Secretary Smt. Punya Salila Srivastava today launched NCG VISHWAS, a patient education initiative of the National Cancer Grid.");
  });

  it("cuts at a word with an ellipsis when no sentence ends in range", () => {
    const out = excerptOf(`The Ministry ${"of Health and Family Welfare, ".repeat(20)}`)!;
    expect(out.length).toBeLessThanOrEqual(221);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\s,]…$/);
  });
});
