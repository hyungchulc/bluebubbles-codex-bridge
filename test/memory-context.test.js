import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryContext,
  buildMemoryQuery,
  filterRelevantCandidates,
  isRelevantHit,
  shouldIncludeDailyMemory,
  shouldRetrieveMemory,
} from "../src/memory-context.js";

test("skips trivial memory retrieval", () => {
  assert.equal(shouldRetrieveMemory({ query: "오케이" }), false);
});

test("retrieves for memory-shaped or substantial messages", () => {
  assert.equal(shouldRetrieveMemory({ query: "메모리 찾아오는 프로세스 뭐야" }), true);
  assert.equal(shouldRetrieveMemory({ query: "FaceTime audio raw endpoint 실패 기록" }), true);
  assert.equal(shouldRetrieveMemory({ query: "/steer active run only 새 작업 만들지 않게" }), true);
  assert.equal(shouldRetrieveMemory({ query: "트리거 리스트 업데이트되나" }), true);
  assert.equal(shouldRetrieveMemory({ query: "프롬프트 주입 쿼리 TRUNCATED 괜찮나" }), true);
  assert.equal(shouldRetrieveMemory({ query: "doctor warning 왜 저럼" }), true);
  assert.equal(shouldRetrieveMemory({ query: "CDP timeout health 다시 봐" }), true);
  assert.equal(
    shouldRetrieveMemory({
      query: "지금 시스템을 한번 점검하고 어디가 큰지 알려줘",
    }),
    true,
  );
});

test("builds a compact memory query from incoming text and reply context", () => {
  assert.equal(
    buildMemoryQuery({
      incoming: { text: "왜 자동으로 안하냐?" },
      replyContextText: "- target text: 메모리 찾아오는 프로세스",
    }),
    "왜 자동으로 안하냐? - target text: 메모리 찾아오는 프로세스",
  );
});

test("includes daily memory for recent recall checks", async () => {
  assert.equal(shouldIncludeDailyMemory("브라우저유즈 네이버 테스트 했는지 기억나"), true);
  assert.equal(shouldIncludeDailyMemory("메모리 찾아오는 프로세스 뭐야"), false);

  const execFileImpl = (_python, args, _options, callback) => {
    assert.equal(args.includes("--include-daily"), true);
    callback(
      null,
      JSON.stringify({
        ok: true,
        query: "브라우저유즈 네이버 테스트 했는지 기억나",
        classification: { intent: "recent_context" },
        candidates: [
          {
            rel_path: "05 daily/2026-05-04.md",
            score: 43.5,
            line_start: 10,
            title: "Browser Use Naver smoke",
            memory_type: "episodic",
            reasons: ["preferred_layer=05 daily", "branch=assistant-operations", "hint=daily"],
            text: "Browser Use opened Naver successfully.",
          },
        ],
      }),
    );
  };

  const text = await buildMemoryContext({
    incoming: { text: "브라우저유즈 네이버 테스트 했는지 기억나" },
    config: {
      memoryContextEnabled: true,
      memoryContextScript: "/example/local-assistant/scripts/memory_retrieve.py",
    },
    execFileImpl,
  });

  assert.match(text, /05 daily\/2026-05-04\.md:10/);
});

