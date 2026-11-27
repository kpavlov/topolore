const KEY = "topolore.zoom";

/** Store pixels per world unit, so zoom also works across camera modes and window sizes. */
export function loadZoom(): number | undefined {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
  } catch { return undefined; }
}

export function saveZoom(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 100) return;
  try { localStorage.setItem(KEY, String(value)); } catch {}
}
