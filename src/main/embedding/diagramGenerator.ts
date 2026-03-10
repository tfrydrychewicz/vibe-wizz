/**
 * Two-step AI generator for Excalidraw diagrams.
 *
 * Step 1 — Plan: the model produces a compact, structured JSON description of
 *   the diagram (nodes with shapes/labels/grid-positions, plus directed edges).
 *   This keeps spatial reasoning lightweight and structured.
 *
 * Step 2 — Render: a second call converts the plan into a full Excalidraw
 *   elements array with exact pixel coordinates, bindings, and styling.
 *   The plan is included verbatim so the model doesn't need to re-reason about
 *   layout — only about pixel math.
 *
 * Output: { elements: string (JSON), appState: string (JSON) }
 */

import Database from 'better-sqlite3'
import { callWithFallback } from '../ai/modelRouter'

// ── Layout constants (must match the RENDER prompt below) ─────────────────────
const CELL_W  = 240  // horizontal distance between column centres
const CELL_H  = 160  // vertical distance between row centres
const ORIG_X  = 80   // x of col-0 centre
const ORIG_Y  = 80   // y of row-0 centre
const NODE_W  = 180
const NODE_H  = 70
const DIAMOND_PADDING = 20  // extra padding so diamonds look good

// ── Colours keyed by the plan's "color" field ─────────────────────────────────
const BG_COLORS: Record<string, string> = {
  blue:    '#a5d8ff',
  green:   '#b2f2bb',
  orange:  '#ffec99',
  red:     '#ffc9c9',
  purple:  '#d0bfff',
  yellow:  '#ffec99',
  default: 'transparent',
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlanNode {
  id:    string
  label: string
  shape: 'rectangle' | 'ellipse' | 'diamond'
  row:   number
  col:   number
  color?: string
}

interface PlanEdge {
  from:   string
  to:     string
  label?: string
}

interface DiagramPlan {
  diagramType: string
  nodes:       PlanNode[]
  edges:       PlanEdge[]
}

// ── Step 1: Plan ──────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a diagram planning expert. Given a user's description, plan a clear diagram.

Output ONLY valid JSON — no markdown fences, no explanation, just the JSON object.

Schema:
{
  "diagramType": "flowchart" | "architecture" | "mindmap" | "orgchart" | "sequence",
  "nodes": [
    {
      "id":    "<short unique alphanumeric>",
      "label": "<display text, keep ≤ 4 words>",
      "shape": "rectangle" | "ellipse" | "diamond",
      "row":   <integer ≥ 0>,
      "col":   <integer ≥ 0>,
      "color": "blue" | "green" | "orange" | "red" | "purple" | "default"
    }
  ],
  "edges": [
    { "from": "<nodeId>", "to": "<nodeId>", "label": "<optional short label>" }
  ]
}

Layout rules:
- row 0 = top, larger rows = lower
- col 0 = leftmost, larger cols = further right
- Arrange nodes so edges flow left→right or top→bottom
- Use "ellipse" for start/end nodes; "diamond" for decisions/branches; "rectangle" for everything else
- Keep diagrams focused: 4–10 nodes is ideal
- Color coding: blue = system/service, green = success/output, red = error/warning, orange = user/input, purple = external, default = neutral`

async function planDiagram(
  userPrompt:   string,
  db:           Database.Database,
): Promise<DiagramPlan> {
  // Always route through 'chat' — it uses whatever the user has configured and
  // working. The 'diagram_generate' slot appears in Settings → AI Features so
  // the user can optionally dedicate a different model, but we don't route here
  // automatically to avoid accidentally picking up broken/stale DB entries.
  const raw = await callWithFallback('chat', db, async (model) => {
    const response = await model.adapter.chat(
      {
        model:     model.modelId,
        messages:  [{ role: 'user', content: userPrompt }],
        system:    PLAN_SYSTEM,
        maxTokens: 1200,
      },
      model.apiKey,
    )
    return response.text
  })

  // Strip markdown fences if the model included them despite instructions
  const clean = (raw as string)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  return JSON.parse(clean) as DiagramPlan
}

// ── Step 2: Render plan → Excalidraw elements ─────────────────────────────────

/**
 * We do this in TypeScript rather than asking the model to produce pixel coords.
 * The model already decided the logical layout (row/col); we just apply the math.
 * This is far more reliable than asking an LLM to compute precise bounding boxes.
 */
/** Find where a line from center (cx,cy) in direction (dx,dy) exits a rectangle + gap. */
function rectEdgePoint(
  cx: number, cy: number, w: number, h: number,
  dx: number, dy: number, gap: number,
): [number, number] {
  if (dx === 0 && dy === 0) return [cx, cy]
  const hw = w / 2, hh = h / 2
  const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const scale  = Math.min(scaleX, scaleY)
  const ex = cx + dx * scale
  const ey = cy + dy * scale
  const len = Math.sqrt(dx * dx + dy * dy)
  return [ex + (dx / len) * gap, ey + (dy / len) * gap]
}

const BYPASS_MARGIN = 90  // pixels outside the rightmost column for back-edge routing

/**
 * Compute the points[] array for an arrow.
 * - Same-column downward → direct line
 * - Cross-column downward → mid-row elbow (down then across then down)
 * - Back-edges (going up or same row) → right-side bypass
 *
 * All points are relative to (sx, sy) — the arrow origin.
 */
function routeArrow(
  sx: number, sy: number,
  ex: number, ey: number,
  fromNode: PlanNode, toNode: PlanNode,
  allNodes: PlanNode[],
): number[][] {
  const p = (ax: number, ay: number): [number, number] => [ax - sx, ay - sy]

  // ── Direct downward (same column, going down) ─────────────────────────────
  if (fromNode.col === toNode.col && toNode.row > fromNode.row) {
    return [[0, 0], p(ex, ey)]
  }

  // ── Forward diagonal (different column, going down) ───────────────────────
  if (toNode.row > fromNode.row) {
    // Elbow at a Y midpoint between the two centre rows
    const fromCY = ORIG_Y + fromNode.row * CELL_H
    const toCY   = ORIG_Y + toNode.row   * CELL_H
    const midY   = (fromCY + toCY) / 2
    return [[0, 0], p(sx, midY), p(ex, midY), p(ex, ey)]
  }

  // ── Back-edge: going up or sideways ──────────────────────────────────────
  // Route via a vertical lane to the right of all nodes
  const maxCol   = Math.max(...allNodes.map((n) => n.col))
  const bypassX  = ORIG_X + maxCol * CELL_W + NODE_W / 2 + BYPASS_MARGIN
  return [[0, 0], p(bypassX, sy), p(bypassX, ey), p(ex, ey)]
}

function renderPlanToElements(plan: DiagramPlan): object[] {
  const elements: object[] = []

  // Map nodeId → generated Excalidraw shape ID
  const shapeIds = new Map<string, string>()
  plan.nodes.forEach((n) => shapeIds.set(n.id, `shape-${n.id}`))

  // Track bound arrow IDs per shape so we can populate boundElements
  const shapeBoundArrows = new Map<string, string[]>()
  plan.nodes.forEach((n) => shapeBoundArrows.set(shapeIds.get(n.id)!, []))

  // ── Nodes ────────────────────────────────────────────────────────────────
  for (const node of plan.nodes) {
    const cx = ORIG_X + node.col * CELL_W
    const cy = ORIG_Y + node.row * CELL_H
    const shapeId = shapeIds.get(node.id)!
    const bg = BG_COLORS[node.color ?? 'default'] ?? 'transparent'

    const base = {
      id:              shapeId,
      x:               cx - NODE_W / 2,
      y:               cy - NODE_H / 2,
      width:           NODE_W,
      height:          NODE_H,
      strokeColor:     '#1e1e1e',
      backgroundColor: bg,
      fillStyle:       bg === 'transparent' ? 'solid' : 'solid',
      strokeWidth:     2,
      roughness:       0,
      opacity:         100,
      angle:           0,
      seed:            Math.floor(Math.random() * 100000),
      version:         1,
      versionNonce:    Math.floor(Math.random() * 100000),
      isDeleted:       false,
      groupIds:        [] as string[],
      boundElements:   [] as object[],
      updated:         Date.now(),
      link:            null,
      locked:          false,
    }

    // boundElements filled in after arrows are built
    const shapeBoundRef = shapeBoundArrows.get(shapeId)!

    // Actual shape dimensions (diamonds are padded outward)
    const shapeW = node.shape === 'diamond' ? NODE_W + DIAMOND_PADDING * 2 : NODE_W
    const shapeH = node.shape === 'diamond' ? NODE_H + DIAMOND_PADDING * 2 : NODE_H
    const shapeX = cx - shapeW / 2
    const shapeY = cy - shapeH / 2

    if (node.shape === 'diamond') {
      elements.push({
        ...base,
        type:          'diamond',
        x:             shapeX,
        y:             shapeY,
        width:         shapeW,
        height:        shapeH,
        boundElements: shapeBoundRef as unknown as object[],
      })
    } else {
      elements.push({ ...base, type: node.shape, boundElements: shapeBoundRef as unknown as object[] })
    }

    // Text label positioned explicitly at the shape's geometric centre.
    // We avoid containerId because Excalidraw only re-centres it on load when
    // the shape's boundElements also lists { type:'text', id } — complex to
    // maintain. Instead we compute (x,y) directly so it is always correct.
    const FONT_SIZE  = 15
    const LINE_H     = 1.25
    const TEXT_H     = FONT_SIZE * LINE_H   // ~18.75 px for one line
    const textId = `text-${node.id}`
    elements.push({
      id:             textId,
      type:           'text',
      x:              shapeX,               // full shape width for h-centering
      y:              cy - TEXT_H / 2,      // vertically centred at shape centre
      width:          shapeW,
      height:         TEXT_H,
      text:           node.label,
      fontSize:       FONT_SIZE,
      fontFamily:     1,
      textAlign:      'center',
      verticalAlign:  'middle',
      strokeColor:    '#1e1e1e',
      backgroundColor:'transparent',
      fillStyle:      'solid',
      strokeWidth:    1,
      roughness:      0,
      opacity:        100,
      angle:          0,
      seed:           Math.floor(Math.random() * 100000),
      version:        1,
      versionNonce:   Math.floor(Math.random() * 100000),
      isDeleted:      false,
      groupIds:       [] as string[],
      boundElements:  [] as object[],
      updated:        Date.now(),
      link:           null,
      locked:         false,
      containerId:    null,
      lineHeight:     LINE_H,
    })
  }

  // ── Edges / Arrows ───────────────────────────────────────────────────────
  for (let i = 0; i < plan.edges.length; i++) {
    const edge   = plan.edges[i]
    const fromId = shapeIds.get(edge.from)
    const toId   = shapeIds.get(edge.to)
    if (!fromId || !toId) continue

    const fromNode = plan.nodes.find((n) => n.id === edge.from)!
    const toNode   = plan.nodes.find((n) => n.id === edge.to)!

    // Shape centres
    const fcx = ORIG_X + fromNode.col * CELL_W
    const fcy = ORIG_Y + fromNode.row * CELL_H
    const tcx = ORIG_X + toNode.col   * CELL_W
    const tcy = ORIG_Y + toNode.row   * CELL_H

    // Direction vector (centre → centre)
    const dx = tcx - fcx
    const dy = tcy - fcy

    // Effective half-extents (diamonds are padded)
    const fromW = fromNode.shape === 'diamond' ? NODE_W + DIAMOND_PADDING * 2 : NODE_W
    const fromH = fromNode.shape === 'diamond' ? NODE_H + DIAMOND_PADDING * 2 : NODE_H
    const toW   = toNode.shape   === 'diamond' ? NODE_W + DIAMOND_PADDING * 2 : NODE_W
    const toH   = toNode.shape   === 'diamond' ? NODE_H + DIAMOND_PADDING * 2 : NODE_H

    const GAP = 8
    const [sx, sy] = rectEdgePoint(fcx, fcy, fromW, fromH,  dx,  dy, GAP)
    const [ex, ey] = rectEdgePoint(tcx, tcy, toW,   toH,   -dx, -dy, GAP)

    const arrowId = `arrow-${i}-${edge.from}-${edge.to}`
    const routedPoints = routeArrow(sx, sy, ex, ey, fromNode, toNode, plan.nodes)

    // Bounding box from all waypoints
    const absXs = routedPoints.map(([px]) => sx + px)
    const absYs = routedPoints.map(([, py]) => sy + py)
    const arrowW = Math.max(...absXs) - Math.min(...absXs)
    const arrowH = Math.max(...absYs) - Math.min(...absYs)

    // Register this arrow in both shapes' boundElements
    shapeBoundArrows.get(fromId)!.push(arrowId)
    shapeBoundArrows.get(toId)!.push(arrowId)

    elements.push({
      id:              arrowId,
      type:            'arrow',
      x:               sx,
      y:               sy,
      width:           arrowW || 1,
      height:          arrowH || 1,
      points:          routedPoints,
      strokeColor:     '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle:       'solid',
      strokeWidth:     2,
      roughness:       0,
      opacity:         100,
      angle:           0,
      seed:            Math.floor(Math.random() * 100000),
      version:         1,
      versionNonce:    Math.floor(Math.random() * 100000),
      isDeleted:       false,
      groupIds:        [] as string[],
      boundElements:   [] as object[],
      updated:         Date.now(),
      link:            null,
      locked:          false,
      startBinding:    { elementId: fromId, gap: GAP, focus: 0 },
      endBinding:      { elementId: toId,   gap: GAP, focus: 0 },
      startArrowhead:  null,
      endArrowhead:    'arrow',
      elbowed:         false,
    })

    // Optional edge label — offset perpendicular to arrow direction so it sits
    // beside the arrow rather than on top of it
    if (edge.label) {
      // Use midpoint of the path (between second and third waypoints when available)
      const midPtIdx = Math.floor(routedPoints.length / 2)
      const [mpx0, mpy0] = routedPoints[midPtIdx - 1] ?? [0, 0]
      const [mpx1, mpy1] = routedPoints[midPtIdx]     ?? routedPoints[routedPoints.length - 1]
      const segDx = mpx1 - mpx0
      const segDy = mpy1 - mpy0
      const segLen = Math.sqrt(segDx * segDx + segDy * segDy) || 1
      // Perpendicular unit vector (90° CW)
      const perpX = segDy / segLen
      const perpY = -segDx / segLen
      const LABEL_OFFSET = 18
      const midX = sx + (mpx0 + mpx1) / 2 + perpX * LABEL_OFFSET
      const midY = sy + (mpy0 + mpy1) / 2 + perpY * LABEL_OFFSET
      elements.push({
        id:             `elabel-${i}`,
        type:           'text',
        x:              midX - 60,
        y:              midY - 10,
        width:          120,
        height:         20,
        text:           edge.label,
        fontSize:       12,
        fontFamily:     1,
        textAlign:      'center',
        verticalAlign:  'middle',
        strokeColor:    '#666',
        backgroundColor:'transparent',
        fillStyle:      'solid',
        strokeWidth:    1,
        roughness:      0,
        opacity:        100,
        angle:          0,
        seed:           Math.floor(Math.random() * 100000),
        version:        1,
        versionNonce:   Math.floor(Math.random() * 100000),
        isDeleted:      false,
        groupIds:       [] as string[],
        boundElements:  [] as object[],
        updated:        Date.now(),
        link:           null,
        locked:         false,
        containerId:    null,
        lineHeight:     1.25,
      })
    }
  }

  // Back-fill boundElements on every shape element now that all arrow IDs are known
  for (const el of elements) {
    const e = el as Record<string, unknown>
    if (!e['id'] || typeof e['id'] !== 'string') continue
    const bound = shapeBoundArrows.get(e['id'] as string)
    if (bound && bound.length > 0) {
      e['boundElements'] = bound.map((id) => ({ type: 'arrow', id }))
    }
  }

  return elements
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an Excalidraw diagram from a free-text prompt using two AI calls:
 *   1. Plan: structured node/edge graph with grid layout
 *   2. Render: TypeScript converts the plan to exact pixel elements (no second LLM call needed)
 *
 * Returns serialised JSON strings ready to store in the TipTap node attributes.
 */
export async function generateExcalidrawDiagram(
  prompt: string,
  db:     Database.Database,
): Promise<{ elements: string; appState: string }> {
  const plan     = await planDiagram(prompt, db)
  const elements = renderPlanToElements(plan)

  const appState = {
    viewBackgroundColor: 'transparent',
    currentItemStrokeColor: '#1e1e1e',
    currentItemBackgroundColor: 'transparent',
    exportBackground: false,
    theme: 'light',
  }

  return {
    elements: JSON.stringify(elements),
    appState: JSON.stringify(appState),
  }
}
