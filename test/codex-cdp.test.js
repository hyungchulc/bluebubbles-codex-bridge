import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeComposerRunExpression,
  CdpPage,
  codexAppOpenArgs,
  CodexDesktopCdp,
  clickComposerSendExpression,
  clickComposerTextSubmitExpression,
  fillPromptExpression,
  injectPromptExpression,
} from "../src/codex-cdp.js";

const defaultStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cdp-default-state-"));
process.env.CODEX_READY_STATE_PATH = path.join(defaultStateDir, "ready.json");
process.env.CODEX_DESIRED_STATE_PATH = path.join(defaultStateDir, "desired.json");

test("bringToFront sends a CDP page wake command", async () => {
  const socket = new FakeSocket();
  const page = new CdpPage(socket, 1_000);

  await page.bringToFront();

  assert.deepEqual(
    socket.sent.map((message) => message.method),
    ["Page.bringToFront"],
  );
});

test("pressCommandEnter sends a macOS Command+Enter key chord", async () => {
  const socket = new FakeSocket();
  const page = new CdpPage(socket, 1_000);

  await page.pressCommandEnter();

  assert.deepEqual(
    socket.sent.map((message) => [message.method, message.params.type]),
    [
      ["Input.dispatchKeyEvent", "rawKeyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ],
  );
  assert.deepEqual(
    socket.sent.map((message) => message.params.modifiers),
    [4, 4],
  );
  assert.deepEqual(
    socket.sent.map((message) => message.params.key),
    ["Enter", "Enter"],
  );
});

test("pressEnter sends a plain Enter key chord", async () => {
  const socket = new FakeSocket();
  const page = new CdpPage(socket, 1_000);

  await page.pressEnter();

  assert.deepEqual(
    socket.sent.map((message) => [message.method, message.params.type]),
    [
      ["Input.dispatchKeyEvent", "rawKeyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ],
  );
  assert.deepEqual(
    socket.sent.map((message) => message.params.modifiers),
    [0, 0],
  );
  assert.deepEqual(
    socket.sent.map((message) => message.params.key),
    ["Enter", "Enter"],
  );
});

test("wakeCodex nudges the renderer without bringing the page forward by default", async () => {
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
  });
  const page = new FakePage();

  await codex.wakeCodex(page);

  assert.equal(page.nudgeCount, 1);
  assert.equal(page.bringToFrontCount, 0);
});

test("wakeCodexTargets nudges every Codex page target before prompt injection", async () => {
  const pages = [];
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    connectPage: async (url) => {
      const page = new FakePage(url);
      pages.push(page);
      return page;
    },
  });

  await codex.wakeCodexTargets([
    {
      type: "page",
      url: "app://-/index.html?hostId=first",
      webSocketDebuggerUrl: "ws://first",
    },
    {
      type: "worker",
      url: "",
      webSocketDebuggerUrl: "ws://worker",
    },
    {
      type: "page",
      url: "app://-/index.html?hostId=second",
      webSocketDebuggerUrl: "ws://second",
    },
  ]);

  assert.deepEqual(
    pages.map((page) => [page.url, page.nudgeCount, page.closed]),
    [
      ["ws://first", 1, true],
      ["ws://second", 1, true],
    ],
  );
});

test("withPage nudges only the selected Codex target by default", async () => {
  const previousFetch = globalThis.fetch;
  const pages = [];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        targetForId("selected-target"),
        {
          id: "other-target",
          type: "page",
          title: "Codex",
          url: "app://-/index.html?hostId=other",
          webSocketDebuggerUrl: "ws://other-target",
        },
      ],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      connectPage: async (url) => {
        const page = new FakePage(url);
        pages.push(page);
        return page;
      },
    });

    await codex.withPage(async () => {});
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    pages.map((page) => [page.url, page.nudgeCount, page.closed]),
    [["ws://selected-target", 1, true]],
  );
});

test("withPage brings only the selected Codex target forward when enabled", async () => {
  const previousFetch = globalThis.fetch;
  const pages = [];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        targetForId("selected-target"),
        {
          id: "other-target",
          type: "page",
          title: "Codex",
          url: "app://-/index.html?hostId=other",
          webSocketDebuggerUrl: "ws://other-target",
        },
      ],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      bringToFrontBeforePrompt: true,
      connectPage: async (url) => {
        const page = new FakePage(url);
        pages.push(page);
        return page;
      },
    });

    await codex.withPage(async () => {});
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    pages.map((page) => [page.url, page.nudgeCount, page.bringToFrontCount, page.closed]),
    [["ws://selected-target", 1, 1, true]],
  );
});

