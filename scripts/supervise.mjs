// Keeps the API running: starts it, and if it ever stops unexpectedly, starts it again after a short pause
// (1, 2, 4 … up to 30 seconds). Stopping it on purpose (Ctrl+C) stops both.
// Usage (from server/): node ../scripts/supervise.mjs node dist/index.js
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node supervise.mjs <command> [args…]");
  process.exit(2);
}

let child = null;
let stopping = false;
let delay = 1000;
let startedAt = 0;

const stamp = () => new Date().toISOString();

function start() {
  startedAt = Date.now();
  // No shell (arguments are passed as they are); "node" means this same Node.js, so it's found on every system.
  child = spawn(cmd === "node" ? process.execPath : cmd, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(code ?? 0);
    // Ran fine for a while: the next restart is quick again.
    if (Date.now() - startedAt > 60_000) delay = 1000;
    console.error(`[${stamp()}] The API stopped (${signal ?? `exit code ${code}`}). Restarting in ${delay / 1000}s…`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 30_000);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
