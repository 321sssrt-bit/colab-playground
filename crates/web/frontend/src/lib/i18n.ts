export type Locale = "en-US" | "zh-CN" | "zh-TW" | "ja-JP" | "ko-KR";

export type Dictionary = Readonly<Record<string, string>>;

export function detectBrowserLocale(): Locale {
  const tag = (navigator.language || "en-US").toLowerCase();
  if (
    tag.startsWith("zh-tw") ||
    tag.startsWith("zh-hk") ||
    tag.startsWith("zh-mo") ||
    tag.includes("hant")
  ) {
    return "zh-TW";
  }
  if (tag.startsWith("zh")) {
    return "zh-CN";
  }
  if (tag.startsWith("ja")) {
    return "ja-JP";
  }
  if (tag.startsWith("ko")) {
    return "ko-KR";
  }
  return "en-US";
}

export async function loadDictionary(
  locale: Locale,
  signal: AbortSignal,
): Promise<Dictionary> {
  const response = await fetch(`/assets/i18n/${locale}.json`, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as Dictionary;
}
