// Policy for request-scoped env overrides (model/agent supplied) on non-sandboxed exec hosts.
//
// Two tiers:
// - Blocked: keys that change how a shell, loader, VCS or interpreter finds/loads code.
//   These are rejected even when a human approved the command.
// - Safe: display/locale keys that cannot load code. Only these may ride along with a command that
//   the allowlist/safe-bins auto-approved. Every other key is treated as an allowlist miss so a human
//   sees (and approves) the env together with the command.

// Portable env names only. Rejects bash exported functions (`BASH_FUNC_name%%`) and any other key
// with characters a shell would never produce from a normal assignment.
const HOST_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HOST_ENV_BLOCKED_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "ZDOTDIR",
  "ENV",
  "BASH_ENV",
  "SHELL",
  "SHELLOPTS",
  "BASHOPTS",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "INPUTRC",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PERL5LIB",
  "PERLLIB",
  "PERL5DB",
  "RUBYLIB",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_GEMFILE",
  "LUA_INIT",
  "LUA_PATH",
  "LUA_CPATH",
  "TCLLIBPATH",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "CLASSPATH",
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "SSLKEYLOGFILE",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "CURL_HOME",
  "WGETRC",
  "PAGER",
  "MANPAGER",
  "LESSOPEN",
  "LESSCLOSE",
  "EDITOR",
  "VISUAL",
  "BROWSER",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "ELECTRON_RUN_AS_NODE",
]);

const HOST_ENV_BLOCKED_PREFIXES = [
  "DYLD_",
  "LD_",
  "BASH_FUNC_",
  "GIT_",
  "NPM_CONFIG_",
  "COMPLUS_",
  "CORECLR_",
  "DOTNET_",
  "_JAVA_",
];

// Catches interpreter/tool option hooks such as NODE_OPTIONS, JAVA_TOOL_OPTIONS, PERL5OPT, RUBYOPT,
// MAVEN_OPTS and GOFLAGS without having to enumerate every tool.
const HOST_ENV_BLOCKED_SUFFIXES = ["OPT", "OPTS", "OPTIONS", "FLAGS", "HOOKS"];

const HOST_ENV_SAFE_KEYS = new Set([
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLUMNS",
  "LINES",
]);

const HOST_ENV_SAFE_VALUE_RE = /^[A-Za-z0-9_.,:@+-]{0,128}$/;
// TZ names contain "/" (e.g. Europe/Berlin); refuse absolute/relative file paths.
const HOST_ENV_SAFE_TZ_RE = /^[A-Za-z0-9_+<-][A-Za-z0-9_.,:@+<>/-]{0,127}$/;

export function isBlockedHostEnvKey(rawKey: string): boolean {
  const key = rawKey.trim();
  if (!HOST_ENV_NAME_RE.test(key)) {
    return true;
  }
  const upper = key.toUpperCase();
  if (HOST_ENV_BLOCKED_KEYS.has(upper)) {
    return true;
  }
  if (HOST_ENV_BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return true;
  }
  return HOST_ENV_BLOCKED_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

export function isBlockedHostEnvValue(value: string): boolean {
  // Legacy bash (pre-shellshock fixes) imports any value starting with "() {" as a function.
  return value.includes("\0") || value.trimStart().startsWith("()");
}

export function isBlockedHostEnvEntry(key: string, value: string): boolean {
  return isBlockedHostEnvKey(key) || isBlockedHostEnvValue(value);
}

export function isSafeHostEnvEntry(rawKey: string, value: string): boolean {
  const key = rawKey.trim();
  if (isBlockedHostEnvEntry(key, value)) {
    return false;
  }
  // Locale/terminfo/zoneinfo lookups treat values as names under a data dir; no traversal.
  if (value.includes("..")) {
    return false;
  }
  const upper = key.toUpperCase();
  if (upper === "TZ") {
    return value === "" || HOST_ENV_SAFE_TZ_RE.test(value);
  }
  if (!HOST_ENV_SAFE_KEYS.has(upper) && !upper.startsWith("LC_")) {
    return false;
  }
  return HOST_ENV_SAFE_VALUE_RE.test(value);
}

/** True when the overrides contain anything beyond the safe display/locale keys. */
export function hostEnvOverridesRequireApproval(env?: Record<string, string> | null): boolean {
  if (!env) {
    return false;
  }
  return Object.entries(env).some(([key, value]) => !isSafeHostEnvEntry(key, String(value)));
}

/** Drop blocked keys; returns only the overrides that may be applied on the host. */
export function filterHostEnvOverrides(
  env?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(env)) {
    const key = rawKey.trim();
    const value = String(rawValue);
    if (!key || isBlockedHostEnvEntry(key, value)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** Canonical form used to bind an approval to the exact env it was granted for. */
export function canonicalizeHostEnvOverrides(env?: unknown): string {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return "";
  }
  const entries = Object.entries(env as Record<string, unknown>)
    .map(([key, value]) => [key, String(value)] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "" : JSON.stringify(entries);
}
