import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCurrentContext,
  formatCurrentContext,
} from "../src/current-context.js";

const ZONE_TAB = [
  "KR\t+3733+12658\tAsia/Seoul",
  "SE\t+5920+01803\tEurope/Stockholm",
  "US\t+404251-0740023\tAmerica/New_York\tEastern (most areas)",
].join("\n");

test("builds current time and FindMy location context", async () => {
  const execCalls = [];
  const context = await buildCurrentContext({
    now: new Date("2026-05-19T17:42:10.000Z"),
    config: {
      currentContextTimeZone: "Europe/Stockholm",
      currentLocationTokenPath: "/token",
      currentLocationRefreshUrl: "http://127.0.0.1:43123/refresh",
      currentLocationStopBin: "/usr/local/bin/findmy-stop",
      currentLocationTimeZoneDbPath: "/zones",
    },
    readFileImpl: async (path) => {
      if (path === "/zones") return ZONE_TAB;
      assert.equal(path, "/token");
      return "token-1\n";
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:43123/refresh");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer token-1");
      return new Response(
        JSON.stringify({
          current: {
            ok: true,
            generatedAt: "2026-05-19T17:42:09.000Z",
            runtimeAuthority: "aria",
            primaryPerson: {
              displayName: "형철",
              address: "Stockholm, Sweden",
              latitude: 59.3293,
              longitude: 18.0686,
              mapsUrl: "https://maps.apple.com/?ll=59.3293,18.0686",
            },
          },
        }),
        { status: 200 },
      );
    },
    execFileImpl: (...args) => {
      execCalls.push(args);
      args.at(-1)(null, "", "");
    },
  });

  assert.equal(context.time.timeZone, "Europe/Stockholm");
  assert.match(context.time.local, /2026-05-19T19:42:10 Europe\/Stockholm/);
  assert.equal(context.location.ok, true);
  assert.equal(context.location.address, "Stockholm, Sweden");
  assert.equal(context.location.freshness, "fresh");
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0].slice(0, 2), [
    "/usr/bin/sudo",
    ["-n", "/usr/local/bin/findmy-stop"],
  ]);

  const text = formatCurrentContext(context);
  assert.match(text, /^# Current Context/);
  assert.match(text, /Current location: 형철 \| Stockholm, Sweden \| 59\.3293,18\.0686/);
  assert.match(text, /Location source: FindMy localhost \/refresh/);
  assert.match(text, /Location freshness\/confidence: fresh/);
});

test("falls back to current location when FindMy refresh fails", async () => {
  const calls = [];
  const context = await buildCurrentContext({
    now: new Date("2026-05-19T17:42:10.000Z"),
    config: {
      currentContextTimeZone: "Europe/Stockholm",
      currentLocationTokenPath: "/token",
      currentLocationRefreshUrl: "http://127.0.0.1:43123/refresh",
    },
    readFileImpl: async () => "token-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (url.endsWith("/refresh")) {
        return new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 });
      }
      assert.equal(url, "http://127.0.0.1:43123/current");
      return new Response(
        JSON.stringify({
          ok: true,
          generatedAt: "2026-05-19T17:42:09.000Z",
          runtimeAuthority: "aria",
          primaryPerson: {
            displayName: "John",
            address: "Spånga • 1 min. ago",
            latitude: 59.3769,
            longitude: 17.9115,
            mapsUrl: "https://maps.apple.com/?ll=59.3769,17.9115&q=John",
          },
        }),
        { status: 200 },
      );
    },
    execFileImpl: (...args) => args.at(-1)(null, "", ""),
  });

  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:43123/refresh", method: "POST" },
    { url: "http://127.0.0.1:43123/current", method: "GET" },
  ]);
  assert.equal(context.location.ok, true);
  assert.equal(context.location.source, "FindMy localhost /current fallback");
  assert.equal(context.location.address, "Spånga • 1 min. ago");
  assert.match(formatCurrentContext(context), /Location source: FindMy localhost \/current fallback/);
});

