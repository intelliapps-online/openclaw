import { describe, expect, it } from "vitest";
import {
  normalizeAllowList,
  normalizeAllowListLower,
  normalizeSlackSlug,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "./allow-list.js";

describe("slack/allow-list", () => {
  it("normalizes lists and slugs", () => {
    expect(normalizeAllowList(["  Alice  ", 7, "", "  "])).toEqual(["Alice", "7"]);
    expect(normalizeAllowListLower(["  Alice  ", 7])).toEqual(["alice", "7"]);
    expect(normalizeSlackSlug(" Team Space  ")).toBe("team-space");
    expect(normalizeSlackSlug(" #Ops.Room ")).toBe("#ops.room");
  });

  it("matches wildcard, id, and prefixed id candidates", () => {
    expect(resolveSlackAllowListMatch({ allowList: ["*"], id: "u1" })).toEqual({
      allowed: true,
      matchKey: "*",
      matchSource: "wildcard",
    });

    expect(resolveSlackAllowListMatch({ allowList: ["u1"], id: "U1" })).toEqual({
      allowed: true,
      matchKey: "u1",
      matchSource: "id",
    });

    expect(resolveSlackAllowListMatch({ allowList: ["slack:u1"], id: "U1" })).toEqual({
      allowed: true,
      matchKey: "slack:u1",
      matchSource: "prefixed-id",
    });
  });

  it("ignores name entries that do not equal the sender id", () => {
    expect(
      resolveSlackAllowListMatch({ allowList: ["alice", "slack:alice", "alice-smith"], id: "u2" }),
    ).toEqual({ allowed: false });
  });

  it("allows all users when allowList is empty and denies unknown entries", () => {
    expect(resolveSlackUserAllowed({ allowList: [], userId: "u1" })).toBe(true);
    expect(resolveSlackUserAllowed({ allowList: ["u2"], userId: "u1" })).toBe(false);
  });
});
