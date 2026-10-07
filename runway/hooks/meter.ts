// The meter in two forms: glyph runs for the terminal, an SVG for the desktop.
// Both mark how far through its window the clock is, so use running ahead of
// time shows as fill past the mark.

export type MeterRole = 'fill' | 'empty' | 'mark-fill' | 'mark-empty'

export type MeterRun = { text: string; role: MeterRole }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function meterRuns(width: number, percent: number, elapsed?: number): MeterRun[] {
  const cells = Math.max(1, Math.floor(width))
  const halves = Math.round((clamp(percent, 0, 100) / 100) * cells * 2)
  // Any use at all shows as at least half a cell.
  const units = percent > 0 ? Math.max(1, halves) : 0
  const full = Math.floor(units / 2)
  const hasHalf = units % 2 === 1
  const mark = elapsed === undefined ? -1 : Math.min(cells - 1, Math.floor(clamp(elapsed, 0, 1) * cells))
  const runs: MeterRun[] = []

  for (let cell = 0; cell < cells; cell++) {
    const isFilled = cell < full || (cell === full && hasHalf)
    const glyph =
      cell === mark
        ? { text: isFilled ? '┿' : '┼', role: isFilled ? 'mark-fill' : 'mark-empty' }
        : cell < full
          ? { text: '━', role: 'fill' }
          : isFilled
            ? { text: '╸', role: 'fill' }
            : { text: '─', role: 'empty' }
    const last = runs.at(-1)

    if (last?.role === glyph.role) {
      last.text += glyph.text
    } else {
      runs.push(glyph as MeterRun)
    }
  }

  return runs
}

export const METER_HEIGHT = 9

export function meterSvg(width: number, percent: number, elapsed: number | undefined, color: string, markColor: string) {
  const w = Math.max(24, Math.round(width))
  const barY = 2
  const barH = 5
  const radius = barH / 2
  // Any use at all shows as at least the rounded end.
  const fillW = percent > 0 ? Math.max(barH, (clamp(percent, 0, 100) / 100) * w) : 0
  const markX = elapsed === undefined ? undefined : clamp(elapsed * w, 1, w - 1)
  // A tick standing proud of the bar, so it reads over the fill and the track.
  const mark =
    markX === undefined
      ? ''
      : `<rect x="${(markX - 1).toFixed(1)}" width="2" height="${METER_HEIGHT}" rx="1" fill="${markColor}"/>`

  return (
    // Stretches to whatever width the surface gives it, the height kept.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${METER_HEIGHT}" viewBox="0 0 ${w} ${METER_HEIGHT}" preserveAspectRatio="none">` +
    `<defs><clipPath id="track"><rect y="${barY}" width="${w}" height="${barH}" rx="${radius}"/></clipPath></defs>` +
    `<rect y="${barY}" width="${w}" height="${barH}" rx="${radius}" fill="${color}" fill-opacity="0.22"/>` +
    `<rect clip-path="url(#track)" y="${barY}" width="${fillW.toFixed(1)}" height="${barH}" rx="${radius}" fill="${color}"/>` +
    mark +
    `</svg>`
  )
}
