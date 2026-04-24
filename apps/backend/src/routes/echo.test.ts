import { describe, expect, it } from "vitest";
import {
  isSafeBatchFilePath,
  isSafeWorkspacePath,
  sanitizeLanguage,
} from "./echo.js";

describe("sanitizeLanguage", () => {
  it("null → null", () => {
    expect(sanitizeLanguage(null)).toBeNull();
  });
  it("undefined → null", () => {
    expect(sanitizeLanguage(undefined)).toBeNull();
  });
  it("non-string (42) → null", () => {
    expect(sanitizeLanguage(42)).toBeNull();
  });
  it("non-string ({}) → null", () => {
    expect(sanitizeLanguage({})).toBeNull();
  });
  it("'plaintext' is explicitly rejected", () => {
    expect(sanitizeLanguage("plaintext")).toBeNull();
  });
  it("'typescript' passes through", () => {
    expect(sanitizeLanguage("typescript")).toBe("typescript");
  });
  it("'javascript' passes through", () => {
    expect(sanitizeLanguage("javascript")).toBe("javascript");
  });
  it("'c-sharp' (hyphen) passes through", () => {
    expect(sanitizeLanguage("c-sharp")).toBe("c-sharp");
  });
  it("'go' (short) passes through", () => {
    expect(sanitizeLanguage("go")).toBe("go");
  });
  it("'C++' is rejected (uppercase + plus)", () => {
    expect(sanitizeLanguage("C++")).toBeNull();
  });
  it("'rust!' is rejected (bang)", () => {
    expect(sanitizeLanguage("rust!")).toBeNull();
  });
  it("'' is rejected", () => {
    expect(sanitizeLanguage("")).toBeNull();
  });
  it("'1python' is rejected (starts with digit)", () => {
    expect(sanitizeLanguage("1python")).toBeNull();
  });
  it("32-char identifier is accepted (regex allows {0,31} after lead)", () => {
    const s = "a".repeat(32);
    expect(sanitizeLanguage(s)).toBe(s);
  });
  it("33-char identifier is rejected", () => {
    expect(sanitizeLanguage("a".repeat(33))).toBeNull();
  });
});

describe("isSafeWorkspacePath", () => {
  it("empty string → false", () => {
    expect(isSafeWorkspacePath("")).toBe(false);
  });
  it("2001-char string → false", () => {
    expect(isSafeWorkspacePath("a".repeat(2001))).toBe(false);
  });
  it("null byte → false", () => {
    expect(isSafeWorkspacePath("foo\0bar")).toBe(false);
  });
  it("'../secrets' → false (unix traversal)", () => {
    expect(isSafeWorkspacePath("../secrets")).toBe(false);
  });
  it("'foo/../bar' → false", () => {
    expect(isSafeWorkspacePath("foo/../bar")).toBe(false);
  });
  it("'foo\\..\\bar' → false (windows traversal)", () => {
    expect(isSafeWorkspacePath("foo\\..\\bar")).toBe(false);
  });
  it("regular unix path → true", () => {
    expect(isSafeWorkspacePath("/Users/me/proj/foo.ts")).toBe(true);
  });
  it("regular windows path → true", () => {
    expect(isSafeWorkspacePath("C:\\Users\\proj\\foo.ts")).toBe(true);
  });
  it("non-string → false", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSafeWorkspacePath(123 as any)).toBe(false);
  });
});

describe("isSafeBatchFilePath", () => {
  it("file under workspace with separator → true", () => {
    expect(isSafeBatchFilePath("/a/b", "/a/b/c.ts")).toBe(true);
  });
  it("exact workspace match → true", () => {
    expect(isSafeBatchFilePath("/a/b", "/a/b")).toBe(true);
  });
  it("prefix-but-not-child (/a/bfoo) → false", () => {
    expect(isSafeBatchFilePath("/a/b", "/a/bfoo/c.ts")).toBe(false);
  });
  it("workspace with trailing slash, file under → true", () => {
    expect(isSafeBatchFilePath("/a/b/", "/a/b/c.ts")).toBe(true);
  });
  it("file outside workspace → false", () => {
    expect(isSafeBatchFilePath("/a/b", "/x/y.ts")).toBe(false);
  });
  it("windows paths under workspace → true", () => {
    expect(isSafeBatchFilePath("C:\\proj", "C:\\proj\\x.ts")).toBe(true);
  });
  it("traversal in file path → false regardless of workspace", () => {
    expect(isSafeBatchFilePath("/a/b", "/a/b/../etc/passwd")).toBe(false);
  });
  it("null byte in file path → false", () => {
    expect(isSafeBatchFilePath("/a/b", "/a/b/x\0.ts")).toBe(false);
  });
});