test("withPage launches Codex hidden and retries when no CDP page target exists", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  const wakeCalls = [];
  const pages = [];
  try {
    globalThis.fetch = async () => {
      calls.push("fetch");
      return {
        ok: true,
        json: async () =>
          calls.length === 1 ? [] : [targetForId("selected-after-wake")],
      };
    };
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "/Applications/Codex.app",
      wakeAppBeforePrompt: true,
      sleep: async () => {},
      wakeApp: async (...args) => wakeCalls.push(args),
      connectPage: async (url) => {
        const page = new FakePage(url);
        pages.push(page);
        return page;
      },
    });

    await codex.withPage(async () => {});
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(wakeCalls, [
    ["/Applications/Codex.app", "http://127.0.0.1:9229"],
  ]);
  assert.deepEqual(
    pages.map((page) => [page.url, page.nudgeCount, page.bringToFrontCount, page.closed]),
    [["ws://selected-after-wake", 1, 0, true]],
  );
});

test("withPage does not launch Codex when an existing CDP target is available", async () => {
  const previousFetch = globalThis.fetch;
  const wakeCalls = [];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("selected-target")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "/Applications/Codex.app",
      wakeAppBeforePrompt: true,
      wakeApp: async (...args) => wakeCalls.push(args),
      connectPage: async () => new FakePage(),
    });

    await codex.withPage(async () => {});
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(wakeCalls, []);
});

test("keepAliveRenderer nudges only the selected Codex target without foregrounding", async () => {
  const previousFetch = globalThis.fetch;
  const pages = [];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        targetForId("selected-target"),
        {
          id: "other-target",
          type: "page",
          title: "Codex",
          url: "app://-/index.html?hostId=other",
          webSocketDebuggerUrl: "ws://other-target",
        },
      ],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      bringToFrontBeforePrompt: true,
      connectPage: async (url) => {
        const page = new FakePage(url);
        pages.push(page);
        return page;
      },
    });

    const result = await codex.keepAliveRenderer();

    assert.deepEqual(result, { ok: true, targetId: "selected-target" });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    pages.map((page) => [page.url, page.nudgeCount, page.bringToFrontCount, page.closed]),
    [["ws://selected-target", 1, 0, true]],
  );
});

test("codexAppOpenArgs launches hidden with remote debugging arguments", () => {
  assert.deepEqual(
    codexAppOpenArgs("/Applications/Codex.app", "http://127.0.0.1:9229"),
    [
      "-g",
      "-j",
      "-n",
      "-a",
      "/Applications/Codex.app",
      "--args",
      "--remote-debugging-port=9229",
      "--remote-allow-origins=http://127.0.0.1:9229",
    ],
  );
});

test("withPage requests a post-restart delay on first or changed Codex targets", async () => {
  const previousFetch = globalThis.fetch;
  const targetIds = ["target-a", "target-a", "target-b"];
  const contexts = [];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId(targetIds.shift())],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => new FakePage(),
    });

    await codex.withPage(async (_page, context) => contexts.push(context));
    await codex.withPage(async (_page, context) => contexts.push(context));
    await codex.withPage(async (_page, context) => contexts.push(context));
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    contexts.map((context) => context.postRestartDelayNeeded),
    [true, false, true],
  );
  assert.deepEqual(
    contexts.map((context) => context.targetChanged),
    [false, false, true],
  );
});

test("preferred thread selection does not wait before prompt injection", async () => {
  const sleeps = [];
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    preferredThreadId: "thread-1",
    postRestartThreadDelayMs: 30_000,
    sleep: async (ms) => sleeps.push(ms),
  });
  const page = new PreferredThreadPage();

  await codex.ensurePreferredThread(page);

  assert.deepEqual(sleeps, []);
});

