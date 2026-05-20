import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BlueBubblesClient } from "../src/bluebubbles.js";
import {
  buildGeneratedRichLinkPayload,
  buildNativeRichLinkPreflightDecision,
  chooseNativeRichLinkPreflightRoute,
  choosePreflightRichLinkRoute,
  chooseTextSendRoute,
  getLinkPreviewMode,
  hasHttpUrl,
  isAppleMapsDirectionsUrl,
  isGeneratedRichLinkPayloadWorthSending,
  isSingleHttpUrl,
  prepareLinkPreviewText,
  shouldRequestDdScan,
  splitTextForLinkPreviewMessages,
} from "../src/link-preview.js";

test("detects http and https links for link preview scans", () => {
  assert.equal(hasHttpUrl("see https://example.com/path?q=1"), true);
  assert.equal(hasHttpUrl("see http://example.com"), true);
  assert.equal(hasHttpUrl("plain text only"), false);
  assert.equal(hasHttpUrl("www.example.com without protocol"), false);
});

test("detects URL-only messages separately from mixed prose", () => {
  assert.equal(isSingleHttpUrl("https://example.com/path?q=1"), true);
  assert.equal(isSingleHttpUrl("  https://example.com/path?q=1  "), true);
  assert.equal(isSingleHttpUrl("see https://example.com/path?q=1"), false);
  assert.equal(isSingleHttpUrl("https://example.com and text"), false);
});

test("defaults link previews to generated mode, not ddScan", () => {
  withLinkPreviewMode(null, () => {
    assert.equal(getLinkPreviewMode(), "generated");
    assert.equal(shouldRequestDdScan({ chatGuid: "chat-1", text: "https://example.com" }), false);
  });
  withLinkPreviewMode("native", () => {
    assert.equal(getLinkPreviewMode(), "native");
    assert.equal(shouldRequestDdScan({ chatGuid: "chat-1", text: "https://example.com" }), true);
    assert.equal(shouldRequestDdScan({ chatGuid: "chat-1", text: "see https://example.com" }), false);
    assert.equal(shouldRequestDdScan({ chatGuid: "chat-1", text: "no link" }), false);
    assert.equal(shouldRequestDdScan({ address: "person@example.com", text: "https://example.com" }), false);
  });
});

test("routes URL-only chat sends through generated preview payloads by default", () => {
  withLinkPreviewMode(null, () => {
    assert.deepEqual(
      chooseTextSendRoute({
        chatGuid: "chat-1",
        text: "https://example.com",
      }),
      {
        method: "private-api",
        ddScan: false,
        generatedLinkPreview: true,
        previewMode: "generated",
      },
    );
  });
  assert.deepEqual(
    chooseTextSendRoute({
      chatGuid: "chat-1",
      text: "see https://example.com",
    }),
    {
      method: "apple-script",
      ddScan: false,
      generatedLinkPreview: false,
      previewMode: "generated",
    },
  );
});

test("native mode is an explicit ddScan rollback path", () => {
  withLinkPreviewMode("native", () => {
    assert.deepEqual(
      chooseTextSendRoute({
        chatGuid: "chat-1",
        text: "https://example.com",
      }),
      {
        method: "private-api",
        ddScan: true,
        generatedLinkPreview: false,
        previewMode: "native",
      },
    );
  });
});

test("routes Apple Maps directions URLs through generated directions payloads", async () => {
  const url = "https://maps.apple.com/?saddr=59.3769,17.9115&daddr=59.342892,18.049998&dirflg=r";
  assert.equal(isAppleMapsDirectionsUrl(url), true);
  assert.equal(isAppleMapsDirectionsUrl("https://maps.apple.com/?ll=59.3769,17.9115&q=John"), false);
  assert.deepEqual(await buildNativeRichLinkPreflightDecision(url), {
    route: "generated",
    reason: "apple_maps_directions_payload",
    payload: null,
  });
});

