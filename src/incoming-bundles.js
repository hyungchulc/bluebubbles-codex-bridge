const urlPattern = /https?:\/\/\S+/i;
const urlPatternGlobal = /https?:\/\/\S+/gi;

const linkCuePatterns = [
  /(링크|url|주소|웹|브라우저|browser|크롬|chrome|사파리|safari).{0,30}(열|들어|접속|봐|확인|가능|해봐|가봐)/i,
  /(열|들어|접속|봐|확인|가능|해봐|가봐).{0,30}(링크|url|주소|웹|브라우저|browser|크롬|chrome|사파리|safari)/i,
  /(이거|이것|여기|저거|요거|그거).{0,30}(열|들어|접속|브라우저|browser|크롬|chrome|사파리|safari|웹)/i,
  /(이거|이것|여기|저거|요거|그거).{0,30}(들어올 수|들어갈 수|접속할 수|볼 수|봐줄 수)/i,
];

const referenceCuePatterns = [
  /(가이드|guidance|guide|docs?|문서|레퍼런스|reference|공식|소스|출처|사이트|페이지).{0,30}(따라|참조|기준|보고|봐|확인|적용|반영|맞춰|최적화|해야|하자|쓰|써)/i,
  /(따라|참조|기준|보고|봐|확인|적용|반영|맞춰|최적화|해야|하자|쓰|써).{0,30}(가이드|guidance|guide|docs?|문서|레퍼런스|reference|공식|소스|출처|사이트|페이지)/i,
  /(gpt[-\s]?5(?:\.5)?|openai|codex).{0,30}(프롬프트|prompt).{0,30}(가이드|guidance|guide|docs?|문서)/i,
  /(프롬프트|prompt).{0,30}(가이드|guidance|guide|docs?|문서).{0,30}(따라|참조|기준|적용|반영|맞춰|최적화|해야|하자)/i,
];

export function getIncomingBundleDelayMs(
  items,
  { defaultDelayMs, linkDelayMs },
) {
  const normalDelay = validDelay(defaultDelayMs, 1800);
  const delayedLinkDelay = validDelay(linkDelayMs, 8000);
  return shouldUseLinkBundleDelay(items) ? delayedLinkDelay : normalDelay;
}

export function shouldUseLinkBundleDelay(items) {
  if (!Array.isArray(items) || items.length === 0) return false;

  const texts = items.map((item) => normalizeText(item?.text)).filter(Boolean);
  if (texts.length === 0) return false;

  const hasUrl = texts.some((text) => urlPattern.test(text));
  if (hasUrl) {
    return items.length === 1 && isUrlOnlyText(texts[0]);
  }

  return texts.some(hasPendingLinkCue);
}

export function isUrlOnlyText(text) {
  const normalized = normalizeText(text);
  if (!urlPattern.test(normalized)) return false;
  const remainder = normalized
    .replace(urlPatternGlobal, "")
    .replace(/[<>()\[\]{}"'`.,!?:;\s-]+/g, "");
  return remainder.length === 0;
}

export function hasPendingLinkCue(text) {
  const normalized = normalizeText(text);
  if (!normalized || urlPattern.test(normalized)) return false;
  if (/^(이거|이것|여기|저거|요거|그거|this|here)$/i.test(normalized)) {
    return true;
  }
  return (
    linkCuePatterns.some((pattern) => pattern.test(normalized)) ||
    referenceCuePatterns.some((pattern) => pattern.test(normalized))
  );
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function validDelay(value, fallback) {
  const delay = Number(value);
  return Number.isFinite(delay) && delay > 0 ? delay : fallback;
}
