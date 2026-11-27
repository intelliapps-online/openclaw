import { describe, expect, it } from "vitest";
import { evaluateShellAllowlist, type ExecAllowlistEntry } from "./exec-approvals.js";

/**
 * Allowlist parsing must fail closed for heredoc bodies the shell would expand,
 * and for text that follows a heredoc terminator. These cases are allowlisted
 * today, so this file fails until that bypass is fixed.
 */
const CAT = "/bin/cat";
const ECHO = "/bin/echo";
const allowlist: ExecAllowlistEntry[] = [{ pattern: CAT }, { pattern: ECHO }];

function evaluate(command: string) {
  return evaluateShellAllowlist({
    command,
    allowlist,
    safeBins: new Set(),
    platform: "linux",
  });
}

describe("exec allowlist heredoc parsing", () => {
  it("rejects command substitution in an unquoted heredoc body", () => {
    const result = evaluate(`${CAT} <<EOF\n$(touch /tmp/marker)\nEOF\n`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("rejects backticks in an unquoted heredoc body", () => {
    const result = evaluate(`${CAT} <<EOF\n\`touch /tmp/marker\`\nEOF\n`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("rejects parameter expansion in an unquoted heredoc body", () => {
    const result = evaluate(`${CAT} <<EOF\n\${HOME}\nEOF\n`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("rejects command substitution in a strip-tabs heredoc body", () => {
    const result = evaluate(`${CAT} <<-EOF\n\t$(touch /tmp/marker)\n\tEOF\n`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("does not treat a command after the heredoc terminator as an argument of the allowlisted binary", () => {
    // The terminator's newline is consumed by the heredoc. With no further newline,
    // the following text is a separate shell command, not another argv token.
    const result = evaluate(`${CAT} <<EOF\nhello\nEOF\n${ECHO} /tmp/marker`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("does not allow a command after a quoted heredoc terminator", () => {
    const result = evaluate(`${CAT} <<'EOF'\nliteral\nEOF\n${ECHO} /tmp/marker`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("rejects command substitution in a heredoc that is piped into another allowlisted binary", () => {
    const result = evaluate(`${CAT} <<EOF | ${ECHO}\n$(touch /tmp/marker)\nEOF\n`);
    expect(result.analysisOk && result.allowlistSatisfied).toBe(false);
  });

  it("still allowlists a quoted heredoc whose body only looks like a substitution", () => {
    const result = evaluate(`${CAT} <<'EOF'\n$(touch /tmp/marker)\nEOF\n`);
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("still allowlists a double-quoted heredoc delimiter", () => {
    const result = evaluate(`${CAT} <<"EOF"\n$(touch /tmp/marker)\nEOF\n`);
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("still allowlists an unquoted heredoc body with no expansions", () => {
    const result = evaluate(`${CAT} <<EOF\nhello\nEOF\n`);
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segments.map((segment) => segment.argv[0])).toEqual([CAT]);
  });
});
