// В проде убираем служебную навигацию (#devNav) и debug-панель (#debugSection) —
// они нужны только при разработке (npm run dev), в собранном сайте их не должно
// быть вообще (не просто скрыты — полностью убраны из DOM).
export function applyDevVisibility(): void {
  if (import.meta.env.DEV) return;
  document.getElementById("devNav")?.remove();
  document.getElementById("debugSection")?.remove();
}
