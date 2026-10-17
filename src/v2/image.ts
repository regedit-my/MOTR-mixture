// Карта общая для runtime и редактора — грузим и декодируем один раз,
// оба модуля переиспользуют тот же HTMLImageElement.
let cached: Promise<HTMLImageElement> | null = null;

// Дев-сервер раздаёт public/ от корня проекта (нужен префикс v2/),
// а в проде страница уже лежит внутри dist/v2/, картинка рядом с ней.
const dungeonImgUrl = import.meta.env.DEV ? "/v2/assets/dungeon.png" : "assets/dungeon.png";

export function loadMapImage(): Promise<HTMLImageElement> {
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Не удалось загрузить картинку подземелья"));
      img.src = dungeonImgUrl;
    });
  }
  return cached;
}