test("preferred thread active wait follows the selected row id", async () => {
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    preferredThreadId: "stale-thread-id",
    preferredThreadTitle: "Aria",
  });
  const page = new SelectedThreadPage();

  await codex.ensurePreferredThread(page);

  assert.match(page.waits[0].expression, /current-thread-id/);
  assert.doesNotMatch(page.waits[0].expression, /stale-thread-id/);
});

test("prompt injection clicks send without an embedded post-restart delay", () => {
  const expression = injectPromptExpression("hello");

  assert.doesNotMatch(expression, /submitDelayMs/);
  assert(
    expression.indexOf('document.execCommand("insertText"') <
      expression.indexOf("send.click()"),
  );
  assert.doesNotMatch(expression, /setTimeout/);
});

test("prompt injection never treats the Stop composer button as Send", () => {
  const expression = injectPromptExpression("hello");

  assert.match(expression, /isIdleComposerSendButton/);
  assert.match(expression, /label\.includes\("stop"\)/);
});

test("prompt fill is separate from composer send click", () => {
  const expression = fillPromptExpression("hello");

  assert.match(expression, /insertText/);
  assert.doesNotMatch(expression, /\.click\(\)/);
  assert.doesNotMatch(expression, /setTimeout/);
});

test("composer send click rejects the Stop button state", () => {
  const expression = clickComposerSendExpression();

  assert.match(expression, /findIdleComposerSendButton/);
  assert.match(expression, /label\.includes\("stop"\)/);
  assert.match(expression, /send\.click\(\)/);
});

test("active composer run detection looks only for the composer Stop control", () => {
  const expression = activeComposerRunExpression();

  assert.match(expression, /size-token-button-composer/);
  assert.match(expression, /label\.includes\("stop"\)/);
  assert.match(expression, /no_active_codex_run/);
});

test("steer submit requires draft text and rejects the Stop button", () => {
  const expression = clickComposerTextSubmitExpression();

  assert.match(expression, /hasText/);
  assert.match(expression, /label\.includes\("stop"\)/);
  assert.match(expression, /send\.click\(\)/);
});

test("post-restart readiness waits for model and reasoning UI twice", async () => {
  const sleeps = [];
  const page = new PreferredThreadPage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    postRestartReadyTimeoutMs: 60_000,
    desiredStatePath: "",
    readyModelTexts: ["5.5", "gpt-6"],
    readyReasoningTexts: ["High", "xhigh"],
    sleep: async (ms) => sleeps.push(ms),
  });

  await codex.waitForPostRestartReady(page, "request-1");

  assert.equal(page.waits.length, 2);
  assert.match(page.waits[0].expression, /expectedModels/);
  assert.match(page.waits[0].expression, /expectedReasonings/);
  assert.match(page.waits[0].expression, /button,\[role="button"\],select,\[aria-haspopup\]/);
  assert.match(page.waits[0].expression, /compact\.length > 80/);
  assert.match(page.waits[0].expression, /gpt-6/);
  assert.match(page.waits[0].expression, /xhigh/);
  assert.match(page.waits[0].expression, /size-token-button-composer/);
  assert.equal(page.waits[0].timeoutMs, 5_000);
  assert.equal(page.waits[1].timeoutMs, 5_000);
  assert.deepEqual(sleeps, [1_000]);
});

test("post-restart readiness keeps checking until strict model UI is detected", async () => {
  const sleeps = [];
  const page = new StrictReadinessEventuallyReadyPage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    postRestartReadyTimeoutMs: 60_000,
    desiredStatePath: "",
    readyModelTexts: ["5.5"],
    readyReasoningTexts: ["High"],
    sleep: async (ms) => sleeps.push(ms),
  });

  await codex.waitForPostRestartReady(page, "request-1");

  assert.equal(page.waits.length, 4);
  assert.match(page.waits[0].expression, /expectedModels/);
  assert.match(page.waits[1].expression, /expectedModels/);
  assert.match(page.waits[2].expression, /expectedModels/);
  assert.match(page.waits[3].expression, /expectedModels/);
  assert.deepEqual(sleeps, [1_000, 1_000, 1_000]);
});

