import crypto from "node:crypto";

// Variables that change how the dynamic loader, a language runtime, or the shell wrapper itself
// behaves. Request-scoped overrides of these are never honored on a host (gateway or node).
const BLOCKED_HOST_ENV_KEYS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "ZDOTDIR",
  "GCONV_PATH",
  "SSLKEYLOGFILE",
]);

const BLOCKED_HOST_ENV_PREFIXES = ["DYLD_", "LD_", "BASH_FUNC_"];

export function isBlockedHostEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (BLOCKED_HOST_ENV_KEYS.has(upper)) {
    return true;
  }
  return BLOCKED_HOST_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Normalize caller-supplied env overrides for host execution: trim keys, keep string values only,
 * and drop blocked keys. Returns null when nothing remains, so callers can treat "no overrides"
 * uniformly regardless of how the caller spelled an empty env.
 */
export function sanitizeHostEnvOverrides(env: unknown): Record<string, string> | null {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return null;
  }
  const next: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(env as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || typeof value !== "string" || isBlockedHostEnvKey(key)) {
      continue;
    }
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function listHostEnvOverrideKeys(env: unknown): string[] {
  const overrides = sanitizeHostEnvOverrides(env);
  return overrides ? Object.keys(overrides).toSorted() : [];
}

/**
 * Stable digest of the env overrides a run will receive, used to bind an exec approval to the
 * exact environment that was approved. Null means "no overrides".
 */
export function computeHostEnvOverridesBinding(env: unknown): string | null {
  const overrides = sanitizeHostEnvOverrides(env);
  if (!overrides) {
    return null;
  }
  const entries = Object.entries(overrides).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
