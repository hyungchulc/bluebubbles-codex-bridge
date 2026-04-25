import assert from "node:assert/strict";
import test from "node:test";

import { CdpPage, CodexDesktopCdp } from "../src/codex-cdp.js";

test("bringToFront sends a CDP page wake command", async () => {
  const socket = new FakeSocket();
  const page = new CdpPage(socket, 1_000);

  await page.bringToFront();

  assert.deepEqual(
    socket.sent.map((message) => message.method),
    ["Page.bringToFront"],
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
