import { storage } from '#imports';
import type { Macro } from './macro';

const MAX_MACROS = 100;
const item = storage.defineItem<Macro[]>('local:macros', { fallback: [] });

export const listMacros = (): Promise<Macro[]> => item.getValue();

export async function getMacro(id: string): Promise<Macro | null> {
  return (await item.getValue()).find((m) => m.id === id) ?? null;
}

export async function saveMacro(m: Macro): Promise<void> {
  const all = (await item.getValue()).filter((x) => x.id !== m.id);
  await item.setValue([m, ...all].slice(0, MAX_MACROS));
}

export async function deleteMacro(id: string): Promise<void> {
  await item.setValue((await item.getValue()).filter((m) => m.id !== id));
}
