/**
 * Per-binary argv policy for safe bins (stdin-only tools that run without an allowlist entry).
 *
 * Every option must be explicitly known for the binary; anything else (unknown flags, abbreviated
 * long options, options that read/write files, spawn programs, or change directories) is rejected
 * so the command falls back to the normal allowlist/approval flow.
 */

type ValueRule = RegExp | "literal";

type SafeBinProfile = {
  /** GNU getopt_long semantics, or jq's own argument parser. */
  parser: "getopt" | "jq";
  /** Short options without a value. */
  shortFlags: string;
  /** Short options with a required value (attached or next token). */
  shortValues?: Record<string, ValueRule>;
  /** Long options without a value. Matched exactly: getopt prefix abbreviations are rejected. */
  longFlags?: string[];
  /** Long options with a required value (`--name=value` or `--name value`). */
  longValues?: Record<string, ValueRule>;
  /** Long options with an optional value (only `--name=value`). */
  longOptionalValues?: Record<string, ValueRule>;
  /** jq-style long options that consume two following tokens. */
  longPairs?: Record<string, [ValueRule, ValueRule]>;
  /** Accept `-NUM` tokens (context/line counts). */
  numericShort?: boolean;
  /** Leading operands that are not files (grep pattern, jq filter, tr sets). */
  operands: number;
  /** Options that supply the first operand (for example grep -e), removing it from argv. */
  operandOptions?: string[];
  /** Whether `-` (stdin) is accepted where a file operand would go. */
  stdinOperand: boolean;
  /** Options stop at the first operand (getopt `+` optstring). */
  requireOrder?: boolean;
  /** Environment variables that change behavior; request-scoped overrides are rejected. */
  sensitiveEnv?: string[];
  /** Extra validation for non-file operands. */
  validateOperand?: (token: string) => boolean;
};

const NUM = /^\d+$/;
const SIGNED_COUNT = /^-?\d+[A-Za-z]*$/;
const TAIL_COUNT = /^[+-]?\d+[A-Za-z]*$/;
const CUT_LIST = /^[0-9,-]+$/;
const SINGLE_CHAR = /^[\s\S]$/;

// jq filters can read the environment or load .jq/.json files from arbitrary search paths
// (`import "x" as $x {search: "/dir"}`), so those builtins/directives need approval.
const JQ_FILTER_DENY = /(?<![.$\w])(?:env|import|include|modulemeta)(?!\w)|\$ENV(?!\w)/;

