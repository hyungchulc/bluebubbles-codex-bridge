export function parseCodexControlCommand(text) {
  const raw = String(text || "").trim();
  const compact = raw.replace(/\s+/g, " ");
  if (!compact || compact.length > 220) return null;

  const slashCommand = compact.match(/^\/(model|reasoning)\b/i);
  if (!slashCommand) return null;
  const commandText = compact;
  if (!commandText.trim()) return null;

  const modelText = extractModelText(commandText);
  const reasoningText = extractReasoningText(commandText);
  if (!modelText && !reasoningText) return null;

  return {
    type: "codex_model_reasoning",
    modelText,
    reasoningText,
  };
}

export function parseCodexRawReasoningCommand(text) {
  const raw = String(text || "").trim();
  const compact = raw.replace(/\s+/g, " ");
  if (!compact || compact.length > 80) return null;

  const slashAlias = compact.match(/^\/(xhigh|x\s*high|extra\s+high|extrahigh|high|medium|med|low|minimal|none|off)$/i);
  const slashReasoning = compact.match(/^\/reasoning\s+(.+)$/i);
  const reasoningText = normalizeReasoningForUi(slashAlias?.[1] || slashReasoning?.[1] || "");
  if (!reasoningText) return null;

  return {
    type: "codex_raw_reasoning",
    reasoningText,
    prompt: `/reasoning ${reasoningText}`,
  };
}

export function normalizeModelForUi(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:gpt[-\s]?)?(\d+(?:\.\d+)?(?:[-\w]+)?)/i);
  return match ? match[1] : "";
}

export function normalizeModelForConfig(value) {
  const uiModel = normalizeModelForUi(value);
  if (!uiModel) return "";
  return /^gpt-/i.test(String(value || "").trim()) ? String(value).trim() : `gpt-${uiModel}`;
}

export function normalizeReasoningForUi(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return "";
  if (["xhigh", "x high", "extra high", "extrahigh", "엑스트라 하이"].includes(normalized)) {
    return "Extra High";
  }
  if (["high", "하이", "높음"].includes(normalized)) return "High";
  if (["medium", "med", "미디엄", "미디움", "중간"].includes(normalized)) return "Medium";
  if (["low", "로우", "낮음"].includes(normalized)) return "Low";
  if (["minimal", "최소"].includes(normalized)) return "Minimal";
  if (["none", "off", "없음"].includes(normalized)) return "None";
  return "";
}

export function normalizeReasoningForConfig(value) {
  const ui = normalizeReasoningForUi(value).toLowerCase();
  if (ui === "extra high") return "xhigh";
  return ui.replace(/\s+/g, "");
}

function extractModelText(text) {
  const slash = text.match(/^\/model(?:\s+(.+))?$/i);
  const scope = slash ? slash[1] || "" : text;
  const modelMatch = scope.match(/(?:모델|model)\s*(?:을|은|:|=|to)?\s*((?:gpt[-\s]?)?\d+(?:\.\d+)?(?:[-\w]+)?)/i)
    || scope.match(/\b((?:gpt[-\s]?)?\d+(?:\.\d+)?(?:[-\w]+)?)\s*(?:모델)?\s*(?:로|으로|쓰|사용|set|use|change|바꿔|바꾸|설정|해|하라)/i)
    || (slash ? scope.match(/\b((?:gpt[-\s]?)?\d+(?:\.\d+)?(?:[-\w]+)?)\b/i) : null);
  return normalizeModelForUi(modelMatch?.[1] || "");
}

function extractReasoningText(text) {
  const slash = text.match(/^\/reasoning(?:\s+(.+))?$/i);
  const scope = slash ? slash[1] || "" : text;
  const valuePattern =
    "(extra\\s+high|x\\s*high|xhigh|high|medium|med|low|minimal|none|off|엑스트라\\s*하이|하이|미디엄|미디움|로우|높음|중간|낮음|최소|없음)";
  const reasoningMatch = scope.match(
    new RegExp(
      `(?:reasoning|thinking(?:\\s+level)?|리저닝|추론|생각(?:\\s*수준)?)\\s*(?:을|은|:|=|to)?\\s*${valuePattern}`,
      "i",
    ),
  )
    || scope.match(
      new RegExp(
        `${valuePattern}\\s*(?:로|으로)?\\s*(?:reasoning|thinking|리저닝|추론)?\\s*(?:바꿔|바꾸|설정|해|하라|set|use|change)`,
        "i",
      ),
    )
    || (slash ? scope.match(new RegExp(`\\b${valuePattern}\\b`, "i")) : null);
  return normalizeReasoningForUi(reasoningMatch?.[1] || "");
}