test("builds Apple Maps directions payload with LPMapMetadata specialization", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        "<html><head>",
        '<meta property="og:title" content="Apple Maps">',
        '<meta property="og:description" content="Odenplan">',
        '<meta property="og:site_name" content="Maps">',
        "</head></html>",
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } },
    );

  try {
    const payload = await buildGeneratedRichLinkPayload(
      "https://maps.apple.com/?saddr=59.3769,17.9115&daddr=59.342892,18.049998&dirflg=r",
      { skipLinkPresentation: true },
    );
    const archiveText = Buffer.from(payload.payloadData, "base64").toString("latin1");

    assert.equal(payload.previewKind, "apple_maps_directions");
    assert.equal(payload.title, "Directions to Odenplan");
    assert.equal(payload.attachmentFilePath, null);
    assert.match(archiveText, /LPMapMetadata/);
    assert.match(archiveText, /specialization2/);
    assert.match(archiveText, /Directions to Odenplan/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses named Apple Maps daddr over generic metadata summaries", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        "<html><head>",
        '<meta property="og:title" content="Apple Maps">',
        '<meta property="og:description" content="Stockholm County">',
        '<meta property="og:site_name" content="Maps">',
        "</head></html>",
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } },
    );

  try {
    const payload = await buildGeneratedRichLinkPayload(
      "https://maps.apple.com/?saddr=59.3769,17.9115&daddr=T-Centralen%2C%20Stockholm&dirflg=r",
      { skipLinkPresentation: true },
    );
    const archiveText = Buffer.from(payload.payloadData, "base64").toString("latin1");

    assert.equal(payload.title, "Directions to T-Centralen, Stockholm");
    assert.match(archiveText, /Directions to T-Centralen, Stockholm/);
    assert.match(archiveText, /LPMapMetadata/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Apple Maps q as the display label for coordinate destinations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        "<html><head>",
        '<meta property="og:title" content="Apple Maps">',
        '<meta property="og:description" content="Stockholm County">',
        '<meta property="og:site_name" content="Maps">',
        "</head></html>",
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } },
    );

  try {
    const payload = await buildGeneratedRichLinkPayload(
      "https://maps.apple.com/?saddr=59.3769,17.9115&daddr=59.332444,18.060674&dirflg=r&q=T-Centralen",
      { skipLinkPresentation: true },
    );
    const archiveText = Buffer.from(payload.payloadData, "base64").toString("latin1");

    assert.equal(payload.title, "Directions to T-Centralen");
    assert.match(archiveText, /Directions to T-Centralen/);
    assert.match(archiveText, /T-Centralen/);
    assert.match(archiveText, /LPMapMetadata/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes URL-only ddScan text without changing mixed prose", () => {
  assert.equal(prepareLinkPreviewText(" https://example.com/path "), "https://example.com/path");
  assert.equal(prepareLinkPreviewText("see https://example.com/path"), "see https://example.com/path");
});

test("accepts generated rich links when payload and attachment are useful", () => {
  assert.equal(
    isGeneratedRichLinkPayloadWorthSending(
      {
        payloadData: "abc",
        source: "generated",
        title: "574 Core - New Balance",
        resolvedUrl: "https://www.newbalance.com/pd/574-core/ML574EVN-D-105.html",
        attachmentFilePath: "/tmp/favicon.pluginPayloadAttachment",
      },
      "https://www.newbalance.com/pd/574-core/ML574EVN-D-105.html",
    ),
    true,
  );
  assert.equal(
    isGeneratedRichLinkPayloadWorthSending(
      {
        payloadData: "abc",
        source: "generated",
        title: "Sign-in",
        resolvedUrl: "https://accounts.google.com/v3/signin/identifier",
        attachmentFilePath: "/tmp/favicon.pluginPayloadAttachment",
      },
      "https://docs.google.com/document/d/example/edit",
    ),
    true,
  );
  assert.equal(
    isGeneratedRichLinkPayloadWorthSending(
      {
        payloadData: "abc",
        source: "generated",
        title: "Apple",
        resolvedUrl: "https://www.apple.com/",
        attachmentFilePath: "/tmp/icon.pluginPayloadAttachment",
        nativeLikelyUseful: true,
      },
      "https://www.apple.com/",
    ),
    true,
  );
  assert.equal(
    isGeneratedRichLinkPayloadWorthSending(
      {
        payloadData: "abc",
        source: "generated",
        title: "Apple",
        resolvedUrl: "https://www.apple.com/",
      },
      "https://www.apple.com/",
    ),
    false,
  );
});