const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> = {
  jq: {
    parser: "jq",
    shortFlags: "acCejMnrRsS",
    longFlags: [
      "ascii-output",
      "color-output",
      "compact-output",
      "exit-status",
      "join-output",
      "monochrome-output",
      "null-input",
      "raw-input",
      "raw-output",
      "raw-output0",
      "seq",
      "slurp",
      "sort-keys",
      "stream",
      "stream-errors",
      "tab",
      "unbuffered",
    ],
    longValues: { indent: /^-?\d+$/ },
    longPairs: {
      arg: [/^[A-Za-z_][A-Za-z0-9_]*$/, "literal"],
      argjson: [/^[A-Za-z_][A-Za-z0-9_]*$/, "literal"],
    },
    operands: 1,
    stdinOperand: false,
    sensitiveEnv: ["HOME"],
    validateOperand: (token) => !JQ_FILTER_DENY.test(token),
  },
  grep: {
    parser: "getopt",
    shortFlags: "abcEFGHhiLlnoPqsTUvwxZz",
    shortValues: { A: NUM, B: NUM, C: NUM, m: NUM, e: "literal" },
    longFlags: [
      "basic-regexp",
      "binary",
      "byte-offset",
      "count",
      "extended-regexp",
      "files-with-matches",
      "files-without-match",
      "fixed-strings",
      "ignore-case",
      "initial-tab",
      "invert-match",
      "line-buffered",
      "line-number",
      "line-regexp",
      "no-filename",
      "no-group-separator",
      "no-ignore-case",
      "no-messages",
      "null",
      "null-data",
      "only-matching",
      "perl-regexp",
      "quiet",
      "silent",
      "text",
      "with-filename",
      "word-regexp",
    ],
    longValues: {
      "after-context": NUM,
      "before-context": NUM,
      "binary-files": /^(?:binary|text|without-match)$/,
      context: NUM,
      "group-separator": "literal",
      label: "literal",
      "max-count": NUM,
      regexp: "literal",
    },
    longOptionalValues: {
      color: /^(?:always|never|auto)$/,
      colour: /^(?:always|never|auto)$/,
    },
    numericShort: true,
    operands: 1,
    operandOptions: ["e", "regexp"],
    stdinOperand: true,
    sensitiveEnv: ["GREP_OPTIONS"],
  },
  cut: {
    parser: "getopt",
    shortFlags: "nsz",
    shortValues: { b: CUT_LIST, c: CUT_LIST, f: CUT_LIST, d: SINGLE_CHAR },
    longFlags: ["complement", "only-delimited", "zero-terminated"],
    longValues: {
      bytes: CUT_LIST,
      characters: CUT_LIST,
      fields: CUT_LIST,
      delimiter: SINGLE_CHAR,
      "output-delimiter": "literal",
    },
    operands: 0,
    stdinOperand: true,
  },
  sort: {
    parser: "getopt",
    shortFlags: "bcCdfghiMmnRrsuVz",
    shortValues: {
      k: /^\d+(?:\.\d+)?[bdfghiMnRrV]*(?:,\d+(?:\.\d+)?[bdfghiMnRrV]*)?$/,
      S: /^\d+(?:\.\d+)?[%bKkMmGgTtPpEeZzYyRrQq]?$/,
      t: /^(?:[\s\S]|\\0)$/,
    },
    longFlags: [
      "debug",
      "dictionary-order",
      "general-numeric-sort",
      "human-numeric-sort",
      "ignore-case",
      "ignore-leading-blanks",
      "ignore-nonprinting",
      "merge",
      "month-sort",
      "numeric-sort",
      "random-sort",
      "reverse",
      "stable",
      "unique",
      "version-sort",
      "zero-terminated",
    ],
    longValues: {
      "buffer-size": /^\d+(?:\.\d+)?[%bKkMmGgTtPpEeZzYyRrQq]?$/,
      "field-separator": /^(?:[\s\S]|\\0)$/,
      key: /^\d+(?:\.\d+)?[bdfghiMnRrV]*(?:,\d+(?:\.\d+)?[bdfghiMnRrV]*)?$/,
      parallel: NUM,
      sort: /^(?:general-numeric|human-numeric|month|numeric|random|version)$/,
    },
    longOptionalValues: { check: /^(?:quiet|silent|diagnose-first)$/ },
    operands: 0,
    stdinOperand: true,
    sensitiveEnv: ["TMPDIR"],
  },
  uniq: {
    parser: "getopt",
    shortFlags: "cdDiuz",
    shortValues: { f: NUM, s: NUM, w: NUM },
    longFlags: ["count", "ignore-case", "repeated", "unique", "zero-terminated"],
    longValues: { "check-chars": NUM, "skip-chars": NUM, "skip-fields": NUM },
    longOptionalValues: {
      "all-repeated": /^(?:none|prepend|separate)$/,
      group: /^(?:prepend|append|separate|both)$/,
    },
    operands: 0,
    stdinOperand: true,
  },
  head: {
    parser: "getopt",
    shortFlags: "qvz",
    shortValues: { c: SIGNED_COUNT, n: SIGNED_COUNT },
    longFlags: ["quiet", "silent", "verbose", "zero-terminated"],
    longValues: { bytes: SIGNED_COUNT, lines: SIGNED_COUNT },
    numericShort: true,
    operands: 0,
    stdinOperand: true,
  },
  tail: {
    parser: "getopt",
    shortFlags: "qvz",
    shortValues: { c: TAIL_COUNT, n: TAIL_COUNT },
    longFlags: ["quiet", "silent", "verbose", "zero-terminated"],
    longValues: { bytes: TAIL_COUNT, lines: TAIL_COUNT },
    numericShort: true,
    operands: 0,
    stdinOperand: true,
  },
  tr: {
    parser: "getopt",
    shortFlags: "cCdst",
    longFlags: ["complement", "delete", "squeeze-repeats", "truncate-set1"],
    operands: 2,
    stdinOperand: false,
    requireOrder: true,
  },
  wc: {
    parser: "getopt",
    shortFlags: "clLmw",
    longFlags: ["bytes", "chars", "lines", "max-line-length", "words"],
    longValues: { total: /^(?:auto|always|only|never)$/ },
    operands: 0,
    stdinOperand: true,
  },
};

// GNU getopt option ordering; also honored when the host itself sets it.
const GETOPT_ORDER_ENV = "POSIXLY_CORRECT";

export type SafeBinArgvCheck = {
  argv: string[];
  /** Validates operands and free-form option values (glob, path, and existence checks). */
  isSafeLiteral: (token: string) => boolean;
  /** Effective environment for the command; compared against the host process env. */
  env?: NodeJS.ProcessEnv;
};

function matchesRule(rule: ValueRule, value: string, isSafeLiteral: (v: string) => boolean) {
  if (rule === "literal") {
    return isSafeLiteral(value);
  }
  return rule.test(value);
}

function hasSensitiveEnvOverride(profile: SafeBinProfile, env?: NodeJS.ProcessEnv): boolean {
  if (!env || !profile.sensitiveEnv) {
    return false;
  }
  return profile.sensitiveEnv.some((key) => env[key] !== process.env[key]);
}

type ParseState = {
  operands: string[];
  operandSupplied: boolean;
};