test("formats retrieved memory hits as prompt context", async () => {
  const execFileImpl = (_python, args, _options, callback) => {
    assert.deepEqual(args.slice(0, 2), [
      "/example/local-assistant/scripts/memory_retrieve.py",
      "search",
    ]);
    callback(
      null,
      JSON.stringify({
        ok: true,
        query: "메모리 찾아오는 프로세스",
        classification: { intent: "memory_routing" },
        candidates: [
          {
            rel_path: "contracts/retrieval-routing.md",
            score: 47.5,
            line_start: 31,
            title: "Domain-first lookup",
            memory_type: "procedural",
            reasons: ["preferred_layer=contracts", "domain=memory-governance", "hint=retrieval-routing"],
            text: "infer likely tree and branch from the query",
          },
        ],
      }),
    );
  };

  const text = await buildMemoryContext({
    incoming: { text: "메모리 찾아오는 프로세스 뭐야" },
    config: {
      memoryContextEnabled: true,
      memoryContextScript: "/example/local-assistant/scripts/memory_retrieve.py",
    },
    execFileImpl,
  });

  assert.match(text, /^# Local Memory Retrieval/);
  assert.match(text, /contracts\/retrieval-routing\.md:31/);
  assert.match(text, /Intent: memory_routing/);
  assert.match(text, /infer likely tree and branch/);
});

test("filters low-relevance memory hits before prompt injection", async () => {
  const execFileImpl = (_python, _args, _options, callback) => {
    callback(
      null,
      JSON.stringify({
        ok: true,
        query: "추가로 시간이 얼마나 더 걸리니",
        classification: { intent: "tool_capability" },
        candidates: [
          {
            score: 25.5,
            rel_path: "04 stm/aria-operations/routing-delivery/aria-operations__routing-delivery__STM.md",
            line_start: 251,
            title: "visibility",
            memory_type: "procedural",
            reasons: ["term_hits=2", "domain=aria-operations", "no_intent_hint"],
            text: "not actually relevant",
          },
        ],
      }),
    );
  };

  const text = await buildMemoryContext({
    incoming: { text: "추가로 시간이 얼마나 더 걸리니?" },
    config: {
      memoryContextEnabled: true,
      memoryContextScript: "/example/local-assistant/scripts/memory_retrieve.py",
    },
    execFileImpl,
  });

  assert.equal(text, null);
});

test("keeps high-signal memory hits", () => {
  assert.equal(
    isRelevantHit({
      score: 45.5,
      reasons: ["term_hits=2", "branch=memory-discipline", "hint=memory"],
    }),
    true,
  );
  assert.deepEqual(
    filterRelevantCandidates([
      { score: 25.5, reasons: ["term_hits=2", "no_intent_hint"] },
      { score: 45.5, reasons: ["branch=memory-discipline", "hint=memory"] },
    ]),
    [{ score: 45.5, reasons: ["branch=memory-discipline", "hint=memory"] }],
  );
});

test("filters broad high-score hits without routing evidence", () => {
  assert.equal(
    isRelevantHit({
      score: 52.5,
      reasons: ["term_hits=2", "preferred_layer=04 stm", "memory_type=episodic", "domain=aria-operations"],
    }),
    false,
  );
  assert.equal(
    isRelevantHit({
      score: 62.5,
      reasons: ["term_hits=4", "preferred_layer=04 stm", "memory_type=episodic", "domain=aria-operations"],
    }),
    true,
  );
});

test("filters recent-context hits that lack query-specific evidence", () => {
  const classification = {
    intent: "recent_context",
    matched_keywords: ["방금", "지금"],
    domain_hints: [{ matched_keywords: ["bridge", "브릿지", "프롬프트"] }],
    branch_hints: [{ matched_keywords: ["메모리", "서치"] }],
  };

  assert.deepEqual(
    filterRelevantCandidates(
      [
        {
          score: 56.5,
          rel_path: "04 stm/aria-operations/assistant-operations/prompt-plugin-audio.md",
          title: "bridge reactions were narrowed",
          reasons: ["term_hits=3", "preferred_layer=04 stm", "branch=assistant-operations", "hint=daily"],
        },
        {
          score: 56.5,
          rel_path: "04 stm/aria-operations/assistant-operations/market-briefing-hourly-daily.md",
          title: "the format was lengthened and cleaned up",
          text: "market brief formatting",
          reasons: ["term_hits=3", "preferred_layer=04 stm", "branch=assistant-operations", "hint=daily"],
        },
      ],
      { classification },
    ),
    [
      {
        score: 56.5,
        rel_path: "04 stm/aria-operations/assistant-operations/prompt-plugin-audio.md",
        title: "bridge reactions were narrowed",
        reasons: ["term_hits=3", "preferred_layer=04 stm", "branch=assistant-operations", "hint=daily"],
      },
    ],
  );
});

test("returns null when retrieval command fails", async () => {
  const execFileImpl = (_python, _args, _options, callback) => {
    callback(new Error("timeout"), "");
  };

  const text = await buildMemoryContext({
    incoming: { text: "메모리 찾아오는 프로세스 뭐야" },
    config: {
      memoryContextEnabled: true,
      memoryContextScript: "/example/local-assistant/scripts/memory_retrieve.py",
    },
    execFileImpl,
  });

  assert.equal(text, null);
});
