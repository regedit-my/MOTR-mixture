// Кодируем состояние (сколько участников, их имена и порядок = назначение
// линий) в компактную URL-safe строку для параметра ?h=... — так ссылкой
// можно поделиться, и у всех откроется та же раскладка имён по линиям.
export interface ShareState {
  n: number;
  names: string[];
}

export function encodeShareState(state: ShareState): string {
  const json = JSON.stringify(state);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShareState(h: string): ShareState | null {
  try {
    const b64 = h.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
    const parsed = JSON.parse(json);
    if (typeof parsed?.n !== "number" || !Array.isArray(parsed?.names)) return null;
    return { n: parsed.n, names: parsed.names.map((x: unknown) => String(x)) };
  } catch {
    return null;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // упадёт в prompt ниже
    }
  }
  prompt("Скопируй ссылку вручную:", text);
  return false;
}
