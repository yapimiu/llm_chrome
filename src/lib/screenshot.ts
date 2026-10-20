import { browser } from '#imports';

/** Ширина, до которой ужимается скриншот: больше модели не нужно, а токенов и трафика меньше. */
export const SCREENSHOT_MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;
/** Рамки с номерами рисуются через requestAnimationFrame — даём им попасть на экран. */
const PAINT_DELAY_MS = 120;

/** Размер после ужатия по ширине с сохранением пропорций. */
export function fitWidth(width: number, height: number, maxWidth = SCREENSHOT_MAX_WIDTH): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.round((height * maxWidth) / width) };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** Ужимает картинку (data:-адрес) до maxWidth и перекодирует в JPEG. В service worker — через OffscreenCanvas. */
async function shrink(dataUrl: string, maxWidth: number): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = fitWidth(bitmap.width, bitmap.height, maxWidth);
  if (size.width === bitmap.width && dataUrl.startsWith('data:image/jpeg')) {
    bitmap.close();
    return dataUrl;
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  return `data:image/jpeg;base64,${toBase64(new Uint8Array(await out.arrayBuffer()))}`;
}

/**
 * Снимок видимой части вкладки. Рамки с номерами элементов должны быть уже нарисованы
 * (наблюдение с highlight). Снимается только активная вкладка окна — иначе null: на снимке была бы чужая.
 */
export async function captureTab(tabId: number, maxWidth = SCREENSHOT_MAX_WIDTH): Promise<string | null> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.active || tab.windowId === undefined) return null;
  await new Promise((r) => setTimeout(r, PAINT_DELAY_MS));
  try {
    const raw = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: Math.round(JPEG_QUALITY * 100) });
    return await shrink(raw, maxWidth);
  } catch (err) {
    console.warn('screenshot failed', err);
    return null;
  }
}
