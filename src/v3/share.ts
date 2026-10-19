import type { PresetMap } from "./types";

export interface ShareState {
  n: number;
  names: string[];
  preset?: PresetMap;
}

function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function compressBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeShareState(state: ShareState): Promise<string> {
  const payload = {
    n: state.n,
    names: state.names,
    p: state.preset?.paths.map((path) => path.points.map((pt) => [pt.x, pt.y])),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));

  const supportsCompression = typeof CompressionStream !== "undefined";
  const packed = supportsCompression ? await compressBytes(bytes) : bytes;
  return (supportsCompression ? "1" : "0") + bytesToBase64Url(packed);
}

export async function decodeShareState(h: string): Promise<ShareState | null> {
  try {
    const marker = h[0];
    const bytes = base64UrlToBytes(h.slice(1));
    const raw = marker === "1" ? await decompressBytes(bytes) : bytes;
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed?.n !== "number" || !Array.isArray(parsed?.names)) return null;

    const preset: PresetMap | undefined = Array.isArray(parsed?.p)
      ? {
          paths: parsed.p.map((points: unknown) => ({
            points: Array.isArray(points)
              ? points
                  .filter(
                    (pt: unknown): pt is [number, number] =>
                      Array.isArray(pt) && typeof pt[0] === "number" && typeof pt[1] === "number",
                  )
                  .map(([x, y]: [number, number]) => ({ x, y }))
              : [],
          })),
        }
      : undefined;

    return { n: parsed.n, names: parsed.names.map((x: unknown) => String(x)), preset };
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
    }
  }
  prompt("Скопируй ссылку вручную:", text);
  return false;
}
