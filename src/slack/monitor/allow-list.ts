import type { AllowlistMatch } from "../../channels/allowlist-match.js";
import {
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../shared/string-normalization.js";

export function normalizeSlackSlug(raw?: string) {
  return normalizeHyphenSlug(raw);
}

export function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}

export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeStringEntriesLower(list);
}

export type SlackAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user"
>;

/**
 * Slack display names, full names, and usernames are editable by every member and are not
 * unique, so user allowlists only match on the sender's user id. Name entries in config are
 * resolved to ids once at startup (see provider.ts).
 */
export function resolveSlackAllowListMatch(params: {
  allowList: string[];
  id?: string;
}): SlackAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) {
    return { allowed: false };
  }
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const id = params.id?.trim().toLowerCase();
  const candidates: Array<{ value?: string; source: SlackAllowListMatch["matchSource"] }> = [
    { value: id, source: "id" },
    { value: id ? `slack:${id}` : undefined, source: "prefixed-id" },
    { value: id ? `user:${id}` : undefined, source: "prefixed-user" },
  ];
  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }
    if (allowList.includes(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function allowListMatches(params: { allowList: string[]; id?: string }) {
  return resolveSlackAllowListMatch(params).allowed;
}

export function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  userId?: string;
}) {
  const allowList = normalizeAllowListLower(params.allowList);
  if (allowList.length === 0) {
    return true;
  }
  return allowListMatches({
    allowList,
    id: params.userId,
  });
}
