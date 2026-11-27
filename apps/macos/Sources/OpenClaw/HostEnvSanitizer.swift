import Foundation

enum HostEnvSanitizer {
    // Variables that change how the dynamic loader, a language runtime, or the shell wrapper itself
    // behaves. Request-scoped overrides of these are never honored. Keep in sync with
    // src/infra/host-env-security.ts.
    private static let blockedKeys: Set<String> = [
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
    ]

    private static let blockedPrefixes: [String] = [
        "DYLD_",
        "LD_",
        "BASH_FUNC_",
    ]

    /// Caller-supplied overrides that survive filtering, keyed by trimmed name.
    static func overrides(_ env: [String: String]?) -> [String: String] {
        guard let env else { return [:] }
        var result: [String: String] = [:]
        for (rawKey, value) in env {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            if self.blockedKeys.contains(upper) { continue }
            if self.blockedPrefixes.contains(where: { upper.hasPrefix($0) }) { continue }
            result[key] = value
        }
        return result
    }

    static func overrideKeys(_ env: [String: String]?) -> [String] {
        self.overrides(env).keys.sorted()
    }

    /// Process environment with the filtered overrides applied, or nil when no env was supplied.
    static func merged(_ env: [String: String]?) -> [String: String]? {
        guard env != nil else { return nil }
        var merged = ProcessInfo.processInfo.environment
        for (key, value) in self.overrides(env) {
            merged[key] = value
        }
        return merged
    }
}