/** Returns the number of extra argv tokens consumed, or null when the option is not allowed. */
function checkLongOption(
  profile: SafeBinProfile,
  token: string,
  next: string[],
  state: ParseState,
  isSafeLiteral: (v: string) => boolean,
): number | null {
  const body = token.slice(2);
  const eqIndex = profile.parser === "getopt" ? body.indexOf("=") : -1;
  const name = eqIndex >= 0 ? body.slice(0, eqIndex) : body;
  const attached = eqIndex >= 0 ? body.slice(eqIndex + 1) : undefined;
  if (profile.operandOptions?.includes(name)) {
    state.operandSupplied = true;
  }
  if (profile.longFlags?.includes(name)) {
    return attached === undefined ? 0 : null;
  }
  const optionalRule = profile.longOptionalValues?.[name];
  if (optionalRule) {
    return attached === undefined || matchesRule(optionalRule, attached, isSafeLiteral) ? 0 : null;
  }
  const valueRule = profile.longValues?.[name];
  if (valueRule) {
    if (attached !== undefined) {
      return matchesRule(valueRule, attached, isSafeLiteral) ? 0 : null;
    }
    const value = next[0];
    return value !== undefined && matchesRule(valueRule, value, isSafeLiteral) ? 1 : null;
  }
  const pairRules = profile.longPairs?.[name];
  if (pairRules && attached === undefined) {
    const [first, second] = [next[0], next[1]];
    if (first === undefined || second === undefined) {
      return null;
    }
    const ok =
      matchesRule(pairRules[0], first, isSafeLiteral) &&
      matchesRule(pairRules[1], second, isSafeLiteral);
    return ok ? 2 : null;
  }
  return null;
}

function checkShortCluster(
  profile: SafeBinProfile,
  token: string,
  next: string[],
  state: ParseState,
  isSafeLiteral: (v: string) => boolean,
): number | null {
  if (profile.numericShort && /^-\d+$/.test(token)) {
    return 0;
  }
  const chars = token.slice(1);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (profile.shortFlags.includes(ch)) {
      continue;
    }
    // jq has no short options with values; getopt takes the rest of the token or the next one.
    const rule = profile.parser === "getopt" ? profile.shortValues?.[ch] : undefined;
    if (!rule) {
      return null;
    }
    if (profile.operandOptions?.includes(ch)) {
      state.operandSupplied = true;
    }
    const attached = chars.slice(i + 1);
    if (attached) {
      return matchesRule(rule, attached, isSafeLiteral) ? 0 : null;
    }
    const value = next[0];
    return value !== undefined && matchesRule(rule, value, isSafeLiteral) ? 1 : null;
  }
  return 0;
}

function isOptionToken(profile: SafeBinProfile, token: string): boolean {
  if (profile.parser === "jq") {
    // jq only treats `-` followed by `-` or a letter as an option (see jq main.c isoptish).
    return /^-(?:-|[A-Za-z])/.test(token);
  }
  return token.length > 1 && token.startsWith("-");
}

/**
 * Returns true when every argv token (after argv[0]) is understood and safe for this safe bin.
 * Binaries without a built-in profile only accept operands (no options at all).
 */
export function isSafeBinArgvAllowed(execName: string, params: SafeBinArgvCheck): boolean {
  const profile = SAFE_BIN_PROFILES[execName];
  const args = params.argv.slice(1);
  const env = params.env;
  if (!profile) {
    return args.every(
      (token) => token === "-" || (!token.startsWith("-") && params.isSafeLiteral(token)),
    );
  }
  if (hasSensitiveEnvOverride(profile, env)) {
    return false;
  }
  const posixlyCorrect =
    profile.parser === "getopt" && (env ?? process.env)[GETOPT_ORDER_ENV] !== undefined;
  const stopAtOperand = profile.requireOrder === true || posixlyCorrect;

  const state: ParseState = { operands: [], operandSupplied: false };
  let optionsDone = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!optionsDone && token === "--") {
      optionsDone = true;
      continue;
    }
    if (optionsDone || !isOptionToken(profile, token)) {
      state.operands.push(token);
      if (stopAtOperand) {
        optionsDone = true;
      }
      continue;
    }
    const rest = args.slice(i + 1);
    const consumed = token.startsWith("--")
      ? checkLongOption(profile, token, rest, state, params.isSafeLiteral)
      : checkShortCluster(profile, token, rest, state, params.isSafeLiteral);
    if (consumed === null) {
      return false;
    }
    i += consumed;
  }

  const literalOperands = state.operandSupplied
    ? Math.max(0, profile.operands - 1)
    : profile.operands;
  for (let i = 0; i < state.operands.length; i += 1) {
    const token = state.operands[i];
    if (i < literalOperands) {
      if (!params.isSafeLiteral(token)) {
        return false;
      }
      if (profile.validateOperand && !profile.validateOperand(token)) {
        return false;
      }
      continue;
    }
    // Remaining operands are file names for every profiled bin; only stdin is allowed.
    if (!(profile.stdinOperand && token === "-")) {
      return false;
    }
  }
  return true;
}
