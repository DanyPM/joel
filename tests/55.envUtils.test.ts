import { describe, it, expect } from "vitest";
import { parseBooleanEnv } from "../utils/env.utils.ts";

describe("parseBooleanEnv", () => {
  it("falls back when the variable is unset", () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv(undefined, false)).toBe(false);
  });

  it("falls back on an empty or whitespace value", () => {
    expect(parseBooleanEnv("", true)).toBe(true);
    expect(parseBooleanEnv("   ", true)).toBe(true);
  });

  it("reads the usual falsy spellings as false", () => {
    for (const value of ["false", "FALSE", "False", "0", "no", "off"]) {
      expect(parseBooleanEnv(value, true)).toBe(false);
    }
  });

  it("reads the usual truthy spellings as true", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(parseBooleanEnv(value, false)).toBe(true);
    }
  });

  it("falls back on a value it cannot interpret", () => {
    expect(parseBooleanEnv("maybe", true)).toBe(true);
    expect(parseBooleanEnv("maybe", false)).toBe(false);
  });
});

describe("missingEnvVars", () => {
  it("names the variables that are unset or empty", async () => {
    const { missingEnvVars } = await import("../utils/env.utils.ts");

    expect(
      missingEnvVars({ A: "set", B: undefined, C: "  ", D: "also set" })
    ).toEqual(["B", "C"]);
  });

  it("returns nothing when every variable is set", async () => {
    const { missingEnvVars } = await import("../utils/env.utils.ts");

    expect(missingEnvVars({ A: "x", B: "y" })).toEqual([]);
  });
});