test("records unavailable location when FindMy refresh and current fallback fail", async () => {
  const context = await buildCurrentContext({
    now: new Date("2026-05-19T17:42:10.000Z"),
    config: {
      currentContextTimeZone: "Europe/Stockholm",
      currentLocationTokenPath: "/token",
    },
    readFileImpl: async () => "token-1",
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
    execFileImpl: (...args) => args.at(-1)(null, "", ""),
  });

  assert.equal(context.location.ok, false);
  assert.match(context.location.freshness, /unavailable: refresh_failed/);
  assert.match(formatCurrentContext(context), /Current location: unavailable/);
});

test("labels fresh row coordinate fallback separately from direct fresh coordinates", async () => {
  const context = await buildCurrentContext({
    now: new Date("2026-05-19T17:42:10.000Z"),
    config: {
      currentContextTimeZone: "Europe/Stockholm",
      currentLocationTokenPath: "/token",
    },
    readFileImpl: async () => "token-1",
    fetchImpl: async () => new Response(
      JSON.stringify({
        current: {
          ok: true,
          generatedAt: "2026-05-19T17:42:09.000Z",
          runtimeAuthority: "aria",
          primaryPerson: {
            displayName: "John",
            status: "fresh-row-coordinate-fallback",
            address: "Spånga • Now",
            latitude: 59.3769,
            longitude: 17.9115,
            mapsUrl: "https://maps.apple.com/?ll=59.3769,17.9115&q=John",
          },
        },
      }),
      { status: 200 },
    ),
    execFileImpl: (...args) => args.at(-1)(null, "", ""),
  });

  assert.equal(context.location.ok, true);
  assert.equal(context.location.rawStatus, "fresh-row-coordinate-fallback");
  assert.equal(context.location.freshness, "fresh row + fallback coords");
  assert.match(formatCurrentContext(context), /Location freshness\/confidence: fresh row \+ fallback coords/);
});

test("infers time zone from FindMy coordinates", async () => {
  const context = await buildCurrentContext({
    now: new Date("2026-05-19T17:42:10.000Z"),
    config: {
      currentContextTimeZone: "Europe/Stockholm",
      currentLocationTokenPath: "/token",
      currentLocationTimeZoneDbPath: "/zones",
    },
    readFileImpl: async (path) => {
      if (path === "/zones") return ZONE_TAB;
      return "token-1";
    },
    fetchImpl: async () => new Response(
      JSON.stringify({
        current: {
          ok: true,
          generatedAt: "2026-05-19T17:42:09.000Z",
          primaryPerson: {
            displayName: "형철",
            address: "Seoul, Korea",
            latitude: 37.5665,
            longitude: 126.9780,
          },
        },
      }),
      { status: 200 },
    ),
    execFileImpl: (...args) => args.at(-1)(null, "", ""),
  });

  assert.equal(context.time.timeZone, "Asia/Seoul");
  assert.match(context.time.local, /2026-05-20T02:42:10 Asia\/Seoul/);
  assert.match(formatCurrentContext(context), /User timezone: Asia\/Seoul/);
});

test("falls back to system time zone when location is unavailable", async () => {
  const context = await buildCurrentContext({
    now: new Date("2026-05-19T17:42:10.000Z"),
    config: {
      currentLocationEnabled: false,
      currentSystemTimeZone: "Asia/Tokyo",
    },
  });

  assert.equal(context.location.ok, false);
  assert.equal(context.time.timeZone, "Asia/Tokyo");
  assert.match(formatCurrentContext(context), /User timezone: Asia\/Tokyo/);
});

test("uses unknown time zone when location and system time zone are unavailable", async () => {
  const originalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function DateTimeFormatShim(...args) {
    if (args.length === 0) {
      return {
        resolvedOptions: () => ({}),
      };
    }
    return new originalDateTimeFormat(...args);
  };
  try {
    const context = await buildCurrentContext({
      now: new Date("2026-05-19T17:42:10.000Z"),
      config: {
        currentLocationEnabled: false,
      },
    });

    assert.equal(context.location.ok, false);
    assert.equal(context.time.timeZone, null);
    assert.equal(context.time.local, "2026-05-19T17:42:10.000Z");
    assert.match(formatCurrentContext(context), /User timezone: unknown/);
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
  }
});
