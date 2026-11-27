export type AllowlistMatchSource =
  | "wildcard"
  | "id"
  | "name"
  | "tag"
  | "username"
  | "prefixed-id"
  | "prefixed-user"
  | "prefixed-name"
  | "slug"
  | "localpart";

export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;
};

export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

/**
 * Matches only the sender's stable id (or a wildcard). Display names are not
 * unique and are often user-controlled, so they must never authorize a sender.
 */
export function resolveAllowlistMatchSimple(params: {
  allowFrom: Array<string | number>;
  senderId: string;
}): AllowlistMatch<"wildcard" | "id"> {
  const allowFrom = params.allowFrom
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);

  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = params.senderId.toLowerCase();
  if (allowFrom.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }

  return { allowed: false };
}
