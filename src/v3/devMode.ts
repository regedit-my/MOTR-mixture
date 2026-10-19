export function applyDevVisibility(): void {
  if (import.meta.env.DEV) return;
  document.getElementById("debugSection")?.remove();
  document.getElementById("copyPresetBtn")?.remove();
  document.getElementById("presetOutput")?.remove();
}
