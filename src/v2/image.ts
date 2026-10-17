// Карта общая для runtime и редактора — грузим и декодируем один раз,
// оба модуля переиспользуют тот же HTMLImageElement.
let cached: Promise<HTMLImageElement> | null = null;
const isDev = import.meta.env.DEV;
const basePath = isDev ? "/" : import.meta.env.BASE_URL;

const dungeonImgUrl = `${basePath}v2/assets/dungeon.png`;

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
