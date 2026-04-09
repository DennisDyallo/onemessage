/**
 * Deprecated — use 'onemessage daemon start' instead.
 *
 * This shim exists for backwards compatibility and delegates
 * to the unified daemon by directly importing it, which triggers
 * its module-level entry point.
 */

process.stderr.write(
  "[whatsapp-daemon] Deprecated. Use 'onemessage daemon start' instead.\n",
);

// daemon.ts has a module-level entry point that starts the daemon on import.
// We just need to import it — do NOT create a second UnifiedDaemon instance.
import("./daemon.ts");
