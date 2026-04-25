import { getConfig } from "../src/env.js";
import { CodexDesktopCdp } from "../src/codex-cdp.js";

const config = getConfig();
const codex = new CodexDesktopCdp({
  remoteDebugUrl: config.codexRemoteDebugUrl,
  responseTimeoutMs: config.responseTimeoutMs,
  cdpRequestTimeoutMs: config.codexCdpRequestTimeoutMs,
  appPath: config.codexAppPath,
  wakeBeforePrompt: config.codexWakeBeforePrompt,
  bringToFrontBeforePrompt: config.codexBringToFrontBeforePrompt,
});

const health = await codex.health();
console.log(JSON.stringify(health, null, 2));
if (!health.ok) process.exitCode = 1;
