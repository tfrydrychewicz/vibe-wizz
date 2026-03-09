import { Chart, registerables } from 'chart.js'

let registered = false

function ensureChartJs(): void {
  if (registered) return
  Chart.register(...registerables)
  registered = true
}

export type ChartResult =
  | { chart: Chart; error: null }
  | { chart: null; error: string }

/**
 * Parse `source` as a Chart.js config JSON, destroy any `existing` Chart
 * instance, and render a new one on `canvas`.
 *
 * Returns the new Chart instance on success, or an error string on failure.
 * The caller is responsible for destroying the returned chart on unmount or
 * on the next render call (pass it back as `existing`).
 */
export function renderChart(
  canvas: HTMLCanvasElement,
  source: string,
  existing: Chart | null,
): ChartResult {
  ensureChartJs()
  existing?.destroy()

  let config: unknown
  try {
    config = JSON.parse(source)
  } catch {
    return { chart: null, error: 'Invalid JSON — check your chart configuration.' }
  }

  if (typeof config !== 'object' || config === null || !('type' in config)) {
    return { chart: null, error: 'Config must be a JSON object with a "type" field.' }
  }

  try {
    // Cast through unknown to satisfy Chart.js generic type constraints.
    const chart = new Chart(canvas, config as ConstructorParameters<typeof Chart>[1]) as unknown as Chart
    return { chart, error: null }
  } catch (err: unknown) {
    return {
      chart: null,
      error: err instanceof Error ? err.message : 'Failed to render chart.',
    }
  }
}
