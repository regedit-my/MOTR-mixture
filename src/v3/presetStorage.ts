import type { PresetData } from "./types";

const PRESET_STORAGE_VERSION = 1;
const PRESET_STORAGE_KEY = `motr:v3:preset:v${PRESET_STORAGE_VERSION}`;

export function loadStoredPreset(): PresetData | null {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.maps !== "object") return null;
    return parsed as PresetData;
  } catch {
    return null;
  }
}

export function saveStoredPreset(data: PresetData): boolean {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
