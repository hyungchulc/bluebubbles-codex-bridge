import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { streamCodexReplies, waitForCodexReplies } from "./session-log.js";
import {
  clearDesiredCodexState,
  readDesiredCodexState,
  writeDesiredCodexState,
} from "./codex-settings.js";

const execFileAsync = promisify(execFile);
const DESIRED_READY_STALE_GRACE_MS = 60_000;
const POST_RESTART_OBSERVED_READY_FALLBACK_MS = 15_000;
const APP_WAKE_RETRY_DELAY_MS = 1_500;
const COMPOSER_SEND_READY_ATTEMPT_MS = 5_000;
const COMPOSER_RECOVERY_DELAY_MS = 500;
const CDP_EVALUATE_ATTEMPT_TIMEOUT_MS = 5_000;

export class CodexDesktopCdp {
  constructor({
    remoteDebugUrl,
    responseTimeoutMs,
    cdpRequestTimeoutMs = 60_000,
    appPath = "/Applications/Codex.app",
    wakeBeforePrompt = true,
    wakeAllTargetsBeforePrompt = false,
    wakeAppBeforePrompt = false,
    bringToFrontBeforePrompt = false,
    preferredThreadId = "",
    preferredThreadTitle = "",
    preferredThreadTimeoutMs = 60_000,
    postRestartThreadDelayMs = 30_000,
    postRestartReadyTimeoutMs = 60_000,
    readyModelTexts = ["5.5"],
    readyReasoningTexts = ["High"],
    readyStatePath =
      process.env.CODEX_READY_STATE_PATH ||
      path.join(os.homedir(), ".bluebubbles-codex-bridge", "state", "codex-ui-ready-state.json"),
    desiredStatePath =
      process.env.CODEX_DESIRED_STATE_PATH ||
      path.join(os.homedir(), ".bluebubbles-codex-bridge", "state", "codex-ui-desired-state.json"),
    connectPage = CdpPage.connect,
    wakeApp = bestEffortWakeApp,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  }) {
    this.remoteDebugUrl = remoteDebugUrl.replace(/\/+$/, "");
    this.responseTimeoutMs = responseTimeoutMs;
    this.cdpRequestTimeoutMs = cdpRequestTimeoutMs;
    this.appPath = appPath;
    this.wakeBeforePrompt = wakeBeforePrompt;
    this.wakeAllTargetsBeforePrompt = wakeAllTargetsBeforePrompt;
    this.wakeAppBeforePrompt = wakeAppBeforePrompt;
    this.bringToFrontBeforePrompt = bringToFrontBeforePrompt;
    this.preferredThreadId = preferredThreadId;
    this.preferredThreadTitle = preferredThreadTitle;
    this.preferredThreadTimeoutMs = preferredThreadTimeoutMs;
    this.postRestartThreadDelayMs = postRestartThreadDelayMs;
    this.postRestartReadyTimeoutMs = postRestartReadyTimeoutMs;
    this.readyModelTexts = readyModelTexts;
    this.readyReasoningTexts = readyReasoningTexts;
    this.readyStatePath = readyStatePath;
    this.desiredStatePath = desiredStatePath;
    this.readyState = this.loadReadyState();
    this.desiredState = this.loadDesiredState();
    this.connectPage = connectPage;
    this.wakeApp = wakeApp;
    this.sleep = sleep;
    this.now = now;
    this.lastPromptTargetId = null;
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

  async submitRawCommand(text) {
    const requestId = `bb-codex-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const prompt = String(text || "").trim();
    if (!prompt) {
      throw new Error("Raw Codex command cannot be empty");
    }

    await this.submitPromptToComposer(prompt, requestId);
    return { requestId, prompt };
  }

  async setReasoningLevel(reasoningText) {
    const requestId = `bb-reasoning-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const targetReasoning = String(reasoningText || "").trim();
    if (!targetReasoning) {
      throw new Error("Reasoning level cannot be empty");
    }

    return this.withPage(async (page) => {
      console.log(`${new Date().toISOString()} codex reasoning ${requestId} selecting thread`);
      await this.ensurePreferredThread(page);
      await page.waitForExpression(
        `document.querySelector(".ProseMirror") != null`,
        Math.max(15000, this.preferredThreadTimeoutMs),
      );
      const { result, readyState } = await this.setReasoningLevelOnPage(
        page,
        requestId,
        targetReasoning,
      );
      return { status: "set", requestId, reasoningText: targetReasoning, result, readyState };
    });
  }

  async submitSteer(text) {
    const requestId = `bb-steer-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const prompt = String(text || "").trim();
    if (!prompt) {
      throw new Error("Steer note cannot be empty");
    }

    return this.submitSteerToComposer(prompt, requestId);
  }

  async askWithMessages(text, { prefix = "", onMessage = null } = {}) {
    const requestId = `bb-codex-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const prompt = `${prefix}[bridge_request_id: ${requestId}]\n${text}`.trim();
    const sinceMs = Date.now();

    await this.submitPromptToComposer(prompt, requestId);

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

  async submitPromptToComposer(prompt, requestId) {
    await this.withPage(async (page, { postRestartDelayNeeded } = {}) => {
      const recoveredPages = [];
      let activePage = page;
      const recoverPage = async (reason) => {
        const recovered = await this.reconnectPromptPage(requestId, reason);
        recoveredPages.push(recovered);
        activePage = recovered;
        return activePage;
      };
      try {
        console.log(`${new Date().toISOString()} codex prompt ${requestId} selecting thread`);
        await this.ensurePreferredThread(activePage);
        await activePage.waitForExpression(
          `document.querySelector(".ProseMirror") != null`,
          Math.max(15000, this.preferredThreadTimeoutMs),
        );
        const readyReason =
          postRestartDelayNeeded && this.postRestartThreadDelayMs > 0
            ? "post-restart"
            : "prompt";
        console.log(
          `${new Date().toISOString()} codex prompt ${requestId} waiting for ${readyReason} UI ready`,
        );
        try {
          await this.waitForPostRestartReady(activePage, requestId, {
            reason: readyReason,
            correctReasoning: true,
            reconcileDesired: false,
          });
        } catch (error) {
          await this.allowComposerReadyFallback(activePage, requestId, readyReason, error);
        }
        await this.captureReadyState(activePage, requestId);
        console.log(`${new Date().toISOString()} codex prompt ${requestId} filling composer`);
        const fillResult = await activePage.evaluate(fillPromptExpression(prompt));
        if (fillResult?.ok === false) {
          throw new Error(`Codex UI prompt fill failed: ${JSON.stringify(fillResult)}`);
        }
        console.log(`${new Date().toISOString()} codex prompt ${requestId} waiting for send`);
        activePage = await this.waitForComposerSendReadyWithRecovery(activePage, {
          requestId,
          prompt,
          recoverPage,
        });
        await this.submitComposerDraftWithRecovery(activePage, {
          requestId,
          recoverPage,
        });
      } finally {
        for (const recoveredPage of recoveredPages) {
          recoveredPage.close();
        }
      }
    });
  }

  async allowComposerReadyFallback(page, requestId, reason, error) {
    const message = error instanceof Error ? error.message : String(error);
    const composerPresent = await page.evaluate(
      `Boolean(document.querySelector(".ProseMirror"))`,
    );
    if (!composerPresent) throw error;
    console.warn(
      `${new Date().toISOString()} codex prompt ${requestId} proceeding after ${reason} UI ready timeout because composer is available: ${message}`,
    );
  }

  async waitForComposerSendReadyWithRecovery(
    page,
    { requestId, prompt, recoverPage },
  ) {
    const deadline = this.now() + this.responseTimeoutMs;
    let activePage = page;
    let attempts = 0;
    let lastError = null;
    while (this.now() < deadline) {
      attempts += 1;
      const remainingMs = Math.max(250, deadline - this.now());
      try {
        await activePage.waitForExpression(
          composerSendReadyExpression(),
          Math.min(COMPOSER_SEND_READY_ATTEMPT_MS, remainingMs),
        );
        console.log(
          `${new Date().toISOString()} codex prompt ${requestId} send ready after ${attempts} check(s)`,
        );
        return activePage;
      } catch (error) {
        lastError = error;
        console.warn(
          `${new Date().toISOString()} codex prompt ${requestId} send ready check failed; recovering renderer: ${errorMessage(error)}`,
        );
        activePage = await recoverPage(
          `send-ready check failed after prompt fill: ${errorMessage(error)}`,
        );
        const fillResult = await activePage.evaluate(fillPromptExpression(prompt));
        if (fillResult?.ok === false) {
          throw new Error(
            `Codex UI prompt refill failed after renderer recovery: ${JSON.stringify(fillResult)}`,
          );
        }
        await this.sleep(COMPOSER_RECOVERY_DELAY_MS);
      }
    }
    throw new Error(
      `Timed out waiting for Codex composer send readiness after prompt fill: ${errorMessage(lastError)}`,
    );
  }

  async submitComposerDraftWithRecovery(page, { requestId, recoverPage }) {
    try {
      return await this.submitComposerDraft(page, requestId);
    } catch (error) {
      if (!isCdpTimeoutError(error)) throw error;
      console.warn(
        `${new Date().toISOString()} codex prompt ${requestId} submit state check timed out; reconnecting before retry: ${errorMessage(error)}`,
      );
      const recovered = await recoverPage(
        `submit state check timed out: ${errorMessage(error)}`,
      );
      const recoveredState = await this.readComposerSubmissionState(recovered);
      if (recoveredState?.submitted) {
        console.log(
          `${new Date().toISOString()} codex prompt ${requestId} submitted before recovery check completed`,
        );
        return { ok: true, method: "recovered", state: recoveredState };
      }
      if (!recoveredState || recoveredState.draftLength > 0) {
        return this.submitComposerDraft(recovered, requestId);
      }
      throw error;
    }
  }

  async readComposerSubmissionState(page) {
    try {
      return await page.evaluate(composerSubmissionStateExpression());
    } catch {
      return null;
    }
  }

  async submitComposerDraft(page, requestId) {
    console.log(`${new Date().toISOString()} codex prompt ${requestId} submitting with Enter`);
    await page.pressEnter();
    const enterState = await this.waitForComposerSubmitted(page, {
      requestId,
      method: "Enter",
      timeoutMs: 2_500,
    });
    if (enterState?.submitted) {
      return { ok: true, method: "enter", state: enterState };
    }

    console.warn(
      `${new Date().toISOString()} codex prompt ${requestId} Enter did not submit; trying Command+Enter`,
    );
    await page.pressCommandEnter();
    const commandEnterState = await this.waitForComposerSubmitted(page, {
      requestId,
      method: "Command+Enter",
      timeoutMs: 2_500,
    });
    if (commandEnterState?.submitted) {
      return { ok: true, method: "command-enter", state: commandEnterState };
    }

    console.warn(
      `${new Date().toISOString()} codex prompt ${requestId} keyboard submit did not start; falling back to send click`,
    );
    const clickResult = await page.evaluate(clickComposerSendExpression());
    if (clickResult?.ok === false) {
      throw new Error(`Codex UI submit failed: ${JSON.stringify(clickResult)}`);
    }
    const clickState = await this.waitForComposerSubmitted(page, {
      requestId,
      method: "send click",
      timeoutMs: 5_000,
    });
    if (!clickState?.submitted) {
      throw new Error(
        `Codex UI submit did not start after fallback click: ${JSON.stringify(clickState)}`,
      );
    }
    return { ok: true, method: "click", state: clickState };
  }

  async waitForComposerSubmitted(page, { requestId, method, timeoutMs }) {
    const deadline = this.now() + timeoutMs;
    let lastState = null;
    let lastError = null;
    while (this.now() < deadline) {
      try {
        lastState = await page.evaluate(composerSubmissionStateExpression());
      } catch (error) {
        lastError = error;
        if (isCdpTimeoutError(error)) throw error;
        await this.sleep(250);
        continue;
      }
      if (lastState?.submitted) {
        console.log(
          `${new Date().toISOString()} codex prompt ${requestId} submitted via ${method}`,
        );
        return lastState;
      }
      await this.sleep(250);
    }
    if (lastError) {
      console.warn(
        `${new Date().toISOString()} codex prompt ${requestId} submit state polling ended after error: ${errorMessage(lastError)}`,
      );
    }
    return lastState;
  }

  async submitSteerToComposer(prompt, requestId) {
    return this.withPage(async (page) => {
      console.log(`${new Date().toISOString()} codex steer ${requestId} selecting thread`);
      await this.ensurePreferredThread(page);
      await page.waitForExpression(
        `document.querySelector(".ProseMirror") != null`,
        Math.max(15000, this.preferredThreadTimeoutMs),
      );

      const activeRun = await page.evaluate(activeComposerRunExpression());
      if (!activeRun?.active) {
        console.log(`${new Date().toISOString()} codex steer ${requestId} ignored no active run`);
        return {
          status: "ignored",
          reason: activeRun?.reason || "no_active_codex_run",
          requestId,
          prompt,
        };
      }

      console.log(`${new Date().toISOString()} codex steer ${requestId} filling composer`);
      const fillResult = await page.evaluate(fillPromptExpression(prompt));
      if (fillResult?.ok === false) {
        throw new Error(`Codex UI steer fill failed: ${JSON.stringify(fillResult)}`);
      }
      console.log(`${new Date().toISOString()} codex steer ${requestId} waiting for steer send`);
      await page.waitForExpression(
        composerDraftReadyExpression(),
        Math.min(this.responseTimeoutMs, 30_000),
      );
      console.log(`${new Date().toISOString()} codex steer ${requestId} submitting with Command+Enter`);
      await page.pressCommandEnter();
      return { status: "steered", requestId, prompt };
    });
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
    const targets = await this.listTargetsForPrompt();
    const target = this.pickPageTarget(targets);
    if (!target) {
      throw new Error("No Codex page target found in remote debugging targets");
    }
    const previousTargetId = this.lastPromptTargetId;
    const targetChanged = Boolean(
      previousTargetId && previousTargetId !== target.id,
    );
    const postRestartDelayNeeded = !previousTargetId || targetChanged;
    this.lastPromptTargetId = target.id || null;
    const page = await this.connectPage(
      target.webSocketDebuggerUrl,
      this.cdpRequestTimeoutMs,
    );
    try {
      if (this.wakeBeforePrompt) {
        if (this.wakeAllTargetsBeforePrompt) {
          await this.wakeCodexTargets(targets);
        } else {
          await this.wakeCodex(page);
        }
      }
      return await fn(page, {
        postRestartDelayNeeded,
        targetChanged,
        targetId: target.id || null,
      });
    } finally {
      page.close();
    }
  }

  async listTargetsForPrompt() {
    let targets;
    try {
      targets = await this.listTargets();
    } catch (error) {
      if (!this.wakeAppBeforePrompt) throw error;
      console.warn(
        `${new Date().toISOString()} codex target list failed before prompt; waking app and retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.listTargetsAfterAppWake();
    }

    if (!this.pickPageTarget(targets) && this.wakeAppBeforePrompt) {
      console.warn(
        `${new Date().toISOString()} codex page target missing before prompt; waking app and retrying`,
      );
      return this.listTargetsAfterAppWake();
    }
    return targets;
  }

  async listTargetsAfterAppWake() {
    await this.wakeApp(this.appPath, this.remoteDebugUrl);
    await this.sleep(APP_WAKE_RETRY_DELAY_MS);
    return this.listTargets();
  }

  async reconnectPromptPage(requestId, reason) {
    console.warn(
      `${new Date().toISOString()} codex prompt ${requestId} reconnecting Codex page: ${reason}`,
    );
    const targets = await this.listTargetsForPrompt();
    const target = this.pickPageTarget(targets);
    if (!target) {
      throw new Error("No Codex page target found while recovering prompt submit");
    }
    const page = await this.connectPage(
      target.webSocketDebuggerUrl,
      this.cdpRequestTimeoutMs,
    );
    try {
      await this.wakeCodex(page);
      await this.ensurePreferredThread(page);
      await page.waitForExpression(
        `document.querySelector(".ProseMirror") != null`,
        Math.max(15000, this.preferredThreadTimeoutMs),
      );
      return page;
    } catch (error) {
      page.close();
      throw error;
    }
  }

  async wakeCodex(page) {
    await page.nudgeRenderer();
    if (this.bringToFrontBeforePrompt) await page.bringToFront();
    await this.sleep(250);
  }

  async keepAliveRenderer() {
    const targets = await this.listTargets();
    const target = this.pickPageTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      return { ok: false, reason: "no_codex_page_target" };
    }
    const page = await this.connectPage(
      target.webSocketDebuggerUrl,
      this.cdpRequestTimeoutMs,
    );
    try {
      await page.nudgeRenderer();
      return { ok: true, targetId: target.id || null };
    } finally {
      page.close();
    }
  }

  async wakeCodexTargets(targets) {
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
    await this.sleep(250);
  }

  async setReasoningLevelOnPage(
    page,
    requestId,
    targetReasoning,
    { reconcileDesired = true, captureBefore = true } = {},
  ) {
    if (captureBefore) {
      await this.captureReadyState(page, requestId, { reconcileDesired });
    }

    const control = await page.evaluate(modelReasoningControlCenterExpression());
    if (control?.ok === false) {
      throw new Error(`Codex UI reasoning control missing: ${JSON.stringify(control)}`);
    }

    await page.request("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: control.x,
      y: control.y,
      button: "left",
      clickCount: 1,
    });
    await page.request("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: control.x,
      y: control.y,
      button: "left",
      clickCount: 1,
    });
    await this.sleep(500);

    const result = await page.evaluate(selectReasoningMenuItemExpression(targetReasoning));
    if (result?.ok === false) {
      throw new Error(`Codex UI reasoning selection failed: ${JSON.stringify(result)}`);
    }
    await this.sleep(800);
    const readyState = await this.captureReadyState(page, requestId, {
      reconcileDesired,
    });
    return { result, readyState };
  }

  async waitForPostRestartReady(
    page,
    requestId,
    {
      reason = "post-restart",
      correctReasoning = false,
      reconcileDesired = true,
    } = {},
  ) {
    const expected = this.expectedReadyTexts({
      includeReadyState: false,
      reconcileDesired,
    });
    const expression = codexReadyExpression({
      modelTexts: expected.modelTexts,
      reasoningTexts: expected.reasoningTexts,
    });
    const deadline = this.now() + this.postRestartReadyTimeoutMs;
    const fallbackDeadline =
      this.now() +
      Math.min(
        POST_RESTART_OBSERVED_READY_FALLBACK_MS,
        this.postRestartReadyTimeoutMs,
      );
    let attempts = 0;
    let lastError = null;
    let lastFallbackCheckMs = 0;
    while (this.now() < deadline) {
      attempts += 1;
      const remainingMs = Math.max(250, deadline - this.now());
      const attemptTimeoutMs = Math.min(5_000, remainingMs);
      try {
        const observed = await this.captureReadyState(page, requestId, {
          reconcileDesired: false,
        });
        if (readyStateMatchesExpected(observed, expected)) {
          if (
            await this.confirmPostRestartReadyState(
              page,
              requestId,
              reason,
              expression,
              observed,
              attempts,
            )
          ) {
            return;
          }
        }

        const reasoningTarget = reasoningCorrectionTarget(observed, expected);
        if (correctReasoning && reasoningTarget) {
          console.log(
            `${new Date().toISOString()} codex prompt ${requestId} observed UI state ${
              observed.modelText
            }/${observed.reasoningText}; setting reasoning ${reasoningTarget} before prompt fill`,
          );
          await this.setReasoningLevelOnPage(page, requestId, reasoningTarget, {
            captureBefore: false,
            reconcileDesired: false,
          });
          if (
            await this.confirmPostRestartReadyState(
              page,
              requestId,
              reason,
              expression,
              null,
              attempts,
            )
          ) {
            return;
          }
        }
      } catch (error) {
        lastError = error;
      }
      try {
        await page.waitForExpression(expression, attemptTimeoutMs);
        if (
          await this.confirmPostRestartReadyState(
            page,
            requestId,
            reason,
            expression,
            null,
            attempts,
            { initialStrictReady: true },
          )
        ) {
          return;
        }
      } catch (error) {
        lastError = error;
        if (
          this.now() >= fallbackDeadline &&
          this.now() - lastFallbackCheckMs >= 5_000
        ) {
          lastFallbackCheckMs = this.now();
          if (await this.resolvePostRestartReadyFallback(page, requestId, expected)) {
            return;
          }
        }
        if (this.now() >= deadline) break;
        if (attempts % 3 === 0) {
          console.log(
            `${new Date().toISOString()} codex prompt ${requestId} still waiting for ${reason} UI ready`,
          );
        }
        await this.sleep(1_000);
      }
    }
    if (await this.resolvePostRestartReadyFallback(page, requestId, expected)) {
      return;
    }
    throw new Error(
      `Timed out waiting for ${reason} Codex model/reasoning UI before prompt fill: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async confirmPostRestartReadyState(
    page,
    requestId,
    reason,
    expression,
    observedState,
    attempts,
    { initialStrictReady = false } = {},
  ) {
    try {
      if (!observedState && !initialStrictReady) {
        await page.waitForExpression(expression, 5_000);
      }
      await this.sleep(1_000);
      await page.waitForExpression(expression, 5_000);
      console.log(
        `${new Date().toISOString()} codex prompt ${requestId} ${reason} UI ready after ${attempts} check(s)`,
      );
      return true;
    } catch (error) {
      const expected = this.expectedReadyTexts({
        includeReadyState: false,
        reconcileDesired: false,
      });
      const firstState =
        observedState ||
        (await this.captureReadyState(page, requestId, {
          reconcileDesired: false,
        }));
      if (!readyStateMatchesExpected(firstState, expected)) return false;
      await this.sleep(1_000);
      const secondState =
        (await this.captureReadyState(page, requestId, {
          reconcileDesired: false,
        })) || firstState;
      if (!readyStateMatchesExpected(secondState, expected)) return false;
      console.warn(
        `${new Date().toISOString()} codex prompt ${requestId} proceeding with observed ${reason} UI state ${secondState.modelText}/${secondState.reasoningText}`,
      );
      return true;
    }
  }

  async resolvePostRestartReadyFallback(page, requestId, expected) {
    const firstState = await this.captureReadyState(page, requestId, {
      reconcileDesired: false,
    });
    if (!readyStateMatchesExpected(firstState, expected)) return false;
    await this.sleep(1_000);
    const secondState =
      (await this.captureReadyState(page, requestId, {
        reconcileDesired: false,
      })) || firstState;
    if (!readyStateMatchesExpected(secondState, expected)) return false;
    console.warn(
      `${new Date().toISOString()} codex prompt ${requestId} proceeding with observed post-restart UI state ${secondState.modelText}/${secondState.reasoningText}`,
    );
    return true;
  }

  async captureReadyState(page, requestId, { reconcileDesired = true } = {}) {
    if (!this.readyStatePath) return null;
    const result = await page.evaluate(extractReadyStateExpression());
    if (!result?.ok || !result.modelText || !result.reasoningText) return null;

    const nextState = {
      modelText: result.modelText,
      reasoningText: result.reasoningText,
      controlText: result.controlText || "",
      observedAt: new Date().toISOString(),
    };
    const previousKey = `${this.readyState?.modelText || ""}\n${this.readyState?.reasoningText || ""}`;
    const nextKey = `${nextState.modelText}\n${nextState.reasoningText}`;
    this.readyState = nextState;
    this.writeReadyState(nextState);
    if (reconcileDesired) {
      this.desiredState = this.reconcileDesiredStateWithReady(
        readDesiredCodexState(this.desiredStatePath),
        nextState,
        requestId,
      );
    }
    if (previousKey !== nextKey) {
      console.log(
        `${new Date().toISOString()} codex prompt ${requestId} captured UI ready state ${nextState.modelText}/${nextState.reasoningText}`,
      );
    }
    return nextState;
  }

  expectedReadyTexts({ includeReadyState = true, reconcileDesired = true } = {}) {
    const desiredState = reconcileDesired
      ? this.loadDesiredState()
      : readDesiredCodexState(this.desiredStatePath);
    const targetModelTexts = desiredState?.modelText
      ? [desiredState.modelText]
      : [...this.readyModelTexts];
    const targetReasoningTexts = desiredState?.reasoningText
      ? [desiredState.reasoningText]
      : [...this.readyReasoningTexts];
    const includeObservedState = includeReadyState && !desiredState;
    return {
      modelTexts: [
        includeObservedState ? this.readyState?.modelText || "" : "",
        ...targetModelTexts,
      ],
      reasoningTexts: [
        includeObservedState ? this.readyState?.reasoningText || "" : "",
        ...targetReasoningTexts,
      ],
    };
  }

  setDesiredReadyState(update) {
    const state = writeDesiredCodexState(this.desiredStatePath, update);
    this.desiredState = state;
    return state;
  }

  clearDesiredReadyState() {
    const result = clearDesiredCodexState(this.desiredStatePath);
    this.desiredState = null;
    return result;
  }

  loadDesiredState() {
    const state = readDesiredCodexState(this.desiredStatePath);
    this.desiredState = this.reconcileDesiredStateWithReady(
      state,
      this.readyState,
      "loadDesiredState",
    );
    return this.desiredState;
  }

  reconcileDesiredStateWithReady(desiredState, readyState, requestId) {
    if (!desiredState || !readyState || !this.desiredStatePath) return desiredState;
    if (!desiredReadyMismatch(desiredState, readyState)) return desiredState;
    if (
      !readyStateIsNewerThanDesired(
        desiredState,
        readyState,
        DESIRED_READY_STALE_GRACE_MS,
      )
    ) {
      return desiredState;
    }

    const update = {};
    if (desiredState.modelText && readyState.modelText) update.modelText = readyState.modelText;
    if (desiredState.reasoningText && readyState.reasoningText) {
      update.reasoningText = readyState.reasoningText;
    }
    if (!Object.keys(update).length) return desiredState;

    const refreshedState = writeDesiredCodexState(this.desiredStatePath, update);
    console.log(
      `${new Date().toISOString()} codex prompt ${requestId} refreshed stale desired UI state from ready state`,
    );
    return refreshedState;
  }

  loadReadyState() {
    if (!this.readyStatePath || !fs.existsSync(this.readyStatePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.readyStatePath, "utf8"));
      if (!data?.modelText || !data?.reasoningText) return null;
      return {
        modelText: String(data.modelText),
        reasoningText: String(data.reasoningText),
        controlText: String(data.controlText || ""),
        observedAt: String(data.observedAt || ""),
      };
    } catch {
      return null;
    }
  }

  writeReadyState(state) {
    if (!this.readyStatePath) return;
    try {
      fs.mkdirSync(path.dirname(this.readyStatePath), { recursive: true });
      const tmpPath = `${this.readyStatePath}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
      fs.renameSync(tmpPath, this.readyStatePath);
    } catch (error) {
      console.warn(
        `${new Date().toISOString()} codex ready state write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async ensurePreferredThread(page) {
    if (!this.preferredThreadId && !this.preferredThreadTitle) return;

    const result = await page.evaluate(
      ensurePreferredThreadExpression({
        threadId: this.preferredThreadId,
        threadTitle: this.preferredThreadTitle,
      }),
    );
    if (result?.ok === false) {
      console.warn(
        `${new Date().toISOString()} preferred Codex thread not selected: ${JSON.stringify(
          result,
        )}`,
      );
      return;
    }
    await page.waitForExpression(
      preferredThreadActiveExpression({
        threadId: result?.threadId || this.preferredThreadId,
        threadTitle: this.preferredThreadTitle,
      }),
      this.preferredThreadTimeoutMs,
    );
    await page.waitForExpression(
      `document.querySelector(".ProseMirror") != null`,
      this.preferredThreadTimeoutMs,
    );
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

  async evaluate(expression, { timeoutMs } = {}) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, {
      timeoutMs,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails));
    }
    return response.result?.result?.value ?? response.result?.result ?? null;
  }

  async bringToFront() {
    await this.request("Page.bringToFront");
  }

  async pressCommandEnter() {
    const params = {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36,
      modifiers: 4,
    };
    await this.request("Input.dispatchKeyEvent", {
      ...params,
      type: "rawKeyDown",
    });
    await this.request("Input.dispatchKeyEvent", {
      ...params,
      type: "keyUp",
    });
  }

  async pressEnter() {
    const params = {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36,
      modifiers: 0,
    };
    await this.request("Input.dispatchKeyEvent", {
      ...params,
      type: "rawKeyDown",
    });
    await this.request("Input.dispatchKeyEvent", {
      ...params,
      type: "keyUp",
    });
  }

  async nudgeRenderer() {
    await this.request("Runtime.evaluate", {
      expression: "void 0",
      returnByValue: true,
    });
  }

  async waitForExpression(expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(250, deadline - Date.now());
      try {
        const value = await this.evaluate(`Boolean(${expression})`, {
          timeoutMs: Math.min(
            CDP_EVALUATE_ATTEMPT_TIMEOUT_MS,
            this.requestTimeoutMs,
            remainingMs,
          ),
        });
        if (value === true) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const suffix = lastError ? `: ${errorMessage(lastError)}` : "";
    throw new Error(`Timed out waiting for renderer condition: ${expression}${suffix}`);
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}`));
      }, timeoutMs);
    });
  }

  close() {
    this.socket.close();
  }
}

async function bestEffortWakeApp(appPath, remoteDebugUrl = "") {
  if (process.platform !== "darwin" || !appPath) return;
  try {
    await execFileAsync("/usr/bin/open", codexAppOpenArgs(appPath, remoteDebugUrl), {
      timeout: 5_000,
    });
  } catch (error) {
    console.warn(
      `${new Date().toISOString()} codex app wake skipped/failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function codexAppOpenArgs(appPath, remoteDebugUrl = "") {
  const args = ["-g", "-j", "-n", "-a", appPath];
  const remoteDebug = parseRemoteDebugUrl(remoteDebugUrl);
  if (remoteDebug) {
    args.push(
      "--args",
      `--remote-debugging-port=${remoteDebug.port}`,
      `--remote-allow-origins=${remoteDebug.origin}`,
    );
  }
  return args;
}

function parseRemoteDebugUrl(remoteDebugUrl) {
  if (!remoteDebugUrl) return null;
  try {
    const url = new URL(remoteDebugUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return { port, origin: `${url.protocol}//${url.hostname}:${port}` };
  } catch {
    return null;
  }
}

function isCdpTimeoutError(error) {
  return errorMessage(error).includes("Timed out waiting for CDP method");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function injectPromptExpression(prompt) {
  return `(async () => {
    const prompt = ${JSON.stringify(prompt)};
    const editor = document.querySelector(".ProseMirror");
    if (!editor) return { ok: false, error: "missing ProseMirror editor" };

    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, prompt);

    const buttons = Array.from(document.querySelectorAll("button"));
    const send = buttons.find(isIdleComposerSendButton);
    if (!send) {
      return { ok: false, error: "missing composer send button" };
    }
    if (send.disabled || send.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "composer send button disabled" };
    }
    send.click();
    return { ok: true };

    function isIdleComposerSendButton(button) {
      if (!String(button.className || "").includes("size-token-button-composer")) {
        return false;
      }
      const label = [
        button.innerText || "",
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      return !label.includes("stop");
    }
  })()`;
}

export function fillPromptExpression(prompt) {
  return `(async () => {
    const prompt = ${JSON.stringify(prompt)};
    const editor = document.querySelector(".ProseMirror");
    if (!editor) return { ok: false, error: "missing ProseMirror editor" };

    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, prompt);
    return { ok: true };
  })()`;
}

export function clickComposerSendExpression() {
  return `(async () => {
    const send = findIdleComposerSendButton();
    if (!send) {
      return { ok: false, error: "missing composer send button" };
    }
    if (send.disabled || send.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "composer send button disabled" };
    }
    send.click();
    return { ok: true };

    function findIdleComposerSendButton() {
      return Array.from(document.querySelectorAll("button")).find((button) => {
        if (!String(button.className || "").includes("size-token-button-composer")) {
          return false;
        }
        const label = [
          button.innerText || "",
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
        ].join(" ").toLowerCase();
        return !label.includes("stop");
      });
    }
  })()`;
}

export function activeComposerRunExpression() {
  return `(() => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) return { active: false, reason: "missing_composer" };
    const stop = findComposerButton((button) => {
      const label = getButtonLabel(button);
      return label.includes("stop");
    });
    if (!stop) return { active: false, reason: "no_active_codex_run" };
    return { active: true };

    function findComposerButton(predicate) {
      return Array.from(document.querySelectorAll("button")).find((button) => {
        if (!String(button.className || "").includes("size-token-button-composer")) {
          return false;
        }
        return predicate(button);
      });
    }

    function getButtonLabel(button) {
      return [
        button.innerText || "",
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
      ].join(" ").toLowerCase();
    }
  })()`;
}

export function clickComposerTextSubmitExpression() {
  return `(async () => {
    const send = findTextSubmitButton();
    if (!send) {
      return { ok: false, error: "missing text submit button" };
    }
    if (send.disabled || send.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "text submit button disabled" };
    }
    send.click();
    return { ok: true };

    function findTextSubmitButton() {
      const editor = document.querySelector(".ProseMirror");
      const hasText = Boolean((editor?.innerText || editor?.textContent || "").trim());
      if (!hasText) return null;
      return Array.from(document.querySelectorAll("button")).find((button) => {
        if (!String(button.className || "").includes("size-token-button-composer")) {
          return false;
        }
        const label = [
          button.innerText || "",
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
        ].join(" ").toLowerCase();
        return !label.includes("stop");
      });
    }
  })()`;
}

function composerSendReadyExpression() {
  return `Boolean((() => {
    const send = Array.from(document.querySelectorAll("button")).find((button) => {
      if (!String(button.className || "").includes("size-token-button-composer")) {
        return false;
      }
      const label = [
        button.innerText || "",
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      return !label.includes("stop");
    });
    return send && !send.disabled && send.getAttribute("aria-disabled") !== "true";
  })())`;
}

function composerTextSubmitReadyExpression() {
  return `Boolean((() => {
    const editor = document.querySelector(".ProseMirror");
    const hasText = Boolean((editor?.innerText || editor?.textContent || "").trim());
    if (!hasText) return false;
    const send = Array.from(document.querySelectorAll("button")).find((button) => {
      if (!String(button.className || "").includes("size-token-button-composer")) {
        return false;
      }
      const label = [
        button.innerText || "",
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      return !label.includes("stop");
    });
    return send && !send.disabled && send.getAttribute("aria-disabled") !== "true";
  })())`;
}

function composerDraftReadyExpression() {
  return `Boolean((() => {
    const editor = document.querySelector(".ProseMirror");
    return Boolean((editor?.innerText || editor?.textContent || "").trim());
  })())`;
}

function composerSubmissionStateExpression() {
  return `(() => {
    const marker = "aria-bridge-composer-submission-state";
    const editor = document.querySelector(".ProseMirror");
    const draftText = (editor?.innerText || editor?.textContent || "").trim();
    const stop = Array.from(document.querySelectorAll("button")).find((button) => {
      if (!String(button.className || "").includes("size-token-button-composer")) {
        return false;
      }
      const label = [
        button.innerText || "",
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      return label.includes("stop");
    });
    return {
      ok: true,
      marker,
      activeRun: Boolean(stop),
      draftLength: draftText.length,
      submitted: Boolean(stop) || draftText.length === 0,
    };
  })()`;
}

function modelReasoningControlCenterExpression() {
  return `(() => {
    const marker = "aria-bridge-model-reasoning-control-center";
    const control = modelReasoningControl();
    if (!control) return { ok: false, error: "model_reasoning_control_missing", marker };
    const rect = control.getBoundingClientRect();
    return {
      ok: true,
      marker,
      currentText: getControlText(control),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };

    function modelReasoningControl() {
      return Array.from(
        document.querySelectorAll('button,[role="button"],select,[aria-haspopup]'),
      ).find((control) => {
        if (!isVisible(control)) return false;
        const text = getControlText(control);
        return isCompactModelReasoningText(text) && Boolean(parseModelReasoning(text));
      });
    }

    function getControlText(control) {
      return [
        control.innerText || "",
        control.textContent || "",
        control.getAttribute("aria-label") || "",
        control.getAttribute("title") || "",
      ].join("\\n").trim();
    }

    function isVisible(control) {
      const rect = control.getBoundingClientRect();
      const style = window.getComputedStyle(control);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }

    function isCompactModelReasoningText(text) {
      const compact = String(text || "").replace(/\\s+/g, " ").trim();
      if (!compact || compact.length > 80) return false;
      return (
        /(^|\\b)(gpt[- ]?)?\\d+(?:\\.\\d+)?(\\b|$)/i.test(compact) &&
        /\\b(extra\\s+high|xhigh|high|medium|low)\\b/i.test(compact)
      );
    }

    function parseModelReasoning(text) {
      const compact = String(text || "").replace(/\\s+/g, " ").trim();
      if (!/(^|\\b)(gpt[- ]?)?\\d+(?:\\.\\d+)?(\\b|$)/i.test(compact)) return null;
      if (/\\b(extra\\s+high|xhigh|high|medium|low)\\b/i.test(compact)) return true;
      return null;
    }
  })()`;
}

function selectReasoningMenuItemExpression(reasoningText) {
  return `(() => {
    const marker = "aria-bridge-select-reasoning-menu-item";
    const target = ${JSON.stringify(reasoningText)};
    const item = Array.from(document.querySelectorAll('[role="menuitem"],button,[role="option"]'))
      .find((candidate) => isVisible(candidate) && normalizedText(candidate) === target);
    if (!item) {
      return {
        ok: false,
        error: "reasoning_menu_item_missing",
        marker,
        target,
        visibleItems: Array.from(document.querySelectorAll('[role="menuitem"],button,[role="option"]'))
          .filter(isVisible)
          .map(normalizedText)
          .filter(Boolean)
          .slice(-40),
      };
    }
    item.click();
    return { ok: true, marker, clicked: normalizedText(item) };

    function normalizedText(element) {
      return (element.innerText || element.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }
  })()`;
}

function extractReadyStateExpression() {
  return `(() => {
    const controls = modelReasoningControls();
    for (const control of controls) {
      const controlText = getControlText(control);
      const parsed = parseModelReasoning(controlText);
      if (parsed) return { ok: true, ...parsed, controlText };
    }
    return { ok: false, error: "model_reasoning_control_missing" };

    function modelReasoningControls() {
      return Array.from(
        document.querySelectorAll('button,[role="button"],select,[aria-haspopup]'),
      ).filter((control) => {
        if (!isVisible(control)) return false;
        const text = getControlText(control);
        return isCompactModelReasoningText(text) && Boolean(parseModelReasoning(text));
      });
    }

    function getControlText(control) {
      return [
        control.innerText || "",
        control.textContent || "",
        control.getAttribute("aria-label") || "",
        control.getAttribute("title") || "",
      ].join("\\n").trim();
    }

    function isVisible(control) {
      const rect = control.getBoundingClientRect();
      const style = window.getComputedStyle(control);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }

    function isCompactModelReasoningText(text) {
      const compact = String(text || "").replace(/\\s+/g, " ").trim();
      if (!compact || compact.length > 80) return false;
      return (
        /(^|\\b)(gpt[- ]?)?\\d+(?:\\.\\d+)?(\\b|$)/i.test(compact) &&
        /\\b(extra\\s+high|xhigh|high|medium|low)\\b/i.test(compact)
      );
    }

    function parseModelReasoning(text) {
      const parts = text
        .split(/\\n+/)
        .map((part) => part.replace(/\\s+/g, " ").trim())
        .filter(Boolean);
      if (parts.length === 0) return null;

      let modelText = "";
      let reasoningText = "";
      for (const part of parts) {
        const normalized = part.toLowerCase();
        const modelMatch = part.match(/(^|\\b)((?:gpt[- ]?)?\\d+(?:\\.\\d+)?)(\\b|$)/i);
        if (!modelText && modelMatch) {
          modelText = modelMatch[2];
        }
        if (!reasoningText && /\\bextra\\s+high\\b/i.test(normalized)) {
          reasoningText = "extra high";
          continue;
        }
        if (!reasoningText && /^(xhigh|high|medium|low)$/i.test(part)) {
          reasoningText = part;
        } else if (!reasoningText && /\\b(xhigh|high|medium|low)\\b/i.test(normalized)) {
          const match = normalized.match(/\\b(xhigh|high|medium|low)\\b/i);
          reasoningText = match ? match[1] : "";
        }
      }
      return modelText && reasoningText ? { modelText, reasoningText } : null;
    }
  })()`;
}

function codexReadyExpression({ modelTexts, reasoningTexts }) {
  return `Boolean((() => {
    const expectedModels = ${JSON.stringify(normalizeNeedles(modelTexts))};
    const expectedReasonings = ${JSON.stringify(normalizeNeedles(reasoningTexts))};
    const editor = document.querySelector(".ProseMirror");
    const activeThread = document.querySelector('[data-app-action-sidebar-thread-active="true"]');
    if (!editor || !activeThread) return false;

    const controls = modelReasoningControls();
    const modelReasoningReady = controls.some((control) => {
      const text = getControlText(control).replace(/\\s+/g, " ").trim().toLowerCase();
      if (!text) return false;
      return matchesAny(text, expectedModels) && matchesAny(text, expectedReasonings);
    });
    if (!modelReasoningReady) return false;

    return !Array.from(document.querySelectorAll("button")).some((button) => {
      if (!String(button.className || "").includes("size-token-button-composer")) return false;
      const label = [
        button.innerText || "",
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      return label.includes("stop");
    });

    function matchesAny(text, needles) {
      return needles.length === 0 || needles.some((needle) => text.includes(needle));
    }

    function modelReasoningControls() {
      return Array.from(
        document.querySelectorAll('button,[role="button"],select,[aria-haspopup]'),
      ).filter((control) => {
        if (!isVisible(control)) return false;
        return isCompactModelReasoningText(getControlText(control));
      });
    }

    function getControlText(control) {
      return [
        control.innerText || "",
        control.textContent || "",
        control.getAttribute("aria-label") || "",
        control.getAttribute("title") || "",
      ].join("\\n").trim();
    }

    function isVisible(control) {
      const rect = control.getBoundingClientRect();
      const style = window.getComputedStyle(control);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }

    function isCompactModelReasoningText(text) {
      const compact = String(text || "").replace(/\\s+/g, " ").trim();
      if (!compact || compact.length > 80) return false;
      return (
        /(^|\\b)(gpt[- ]?)?\\d+(?:\\.\\d+)?(\\b|$)/i.test(compact) &&
        /\\b(extra\\s+high|xhigh|high|medium|low)\\b/i.test(compact)
      );
    }
  })())`;
}

function normalizeNeedles(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function readyStateMatchesExpected(readyState, expected) {
  if (!readyState?.modelText || !readyState?.reasoningText) return false;
  return (
    textMatchesNeedles(readyState.modelText, expected.modelTexts) &&
    textMatchesNeedles(readyState.reasoningText, expected.reasoningTexts)
  );
}

function reasoningCorrectionTarget(readyState, expected) {
  if (!readyState?.modelText || !readyState?.reasoningText) return "";
  if (!textMatchesNeedles(readyState.modelText, expected.modelTexts)) return "";
  if (textMatchesNeedles(readyState.reasoningText, expected.reasoningTexts)) return "";
  return firstUiNeedle(expected.reasoningTexts);
}

function textMatchesNeedles(value, needles) {
  const text = String(value || "").trim().toLowerCase();
  const normalizedNeedles = normalizeNeedles(needles);
  if (!text || normalizedNeedles.length === 0) return false;
  return normalizedNeedles.some((needle) => text.includes(needle));
}

function firstUiNeedle(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function desiredReadyMismatch(desiredState, readyState) {
  return Boolean(
    (desiredState.modelText &&
      readyState.modelText &&
      !sameUiText(desiredState.modelText, readyState.modelText)) ||
      (desiredState.reasoningText &&
        readyState.reasoningText &&
        !sameUiText(desiredState.reasoningText, readyState.reasoningText)),
  );
}

function readyStateIsNewerThanDesired(desiredState, readyState, staleGraceMs) {
  const desiredMs = parseTimestampMs(desiredState.updatedAt);
  const readyMs = parseTimestampMs(readyState.observedAt);
  return desiredMs !== null && readyMs !== null && readyMs - desiredMs > staleGraceMs;
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function sameUiText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function ensurePreferredThreadExpression({ threadId, threadTitle }) {
  return `(async () => {
    const threadId = ${JSON.stringify(threadId || "")};
    const threadTitle = ${JSON.stringify(threadTitle || "")};
    const row = findPreferredThreadRow(threadId, threadTitle);
    if (!row) return { ok: false, error: "preferred_thread_row_missing", threadId, threadTitle };
    if (row.getAttribute("data-app-action-sidebar-thread-active") === "true") {
      return {
        ok: true,
        active: true,
        clicked: false,
        threadId: row.getAttribute("data-app-action-sidebar-thread-id") || "",
        threadTitle: row.getAttribute("data-app-action-sidebar-thread-title") || "",
      };
    }
    row.scrollIntoView({ block: "center" });
    row.click();
    return {
      ok: true,
      active: false,
      clicked: true,
      threadId: row.getAttribute("data-app-action-sidebar-thread-id") || "",
      threadTitle: row.getAttribute("data-app-action-sidebar-thread-title") || "",
    };

    function findPreferredThreadRow(id, title) {
      if (id) {
        const byId = Array.from(
          document.querySelectorAll("[data-app-action-sidebar-thread-row]"),
        ).find((candidate) =>
          sameThreadId(candidate.getAttribute("data-app-action-sidebar-thread-id") || "", id),
        );
        if (byId) return byId;
      }
      if (!title) return null;
      const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-row]"));
      return rows.find((candidate) =>
        candidate.getAttribute("data-app-action-sidebar-thread-title") === title &&
        candidate.getAttribute("data-app-action-sidebar-thread-pinned") === "true",
      ) || null;
    }

    function sameThreadId(candidate, expected) {
      const left = String(candidate || "");
      const right = String(expected || "");
      if (!left || !right) return false;
      return left === right || left.replace(/^local:/, "") === right.replace(/^local:/, "");
    }
  })()`;
}

function preferredThreadActiveExpression({ threadId, threadTitle }) {
  if (threadId) {
    return `Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-row]")).some((row) => {
      const candidate = String(row.getAttribute("data-app-action-sidebar-thread-id") || "");
      const expected = ${JSON.stringify(threadId)};
      return candidate && expected && candidate.replace(/^local:/, "") === expected.replace(/^local:/, "") && row.getAttribute("data-app-action-sidebar-thread-active") === "true";
    })`;
  }
  return `Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-row]")).some((row) => row.getAttribute("data-app-action-sidebar-thread-title") === ${JSON.stringify(
    threadTitle,
  )} && row.getAttribute("data-app-action-sidebar-thread-pinned") === "true" && row.getAttribute("data-app-action-sidebar-thread-active") === "true")`;
}
