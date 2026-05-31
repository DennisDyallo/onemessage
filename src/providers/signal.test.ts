import { describe, expect, it } from "bun:test";
import { buildSignalDaemonArgs, getSignalJsonRpcSocketPath } from "./signal";

describe("buildSignalDaemonArgs", () => {
  it("includes --socket for signal-cli 0.14.3 daemon mode compat", () => {
    // Verify signal-cli 0.14.3 compat: daemon requires a channel param
    // (--socket/--dbus/--tcp/--http). Without one, signal-cli exits:
    //   'At least one channel parameter is required, e.g. --socket or --dbus.'

    const args = buildSignalDaemonArgs("+46737124377");

    // Must include --socket (fixes crash loop)
    expect(args).toContain("--socket");

    // Must NOT include --no-receive-stdout (would disable stdout JSON emission)
    expect(args).not.toContain("--no-receive-stdout");

    // Verify full structure
    expect(args).toEqual([
      "signal-cli",
      "-a",
      "+46737124377",
      "-o",
      "json",
      "daemon",
      "--send-read-receipts",
      "--socket",
      getSignalJsonRpcSocketPath(),
    ]);
  });
});