test("post-restart readiness ignores stale captured model state", async () => {
  const statePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-ready-state-")),
    "state.json",
  );
  const sleeps = [];
  const page = new ReadyStatePage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    readyStatePath: statePath,
    desiredStatePath: "",
    readyModelTexts: ["5.5"],
    readyReasoningTexts: ["Extra High"],
    sleep: async (ms) => sleeps.push(ms),
  });

  await codex.captureReadyState(page, "request-1");
  await codex.waitForPostRestartReady(page, "request-1");

  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(stored.modelText, "gpt-7");
  assert.equal(stored.reasoningText, "xhigh");
  assert.doesNotMatch(page.waits[0].expression, /gpt-7/);
  assert.doesNotMatch(page.waits[0].expression, /"xhigh"/);
  assert.match(page.waits[0].expression, /5\.5/);
  assert.match(page.waits[0].expression, /extra high/);
});

test("desired model state overrides env readiness defaults", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desired-state-"));
  const desiredStatePath = path.join(dir, "desired.json");
  fs.writeFileSync(
    desiredStatePath,
    `${JSON.stringify({ modelText: "5.4", reasoningText: "Medium" })}\n`,
  );
  const page = new ReadyStatePage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    desiredStatePath,
    readyModelTexts: ["5.5"],
    readyReasoningTexts: ["Extra High"],
  });

  await codex.waitForPostRestartReady(page, "request-1");

  assert.match(page.waits[0].expression, /5\.4/);
  assert.match(page.waits[0].expression, /medium/);
  assert.doesNotMatch(page.waits[0].expression, /5\.5/);
  assert.doesNotMatch(page.waits[0].expression, /extra high/);
});

test("stale desired reasoning state refreshes from newer ready state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stale-desired-state-"));
  const desiredStatePath = path.join(dir, "desired.json");
  const readyStatePath = path.join(dir, "ready.json");
  fs.writeFileSync(
    desiredStatePath,
    `${JSON.stringify({
      reasoningText: "High",
      updatedAt: "2026-04-28T17:12:22.628Z",
    })}\n`,
  );
  fs.writeFileSync(
    readyStatePath,
    `${JSON.stringify({
      modelText: "5.5",
      reasoningText: "extra high",
      controlText: "5.5\nExtra High",
      observedAt: "2026-04-28T22:51:00.275Z",
    })}\n`,
  );
  const page = new PreferredThreadPage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    desiredStatePath,
    readyStatePath,
    readyModelTexts: ["5.5"],
    readyReasoningTexts: ["High"],
  });

  await codex.waitForPostRestartReady(page, "request-1");

  const stored = JSON.parse(fs.readFileSync(desiredStatePath, "utf8"));
  assert.equal(stored.reasoningText, "Extra High");
  assert.match(page.waits[0].expression, /extra high/);
  assert.doesNotMatch(page.waits[0].expression, /"high"/);
});

test("post-restart readiness falls back to live observed state", async () => {
  const sleeps = [];
  const page = new NeverStrictReadyPage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    postRestartReadyTimeoutMs: 1,
    desiredStatePath: "",
    readyModelTexts: ["gpt-7"],
    readyReasoningTexts: ["xhigh"],
    sleep: async (ms) => sleeps.push(ms),
  });

  await codex.waitForPostRestartReady(page, "request-1");

  assert.equal(page.captureCount, 2);
  assert.equal(page.waits.length > 0, true);
  assert.equal(sleeps.includes(1_000), true);
});

test("post-restart readiness does not trust stored ready state without live UI match", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stored-ready-state-"));
  const readyStatePath = path.join(dir, "ready.json");
  fs.writeFileSync(
    readyStatePath,
    `${JSON.stringify({
      modelText: "5.5",
      reasoningText: "Extra High",
      controlText: "5.5\nExtra High",
      observedAt: "2026-05-07T19:58:00.000Z",
    })}\n`,
  );
  const page = new NeverStrictReadyPage();
  const codex = new CodexDesktopCdp({
    remoteDebugUrl: "http://127.0.0.1:9229",
    responseTimeoutMs: 1_000,
    appPath: "",
    readyStatePath,
    desiredStatePath: "",
    postRestartReadyTimeoutMs: 1,
    readyModelTexts: ["5.5"],
    readyReasoningTexts: ["Extra High"],
  });

  await assert.rejects(
    () => codex.waitForPostRestartReady(page, "request-1"),
    /Timed out waiting for post-restart Codex model\/reasoning UI/,
  );

  assert.equal(page.captureCount > 0, true);
});

