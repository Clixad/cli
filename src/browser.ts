/** Open a URL in the user's default browser — the ad wall, GitHub device login,
 *  and Stripe Checkout all need it. Lives apart from main.ts because importing
 *  main.ts runs the CLI. */
import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  // A missing opener (headless Linux without xdg-open) emits 'error' with no
  // listener, and an unhandled 'error' on a ChildProcess is an uncaught
  // exception — it would take the whole TUI down mid-/earn. The URL is printed
  // next to this call on every path, so failing to open one is recoverable by
  // hand; crashing is not.
  child.on("error", () => undefined);
  child.unref();
}
