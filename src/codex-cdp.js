import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { streamCodexReplies, waitForCodexReplies } from "./session-log.js";

const execFileAsync = promisify(execFile);

export class CodexDesktopCdp {
  constructor({
    remoteDebugUrl,
    responseTimeoutMs,
    cdpRequestTimeoutMs = 60_000,
    appPath = "/Applications/Codex.app",
    wakeBeforePrompt = true,
    wakeAppBeforePrompt = false,
    bringToFrontBeforePrompt = false,
    connectPage = CdpPage.connect,
  }) {
    this.remoteDebugUrl = remoteDebugUrl.replace(/\/+$/, "");
    this.responseTimeoutMs = responseTimeoutMs;
    this.cdpRequestTimeoutMs = cdpRequestTimeoutMs;
    this.appPath = appPath;
    this.wakeBeforePrompt = wakeBeforePrompt;
    this.wakeAppBeforePrompt = wakeAppBeforePrompt;
    this.bringToFrontBeforePrompt = bringToFrontBeforePrompt;
    this.connectPage = connectPage;
  }

  async health() {
    const targets = await this.listTargets();
    const page = this.pickPageTarget(targets);
    return {
      ok: Boolean(page),
      targetCount: targets.length,
      page: page
        ? { id: page.id, title: page.title, url: page.url, type: page.type }
        : null,
    };
  }

  async ask(text, { prefix = "" } = {}) {
    return this.askWithMessages(text, { prefix });
  }

  async askWithMessages(text, { prefix = "", onMessage = null } = {}) {
    const requestId = `bb-codex-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const prompt = `${prefix}[bridge_request_id: ${requestId}]\n${text}`.trim();
    const sinceMs = Date.now();

    await this.withPage(async (page) => {
      await page.waitForExpression(
        `document.querySelector(".ProseMirror") != null`,
        15000,
      );
      const result = await page.evaluate(injectPromptExpression(prompt));
      if (result?.ok === false) {
        throw new Error(`Codex UI injection failed: ${JSON.stringify(result)}`);
      }
    });

    const reply = onMessage
      ? await streamCodexReplies({
          requestId,
          sinceMs,
          timeoutMs: this.responseTimeoutMs,
          onMessage,
        })
      : await waitForCodexReplies({
          requestId,
          sinceMs,
          timeoutMs: this.responseTimeoutMs,
        });
    return { requestId, prompt, reply };
  }

  async listTargets() {
    const response = await fetch(`${this.remoteDebugUrl}/json/list`);
    if (!response.ok) {
      throw new Error(
        `Failed to list Codex CDP targets (${response.status}). Is Codex running with --remote-debugging-port?`,
      );
    }
    return response.json();
  }

  pickPageTarget(targets) {
    return this.codexPageTargets(targets).at(0) || null;
  }

  codexPageTargets(targets) {
    const pageTargets = targets.filter(
      (target) => target.type === "page" && target.webSocketDebuggerUrl,
    );
    const appTargets = pageTargets.filter((target) =>
      String(target.url || "").startsWith("app://-/index.html"),
    );
    return appTargets.length > 0 ? appTargets : pageTargets;
  }

  async withPage(fn) {
    const targets = await this.listTargets();
    const target = this.pickPageTarget(targets);
    if (!target) {
      throw new Error("No Codex page target found in remote debugging targets");
    }
    if (this.wakeBeforePrompt) await this.wakeCodexTargets(targets);

    const page = await this.connectPage(
      target.webSocketDebuggerUrl,
      this.cdpRequestTimeoutMs,
    );
    try {
      return await fn(page);
    } finally {
      page.close();
    }
  }

  async wakeCodex(page) {
    if (this.wakeAppBeforePrompt) await bestEffortWakeApp(this.appPath);
    await page.nudgeRenderer();
    if (this.bringToFrontBeforePrompt) await page.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async wakeCodexTargets(targets) {
    if (this.wakeAppBeforePrompt) await bestEffortWakeApp(this.appPath);
    const pages = this.codexPageTargets(targets);
    const results = await Promise.allSettled(
      pages.map(async (target) => {
        const page = await this.connectPage(
          target.webSocketDebuggerUrl,
          this.cdpRequestTimeoutMs,
        );
        try {
          await page.nudgeRenderer();
          if (this.bringToFrontBeforePrompt) await page.bringToFront();
        } finally {
          page.close();
        }
      }),
    );
    for (const result of results) {
      if (result.status !== "rejected") continue;
      console.warn(
        `${new Date().toISOString()} codex target wake skipped/failed: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export class CdpPage {
  constructor(socket, requestTimeoutMs) {
    this.socket = socket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    });
  }

  static async connect(url, requestTimeoutMs) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const page = new CdpPage(socket, requestTimeoutMs);
    await page.request("Runtime.enable");
    return page;
  }

  async evaluate(expression) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails));
    }
    return response.result?.result?.value ?? response.result?.result ?? null;
  }

  async bringToFront() {
    await this.request("Page.bringToFront");
  }

  async nudgeRenderer() {
    await this.request("Runtime.evaluate", {
      expression: "void 0",
      returnByValue: true,
    });
  }

  async waitForExpression(expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evaluate(`Boolean(${expression})`);
      if (value === true) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for renderer condition: ${expression}`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}`));
      }, this.requestTimeoutMs);
    });
  }

  close() {
    this.socket.close();
  }
}

async function bestEffortWakeApp(appPath) {
  if (process.platform !== "darwin" || !appPath) return;
  try {
    await execFileAsync("/usr/bin/open", ["-g", appPath], { timeout: 5_000 });
  } catch (error) {
    console.warn(
      `${new Date().toISOString()} codex app wake skipped/failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function injectPromptExpression(prompt) {
  return `(async () => {
    const prompt = ${JSON.stringify(prompt)};
    const editor = document.querySelector(".ProseMirror");
    if (!editor) return { ok: false, error: "missing ProseMirror editor" };

    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, prompt);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const buttons = Array.from(document.querySelectorAll("button"));
    const send = buttons.find((button) =>
      String(button.className || "").includes("size-token-button-composer")
    );
    if (!send) {
      return { ok: false, error: "missing composer send button" };
    }
    if (send.disabled || send.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "composer send button disabled" };
    }
    send.click();
    return { ok: true };
  })()`;
}
