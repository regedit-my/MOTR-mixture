export function applyDevVisibility(): void {
  if (import.meta.env.DEV) return;
  document.getElementById("devNav")?.remove();
  document.getElementById("debugSection")?.remove();
}