test("generated rich links prefer page images over favicon when allowed", async () => {
  const originalFetch = globalThis.fetch;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "rich-link-preview-"));
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/large.png")) {
      return new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(
      [
        "<html><head>",
        '<meta property="og:title" content="Large Preview">',
        '<meta property="og:image" content="https://example.com/large.png">',
        '<link rel="icon" href="/favicon.ico">',
        "</head></html>",
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } },
    );
  };

  try {
    const payload = await buildGeneratedRichLinkPayload("https://example.com/article", {
      skipLinkPresentation: true,
      outputDir,
    });
    const archiveText = Buffer.from(payload.payloadData, "base64").toString("latin1");

    assert.equal(payload.attachmentRole, "image");
    assert.ok(fs.existsSync(payload.attachmentFilePath));
    assert.match(archiveText, /imageMetadata/);
    assert.match(archiveText, /RichLinkImageAttachmentSubstitute/);
    assert.match(archiveText, /large\.png/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("preflight keeps generated payloads even when native previews look useful", () => {
  const decision = choosePreflightRichLinkRoute(
    {
      payloadData: "abc",
      source: "generated",
      title: "Apple",
      resolvedUrl: "https://www.apple.com/",
      attachmentFilePath: "/tmp/icon.pluginPayloadAttachment",
      nativeLikelyUseful: true,
    },
    "https://www.apple.com/",
  );
  assert.deepEqual(decision, {
    route: "generated",
    reason: "generated_favicon_fallback",
    payload: {
      payloadData: "abc",
      source: "generated",
      title: "Apple",
      resolvedUrl: "https://www.apple.com/",
      attachmentFilePath: "/tmp/icon.pluginPayloadAttachment",
      nativeLikelyUseful: true,
    },
  });
});

test("preflight routes weak native previews to generated favicon payload", () => {
  const payload = {
    payloadData: "abc",
    source: "generated",
    title: "Tax summaries - PwC",
    resolvedUrl: "https://taxsummaries.pwc.com/",
    attachmentFilePath: "/tmp/favicon.pluginPayloadAttachment",
    nativeLikelyUseful: false,
  };
  assert.deepEqual(choosePreflightRichLinkRoute(payload, "https://taxsummaries.pwc.com/"), {
    route: "generated",
    reason: "generated_favicon_fallback",
    payload,
  });
});

test("native preflight keeps useful LinkPresentation previews on ddScan", () => {
  assert.deepEqual(
    chooseNativeRichLinkPreflightRoute({
      ok: true,
      title: "Apple Store",
      icon: { filePath: "/tmp/apple.pluginPayloadAttachment" },
    }),
    {
      route: "native",
      reason: "native_likely_useful",
      payload: null,
    },
  );
});

test("native preflight falls back when LinkPresentation is unavailable or weak", () => {
  assert.deepEqual(chooseNativeRichLinkPreflightRoute(null), {
    route: "generated",
    reason: "native_preflight_unavailable",
    payload: null,
  });
  assert.deepEqual(
    chooseNativeRichLinkPreflightRoute({
      ok: true,
      title: "Only title",
    }),
    {
      route: "generated",
      reason: "native_preview_not_useful",
      payload: null,
    },
  );
});

test("splits mixed prose and URLs into preview-ready messages", () => {
  assert.deepEqual(splitTextForLinkPreviewMessages("문서 봐\n\nhttps://example.com/path"), [
    { text: "문서 봐", urlOnly: false },
    { text: "https://example.com/path", urlOnly: true },
  ]);
  assert.deepEqual(splitTextForLinkPreviewMessages("문서:\nhttps://example.com/path."), [
    { text: "문서:", urlOnly: false },
    { text: "https://example.com/path", urlOnly: true },
  ]);
  assert.deepEqual(splitTextForLinkPreviewMessages("https://example.com/path"), [
    { text: "https://example.com/path", urlOnly: true },
  ]);
});

test("splits multiple mixed URLs into preview-ready messages", () => {
  assert.deepEqual(splitTextForLinkPreviewMessages("A https://a.example/x\nB https://b.example/y"), [
    { text: "A", urlOnly: false },
    { text: "https://a.example/x", urlOnly: true },
    { text: "B", urlOnly: false },
    { text: "https://b.example/y", urlOnly: true },
  ]);
});

test("covers outbound link layout scenarios", () => {
  const cases = [
    {
      name: "plain text",
      text: "그냥 일반 답변",
      expected: [{ text: "그냥 일반 답변", urlOnly: false }],
    },
    {
      name: "single preview link",
      text: "https://example.com/article",
      expected: [{ text: "https://example.com/article", urlOnly: true }],
    },
    {
      name: "prose with one link",
      text: "본문 안 링크 https://example.com/article",
      expected: [
        { text: "본문 안 링크", urlOnly: false },
        { text: "https://example.com/article", urlOnly: true },
      ],
    },
    {
      name: "prose with multiple links",
      text: "본문\nhttps://example.com/a\nhttps://example.com/b",
      expected: [
        { text: "본문", urlOnly: false },
        { text: "https://example.com/a", urlOnly: true },
        { text: "https://example.com/b", urlOnly: true },
      ],
    },
    {
      name: "source names and links",
      text: [
        "출처",
        "WHO",
        "ECDC",
        "",
        "출처 링크",
        "https://www.who.int",
        "https://www.ecdc.europa.eu",
      ].join("\n"),
      expected: [
        { text: "출처\nWHO\nECDC\n\n출처 링크", urlOnly: false },
        { text: "https://www.who.int", urlOnly: true },
        {
          text: "https://www.ecdc.europa.eu",
          urlOnly: true,
        },
      ],
    },
    {
      name: "assignment with URL",
      text: "OPENAI_BASE_URL=https://api.openai.com",
      expected: [{ text: "OPENAI_BASE_URL=https://api.openai.com", urlOnly: false }],
    },
    {
      name: "Korean particle after URL",
      text: "https://example.com를 보면 됨",
      expected: [{ text: "https://example.com를 보면 됨", urlOnly: false }],
    },
  ];

  for (const { name, text, expected } of cases) {
    assert.deepEqual(splitTextForLinkPreviewMessages(text), expected, name);
  }
});

test("splits citation URLs into preview bubbles", () => {
  assert.deepEqual(
    splitTextForLinkPreviewMessages("참고로 확인한 Compustat item list:\nhttps://excelmine.com/crsp-compustat-annual-data-item/"),
    [
      { text: "참고로 확인한 Compustat item list:", urlOnly: false },
      { text: "https://excelmine.com/crsp-compustat-annual-data-item/", urlOnly: true },
    ],
  );
  assert.deepEqual(
    splitTextForLinkPreviewMessages("Source:\nhttps://example.com/source\n\n다음 문장"),
    [
      { text: "Source:", urlOnly: false },
      { text: "https://example.com/source", urlOnly: true },
      { text: "다음 문장", urlOnly: false },
    ],
  );
});

test("keeps environment assignment URLs in the same message", () => {
  assert.deepEqual(
    splitTextForLinkPreviewMessages(
      "BINANCE_ENV=testnet\nBINANCE_FUTURES_REST_BASE_URL=https://demo-fapi.binance.com",
    ),
    [
      {
        text: "BINANCE_ENV=testnet\nBINANCE_FUTURES_REST_BASE_URL=https://demo-fapi.binance.com",
        urlOnly: false,
      },
    ],
  );
  assert.deepEqual(
    splitTextForLinkPreviewMessages("설명 https://example.com\nBINANCE_FUTURES_REST_BASE_URL=https://fapi.binance.com"),
    [
      { text: "설명", urlOnly: false },
      { text: "https://example.com", urlOnly: true },
      { text: "BINANCE_FUTURES_REST_BASE_URL=https://fapi.binance.com", urlOnly: false },
    ],
  );
});

test("does not split placeholders or URLs attached to Korean particles", () => {
  assert.deepEqual(splitTextForLinkPreviewMessages("KEY=https://...를 자동 분리했어"), [
    { text: "KEY=https://...를 자동 분리했어", urlOnly: false },
  ]);
  assert.deepEqual(splitTextForLinkPreviewMessages("문서 https://example.com를 봐"), [
    { text: "문서 https://example.com를 봐", urlOnly: false },
  ]);
});

test("BlueBubblesClient forwards the ddScan flag in text sends", async () => {
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 200, data: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new BlueBubblesClient({
      baseUrl: "http://127.0.0.1:1234",
      password: "pw",
      sendTextPath: "/api/v1/message/text",
    });

    await client.sendText({
      chatGuid: "chat-1",
      text: "https://example.com",
      method: "private-api",
      ddScan: true,
    });

    assert.equal(body.ddScan, true);
    assert.equal(body.method, "private-api");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("BlueBubblesClient forwards rich link payload fields in text sends", async () => {
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 200, data: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new BlueBubblesClient({
      baseUrl: "http://127.0.0.1:1234",
      password: "pw",
      sendTextPath: "/api/v1/message/text",
    });

    await client.sendText({
      chatGuid: "chat-1",
      text: "https://example.com",
      method: "private-api",
      ddScan: false,
      payloadData: "cGF5bG9hZA==",
      balloonBundleId: "com.apple.messages.URLBalloonProvider",
    });

    assert.equal(body.ddScan, false);
    assert.equal(body.payloadData, "cGF5bG9hZA==");
    assert.equal(body.balloonBundleId, "com.apple.messages.URLBalloonProvider");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("BlueBubblesClient aborts timed-out text sends", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) =>
    await new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });

  try {
    const client = new BlueBubblesClient({
      baseUrl: "http://127.0.0.1:1234",
      password: "pw",
      sendTextPath: "/api/v1/message/text",
    });

    await assert.rejects(
      () =>
        client.sendText({
          chatGuid: "chat-1",
          text: "https://example.com",
          method: "private-api",
          ddScan: true,
          timeoutMs: 5,
        }),
      /BlueBubbles send timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function withLinkPreviewMode(mode, callback) {
  const previousMode = process.env.BLUEBUBBLES_LINK_PREVIEW_MODE;
  try {
    if (mode == null) {
      delete process.env.BLUEBUBBLES_LINK_PREVIEW_MODE;
    } else {
      process.env.BLUEBUBBLES_LINK_PREVIEW_MODE = mode;
    }
    return callback();
  } finally {
    if (previousMode === undefined) {
      delete process.env.BLUEBUBBLES_LINK_PREVIEW_MODE;
    } else {
      process.env.BLUEBUBBLES_LINK_PREVIEW_MODE = previousMode;
    }
  }
}