test("prompt submission waits for visible model UI even on a reused target", async () => {
  const previousFetch = globalThis.fetch;
  const pages = [new RawSubmitPage(), new RawSubmitPage()];
  let pageIndex = 0;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-reused")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => pages[pageIndex++],
    });

    await codex.submitPromptToComposer("one", "request-1");
    await codex.submitPromptToComposer("two", "request-2");

    assert.equal(
      pages[1].waits.some((wait) => wait.expression.includes("expectedModels")),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt submission corrects visible Medium reasoning to desired Extra High before fill", async () => {
  const previousFetch = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desired-reasoning-submit-"));
  const desiredStatePath = path.join(dir, "desired.json");
  fs.writeFileSync(
    desiredStatePath,
    `${JSON.stringify({ reasoningText: "Extra High" })}\n`,
  );
  const page = new ReasoningSelectorPage({ initialReasoning: "Medium" });
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-medium-reasoning")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      desiredStatePath,
      connectPage: async () => page,
    });

    await codex.submitPromptToComposer("after correction", "request-medium");

    const selectIndex = page.evaluations.findIndex((expression) =>
      expression.includes("aria-bridge-select-reasoning-menu-item"),
    );
    const fillIndex = page.evaluations.findIndex((expression) =>
      expression.includes("insertText"),
    );
    assert.equal(page.selectedReasoning, "Extra High");
    assert.equal(selectIndex >= 0, true);
    assert.equal(fillIndex > selectIndex, true);
    assert.equal(page.closed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("raw Codex commands are submitted without a bridge request prefix", async () => {
  const previousFetch = globalThis.fetch;
  const page = new RawSubmitPage();
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-raw")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => page,
    });

    const result = await codex.submitRawCommand("/steer keep this thread focused");

    assert.equal(result.prompt, "/steer keep this thread focused");
    const fillExpression = page.evaluations.find((expression) =>
      expression.includes("insertText"),
    );
    assert.match(fillExpression, /\/steer keep this thread focused/);
    assert.doesNotMatch(fillExpression, /bridge_request_id/);
    assert.equal(page.closed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("normal prompt submission tries plain Enter before keyboard and click fallbacks", async () => {
  const previousFetch = globalThis.fetch;
  const page = new RawSubmitPage();
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-enter-submit")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => page,
    });

    await codex.submitPromptToComposer("send this normally", "request-enter");

    assert.equal(page.enterCount, 1);
    assert.equal(page.commandEnterCount, 0);
    assert.equal(
      page.evaluations.some((expression) =>
        expression.includes("aria-bridge-composer-submission-state"),
      ),
      true,
    );
    assert.equal(page.closed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("normal prompt submission recovers when send-ready polling stalls after fill", async () => {
  const previousFetch = globalThis.fetch;
  const firstPage = new SendReadyTimeoutPage();
  const recoveredPage = new RawSubmitPage();
  const pages = [firstPage, recoveredPage];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-send-ready-recovery")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 10_000,
      appPath: "",
      wakeBeforePrompt: false,
      sleep: async () => {},
      connectPage: async () => pages.shift(),
    });

    await codex.submitPromptToComposer("recover this prompt", "request-recover-send");

    assert.equal(firstPage.enterCount, 0);
    assert.equal(recoveredPage.enterCount, 1);
    assert.equal(firstPage.closed, true);
    assert.equal(recoveredPage.closed, true);
    assert.equal(
      firstPage.evaluations.some((expression) => expression.includes("insertText")),
      true,
    );
    assert.equal(
      recoveredPage.evaluations.some((expression) => expression.includes("insertText")),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("normal prompt submission reconnects before retrying after submit-state timeout", async () => {
  const previousFetch = globalThis.fetch;
  const firstPage = new SubmitStateTimeoutPage();
  const recoveredPage = new RawSubmitPage();
  const pages = [firstPage, recoveredPage];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-submit-state-recovery")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 10_000,
      appPath: "",
      wakeBeforePrompt: false,
      sleep: async () => {},
      connectPage: async () => pages.shift(),
    });

    await codex.submitPromptToComposer("recover after enter", "request-recover-submit");

    assert.equal(firstPage.enterCount, 1);
    assert.equal(recoveredPage.enterCount, 0);
    assert.equal(firstPage.closed, true);
    assert.equal(recoveredPage.closed, true);
    assert.equal(
      recoveredPage.evaluations.some((expression) =>
        expression.includes("aria-bridge-composer-submission-state"),
      ),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reasoning aliases change the Codex UI selector directly", async () => {
  const previousFetch = globalThis.fetch;
  const page = new ReasoningSelectorPage();
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-reasoning-selector")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => page,
    });

    const result = await codex.setReasoningLevel("Extra High");

    assert.equal(result.status, "set");
    assert.equal(result.reasoningText, "Extra High");
    assert.equal(page.selectedReasoning, "Extra High");
    assert.equal(page.mouseEvents.length, 2);
    assert.equal(page.closed, true);
    assert.equal(page.evaluations.some((expression) => expression.includes("insertText")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("steer notes are submitted with Command+Enter without a bridge request prefix", async () => {
  const previousFetch = globalThis.fetch;
  const page = new ActiveSteerPage();
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-steer")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => page,
    });

    const result = await codex.submitSteer("keep this thread focused");

    assert.equal(result.status, "steered");
    assert.match(result.requestId, /^bb-steer-/);
    assert.equal(result.prompt, "keep this thread focused");
    const fillExpression = page.evaluations.find((expression) =>
      expression.includes("insertText"),
    );
    assert.match(fillExpression, /keep this thread focused/);
    assert.doesNotMatch(fillExpression, /\/steer/);
    assert.doesNotMatch(fillExpression, /bridge_request_id/);
    assert.doesNotMatch(fillExpression, /This iMessage began with \/steer/);
    assert(
      page.evaluations.some((expression) =>
        expression.includes('label.includes("stop")'),
      ),
    );
    assert.equal(page.commandEnterCount, 1);
    assert.equal(page.closed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("steer notes do not create a new prompt when Codex is idle", async () => {
  const previousFetch = globalThis.fetch;
  const page = new IdleSteerPage();
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [targetForId("target-idle-steer")],
    });
    const codex = new CodexDesktopCdp({
      remoteDebugUrl: "http://127.0.0.1:9229",
      responseTimeoutMs: 1_000,
      appPath: "",
      wakeBeforePrompt: false,
      connectPage: async () => page,
    });

    const result = await codex.submitSteer("do not start a separate task");

    assert.equal(result.status, "ignored");
    assert.equal(result.reason, "no_active_codex_run");
    assert.equal(
      page.evaluations.some((expression) => expression.includes("insertText")),
      false,
    );
    assert.equal(page.closed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function targetForId(id) {
  return {
    id,
    type: "page",
    title: "Codex",
    url: "app://-/index.html?hostId=local",
    webSocketDebuggerUrl: `ws://${id}`,
  };
}

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    queueMicrotask(() => {
      this.listeners.get("message")?.({
        data: JSON.stringify({ id: message.id, result: {} }),
      });
    });
  }

  close() {}
}

class FakePage {
  constructor(url = "ws://fake") {
    this.url = url;
  }

  nudgeCount = 0;
  bringToFrontCount = 0;
  closed = false;

  async nudgeRenderer() {
    this.nudgeCount += 1;
  }

  async bringToFront() {
    this.bringToFrontCount += 1;
  }

  close() {
    this.closed = true;
  }
}

class PreferredThreadPage {
  waits = [];

  async evaluate() {
    return { ok: true };
  }

  async waitForExpression(expression, timeoutMs) {
    this.waits.push({ expression, timeoutMs });
  }
}

class SelectedThreadPage extends PreferredThreadPage {
  async evaluate() {
    return { ok: true, threadId: "current-thread-id", threadTitle: "Aria" };
  }
}

class ReadyStatePage extends PreferredThreadPage {
  async evaluate() {
    return {
      ok: true,
      modelText: "gpt-7",
      reasoningText: "xhigh",
      controlText: "gpt-7\nxhigh",
    };
  }
}

class StrictReadinessEventuallyReadyPage extends PreferredThreadPage {
  failures = 2;

  async waitForExpression(expression, timeoutMs) {
    this.waits.push({ expression, timeoutMs });
    if (expression.includes("expectedModels") && this.failures > 0) {
      this.failures -= 1;
      throw new Error("strict readiness timeout");
    }
  }
}

class NeverStrictReadyPage extends ReadyStatePage {
  captureCount = 0;

  async waitForExpression(expression, timeoutMs) {
    this.waits.push({ expression, timeoutMs });
    if (expression.includes("expectedModels")) {
      throw new Error("strict readiness timeout");
    }
  }

  async evaluate(expression) {
    if (String(expression || "").includes("modelReasoningControls")) {
      this.captureCount += 1;
    }
    return super.evaluate(expression);
  }
}

class RawSubmitPage extends PreferredThreadPage {
  evaluations = [];
  closed = false;
  enterCount = 0;
  commandEnterCount = 0;
  nudgeCount = 0;
  bringToFrontCount = 0;

  async evaluate(expression) {
    this.evaluations.push(expression);
    if (expression.includes("aria-bridge-composer-submission-state")) {
      return { ok: true, activeRun: true, draftLength: 0, submitted: true };
    }
    return { ok: true };
  }

  close() {
    this.closed = true;
  }

  async pressCommandEnter() {
    this.commandEnterCount += 1;
  }

  async pressEnter() {
    this.enterCount += 1;
  }

  async nudgeRenderer() {
    this.nudgeCount += 1;
  }

  async bringToFront() {
    this.bringToFrontCount += 1;
  }
}

class SendReadyTimeoutPage extends RawSubmitPage {
  async waitForExpression(expression, timeoutMs) {
    this.waits.push({ expression, timeoutMs });
    if (expression.includes("return send && !send.disabled")) {
      throw new Error("Timed out waiting for CDP method Runtime.evaluate");
    }
  }
}

class SubmitStateTimeoutPage extends RawSubmitPage {
  submitStateFailures = 1;

  async evaluate(expression) {
    this.evaluations.push(expression);
    if (
      expression.includes("aria-bridge-composer-submission-state") &&
      this.submitStateFailures > 0
    ) {
      this.submitStateFailures -= 1;
      throw new Error("Timed out waiting for CDP method Runtime.evaluate");
    }
    if (expression.includes("aria-bridge-composer-submission-state")) {
      return { ok: true, activeRun: true, draftLength: 0, submitted: true };
    }
    return { ok: true };
  }
}

class ReasoningSelectorPage extends RawSubmitPage {
  constructor({ initialReasoning = "High" } = {}) {
    super();
    this.initialReasoning = initialReasoning;
  }

  mouseEvents = [];
  selectedReasoning = "";

  async request(method, params = {}) {
    if (method === "Input.dispatchMouseEvent") {
      this.mouseEvents.push(params);
      return {};
    }
    return {};
  }

  async evaluate(expression) {
    this.evaluations.push(expression);
    if (expression.includes("aria-bridge-composer-submission-state")) {
      return { ok: true, activeRun: true, draftLength: 0, submitted: true };
    }
    if (expression.includes("aria-bridge-model-reasoning-control-center")) {
      return {
        ok: true,
        currentText: `5.5 ${this.currentReasoning()}`,
        x: 966,
        y: 534,
      };
    }
    if (expression.includes("aria-bridge-select-reasoning-menu-item")) {
      this.selectedReasoning = expression.includes("Extra High") ? "Extra High" : "High";
      return { ok: true, clicked: this.selectedReasoning };
    }
    if (expression.includes("modelReasoningControls")) {
      return {
        ok: true,
        modelText: "5.5",
        reasoningText: this.currentReasoning(),
        controlText: `5.5\n${this.currentReasoning()}`,
      };
    }
    return { ok: true };
  }

  currentReasoning() {
    return this.selectedReasoning || this.initialReasoning;
  }
}

class ActiveSteerPage extends RawSubmitPage {
  async evaluate(expression) {
    this.evaluations.push(expression);
    if (expression.includes("no_active_codex_run")) {
      return { active: true };
    }
    return { ok: true };
  }
}

class IdleSteerPage extends RawSubmitPage {
  async evaluate(expression) {
    this.evaluations.push(expression);
    if (expression.includes("no_active_codex_run")) {
      return { active: false, reason: "no_active_codex_run" };
    }
    return { ok: true };
  }
}
