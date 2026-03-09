import mermaid from 'mermaid'

let initialised = false

function ensureMermaidInit(): void {
  if (initialised) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    // 'loose' is required in Electron: the default 'strict' mode uses a
    // sandboxed iframe that Electron's CSP blocks. Trusted local content only.
    securityLevel: 'loose',
  })
  initialised = true
}

// Per-theme dark-compatible variable overrides injected via %%{init}%%.
// Every theme is tuned to look good on the app's dark surface (#242424)
// while keeping each theme's characteristic accent palette.
const THEME_VARS: Record<string, Record<string, string>> = {
  // ── Default dark — neutral charcoal ──────────────────────────────────────
  dark: {
    background: '#242424',
    mainBkg: '#2c2c2c',
    primaryColor: '#2c2c2c',
    primaryTextColor: '#e8e8e8',
    primaryBorderColor: '#444',
    secondaryColor: '#333',
    tertiaryColor: '#2a2a2a',
    lineColor: '#888',
    textColor: '#e8e8e8',
    edgeLabelBackground: '#2c2c2c',
    nodeBorder: '#444',
    clusterBkg: '#2a2a2a',
    titleColor: '#e8e8e8',
    fontSize: '13px',
  },
  // ── Ocean — deep blue ─────────────────────────────────────────────────────
  default: {
    background: '#1a2035',
    mainBkg: '#1e2a45',
    primaryColor: '#1e3a6e',
    primaryTextColor: '#c8d8f0',
    primaryBorderColor: '#4d7cc7',
    secondaryColor: '#18253a',
    tertiaryColor: '#14203a',
    lineColor: '#5b8def',
    textColor: '#c8d8f0',
    edgeLabelBackground: '#1a2035',
    nodeBorder: '#3d6aad',
    clusterBkg: '#16233a',
    titleColor: '#c8d8f0',
    fontSize: '13px',
  },
  // ── Forest — deep green ───────────────────────────────────────────────────
  forest: {
    background: '#0f1f0f',
    mainBkg: '#1a2e1a',
    primaryColor: '#1a3d1a',
    primaryTextColor: '#d1fae5',
    primaryBorderColor: '#4ade80',
    secondaryColor: '#142914',
    tertiaryColor: '#0d1f0d',
    lineColor: '#4ade80',
    textColor: '#d1fae5',
    edgeLabelBackground: '#0f1f0f',
    nodeBorder: '#22c55e',
    clusterBkg: '#122012',
    titleColor: '#d1fae5',
    fontSize: '13px',
  },
  // ── Slate — warm grey ─────────────────────────────────────────────────────
  neutral: {
    background: '#1c1c22',
    mainBkg: '#252530',
    primaryColor: '#2d2d38',
    primaryTextColor: '#e2e2e8',
    primaryBorderColor: '#5a5a6e',
    secondaryColor: '#22222c',
    tertiaryColor: '#18181f',
    lineColor: '#9ca3af',
    textColor: '#d1d5db',
    edgeLabelBackground: '#1c1c22',
    nodeBorder: '#4b5163',
    clusterBkg: '#20202a',
    titleColor: '#e2e2e8',
    fontSize: '13px',
  },
  // ── Violet — deep purple ──────────────────────────────────────────────────
  base: {
    background: '#1a1128',
    mainBkg: '#241a3d',
    primaryColor: '#2d1f4a',
    primaryTextColor: '#e9d5ff',
    primaryBorderColor: '#8b5cf6',
    secondaryColor: '#1e1535',
    tertiaryColor: '#150f28',
    lineColor: '#a78bfa',
    textColor: '#e2d9f3',
    edgeLabelBackground: '#1a1128',
    nodeBorder: '#7c3aed',
    clusterBkg: '#1c1330',
    titleColor: '#e9d5ff',
    fontSize: '13px',
  },
}

export type MermaidResult = { svg: string; error: null } | { svg: null; error: string }

/**
 * Renders Mermaid source to an SVG string.
 * Each call must pass a unique `id` — Mermaid uses it as the SVG element id.
 * Theme + dark-compatible themeVariables are injected via `%%{init}%%` so
 * each block renders independently without re-initialising the singleton.
 * If the user has already written their own `%%{init}%%`, it takes precedence.
 * Returns { svg } on success or { error } on parse/render failure.
 */
export async function renderMermaid(
  id: string,
  source: string,
  theme = 'dark',
): Promise<MermaidResult> {
  ensureMermaidInit()
  const themedSource = source.trimStart().startsWith('%%{init')
    ? source
    : `%%{init: ${JSON.stringify({ theme, themeVariables: THEME_VARS[theme] ?? THEME_VARS.dark })}}%%\n${source}`
  try {
    const { svg } = await mermaid.render(id, themedSource)
    return { svg, error: null }
  } catch (err) {
    return { svg: null, error: err instanceof Error ? err.message : String(err) }
  }
}
