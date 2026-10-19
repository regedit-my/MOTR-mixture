let cached: Promise<HTMLImageElement> | null = null;

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
