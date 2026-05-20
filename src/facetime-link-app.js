import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function extractFaceTimeLink(result) {
  const link = result?.data?.link;
  return typeof link === "string" && link.startsWith("https://facetime.apple.com/")
    ? link
    : "";
}

export function launchFaceTimeLinkApp({ link, callUuid, config }) {
  if (!config.faceTimeLinkAppEnabled) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (!link) {
    return { ok: false, skipped: true, reason: "missing_link" };
  }
  if (!fs.existsSync(config.faceTimeLinkAppScript)) {
    return {
      ok: false,
      skipped: true,
      reason: "script_missing",
      script: config.faceTimeLinkAppScript,
    };
  }

  fs.mkdirSync(config.faceTimeLinkAppLogDir, { recursive: true });
  const safeUuid = String(callUuid || "manual").replace(/[^A-Za-z0-9_-]/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutPath = path.join(config.faceTimeLinkAppLogDir, `${stamp}-${safeUuid}.stdout.log`);
  const stderrPath = path.join(config.faceTimeLinkAppLogDir, `${stamp}-${safeUuid}.stderr.log`);
  const resultPath = path.join(config.faceTimeLinkAppLogDir, `${stamp}-${safeUuid}.json`);
  const stdout = fs.openSync(stdoutPath, "a");
  const stderr = fs.openSync(stderrPath, "a");
  const child = spawn(
    config.faceTimeLinkAppPython,
    [
      config.faceTimeLinkAppScript,
      link,
      "--call-uuid",
      String(callUuid || ""),
      "--remote-debugging-port",
      String(config.faceTimeLinkAppDebugPort),
      "--join-name",
      config.faceTimeLinkAppJoinName,
      "--json-log",
      resultPath,
    ],
    {
      detached: true,
      stdio: ["ignore", stdout, stderr],
    },
  );
  child.unref();

  return {
    ok: true,
    pid: child.pid,
    stdoutPath,
    stderrPath,
    resultPath,
  };
}
