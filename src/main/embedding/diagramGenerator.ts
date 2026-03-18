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
import type { ImageBlock, ContentBlock } from '../ai/providers/types'

// ── Layout constants (must match the RENDER prompt below) ─────────────────────
const CELL_W  = 240  // horizontal distance between column centres
const CELL_H  = 160  // vertical distance between row centres
const ORIG_X  = 80   // x of col-0 centre
const ORIG_Y  = 80   // y of row-0 centre
const NODE_W  = 180
const NODE_H  = 70
const DIAMOND_PADDING = 20  // extra padding so diamonds look good

// ── Freeform canvas constants (used for image-based recreation) ───────────────
// These must stay in sync with the IMAGE_PLAN_SYSTEM prompt below.
const FREEFORM_CANVAS_W = 1600
const FREEFORM_CANVAS_H = 1000
const FREEFORM_NODE_W   = 150   // smaller than grid NODE_W so dense diagrams don't overlap
const FREEFORM_NODE_H   = 56

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

/** Node for freeform (image-recreation) plans: uses absolute pixel coordinates. */
interface FreeformPlanNode {
  id:    string
  label: string
  shape: 'rectangle' | 'ellipse' | 'diamond'
  /** Absolute horizontal CENTER in pixels on the 1600px canvas */
  x:     number
  /** Absolute vertical CENTER in pixels on the 1000px canvas */
  y:     number
  color?: string
}

interface FreeformDiagramPlan {
  nodes: FreeformPlanNode[]
  edges: PlanEdge[]
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
  userPrompt:      string,
  db:              Database.Database,
  images?:         ImageBlock[],
  overrideModelId?: string,
): Promise<DiagramPlan> {
  // Route through 'diagram_generate' slot; overrideModelId is placed at the front.
  const userContent: string | ContentBlock[] = images?.length
    ? [...images, { type: 'text' as const, text: userPrompt }]
    : userPrompt
  const raw = await callWithFallback('diagram_generate', db, async (model) => {
    const response = await model.adapter.chat(
      {
        model:     model.modelId,
        messages:  [{ role: 'user', content: userContent }],
        system:    PLAN_SYSTEM,
        maxTokens: 1200,
      },
      model.apiKey,
    )
    return response.text
  }, overrideModelId)

  // Strip markdown fences if the model included them despite instructions
  const clean = (raw as string)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  return JSON.parse(clean) as DiagramPlan
}

// ── Image-based recreation: freeform coordinate plan ─────────────────────────

// Canvas and node dimensions are embedded in the prompt so the AI can reason
// about absolute pixel spacing and avoid overlaps.
const IMAGE_PLAN_SYSTEM = `You are a diagram recreation expert. Given an image of a diagram, reproduce it EXACTLY in JSON for Excalidraw.

OUTPUT ONLY valid JSON — no markdown fences, no explanation, no extra keys.

TARGET CANVAS: ${FREEFORM_CANVAS_W} × ${FREEFORM_CANVAS_H} pixels
NODE SIZE: each drawn box is ${FREEFORM_NODE_W}px wide × ${FREEFORM_NODE_H}px tall
MINIMUM SAFE SPACING: keep node centers ≥ ${FREEFORM_NODE_W + 20}px apart horizontally and ≥ ${FREEFORM_NODE_H + 20}px apart vertically to prevent overlap.

How to compute x and y for each node:
  x = round((node's horizontal center in image / image total width) × ${FREEFORM_CANVAS_W})
  y = round((node's vertical center in image / image total height) × ${FREEFORM_CANVAS_H})
Then nudge any two centers that would be closer than the minimum spacing.

Schema:
{
  "nodes": [
    {
      "id":    "<short alphanumeric, no spaces>",
      "label": "<exact text shown on the node in the image>",
      "shape": "rectangle" | "ellipse" | "diamond",
      "x":     <integer 0–${FREEFORM_CANVAS_W}, absolute pixel x of node CENTER>,
      "y":     <integer 0–${FREEFORM_CANVAS_H}, absolute pixel y of node CENTER>,
      "color": "blue" | "green" | "orange" | "red" | "purple" | "default"
    }
  ],
  "edges": [
    { "from": "<nodeId>", "to": "<nodeId>", "label": "<arrow label text if visible, else omit key>" }
  ]
}

RULES (follow strictly):
1. Include EVERY node visible in the image — do not omit or merge any.
2. Include EVERY arrow/connection — do not omit any.
3. Node x,y must reflect proportional position in the source image (top-left = 0,0 ; bottom-right = ${FREEFORM_CANVAS_W},${FREEFORM_CANVAS_H}).
4. Label text must match the source diagram exactly.
5. color field: blue=blue/navy, green=green/teal, red=red/crimson, orange=orange/amber/yellow-brown, purple=purple/violet, default=white/grey/light.`

async function planFreeformDiagram(
  userPrompt: string,
  db: Database.Database,
  images: ImageBlock[],
  overrideModelId?: string,
): Promise<FreeformDiagramPlan> {
  const userContent: ContentBlock[] = [
    ...images,
    { type: 'text' as const, text: userPrompt },
  ]
  const raw = await callWithFallback('diagram_generate', db, async (model) => {
    const response = await model.adapter.chat(
      {
        model:     model.modelId,
        messages:  [{ role: 'user', content: userContent }],
        system:    IMAGE_PLAN_SYSTEM,
        maxTokens: 4000,
      },
      model.apiKey,
    )
    return response.text
  }, overrideModelId)

  const clean = (raw as string)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  return JSON.parse(clean) as FreeformDiagramPlan
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

/**
 * Shared helper: build a node element + its text label at a given canvas centre.
 * Returns [shapeElement, textElement].
 * nodeW/nodeH default to the grid-layout constants; pass FREEFORM_NODE_W/H for image recreation.
 */
function buildNodeElements(
  node: { id: string; label: string; shape: 'rectangle' | 'ellipse' | 'diamond'; color?: string },
  cx: number,
  cy: number,
  shapeBoundRef: string[],
  nodeW = NODE_W,
  nodeH = NODE_H,
): object[] {
  const shapeId = `shape-${node.id}`
  const bg = BG_COLORS[node.color ?? 'default'] ?? 'transparent'

  const shapeW = node.shape === 'diamond' ? nodeW + DIAMOND_PADDING * 2 : nodeW
  const shapeH = node.shape === 'diamond' ? nodeH + DIAMOND_PADDING * 2 : nodeH
  const shapeX = cx - shapeW / 2
  const shapeY = cy - shapeH / 2

  const base = {
    id:              shapeId,
    x:               shapeX,
    y:               shapeY,
    width:           shapeW,
    height:          shapeH,
    strokeColor:     '#1e1e1e',
    backgroundColor: bg,
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
    boundElements:   shapeBoundRef as unknown as object[],
    updated:         Date.now(),
    link:            null,
    locked:          false,
  }

  const FONT_SIZE = 15
  const LINE_H    = 1.25
  const TEXT_H    = FONT_SIZE * LINE_H

  const textEl = {
    id:              `text-${node.id}`,
    type:            'text',
    x:               shapeX,
    y:               cy - TEXT_H / 2,
    width:           shapeW,
    height:          TEXT_H,
    text:            node.label,
    fontSize:        FONT_SIZE,
    fontFamily:      1,
    textAlign:       'center',
    verticalAlign:   'middle',
    strokeColor:     '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle:       'solid',
    strokeWidth:     1,
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
    containerId:     null,
    lineHeight:      LINE_H,
  }

  return [{ ...base, type: node.shape }, textEl]
}

/**
 * Build an arrow element between two edge-points, with an optional label.
 * Uses a straight direct line (appropriate for freeform layouts).
 */
function buildArrowElement(
  arrowId: string,
  sx: number, sy: number,
  ex: number, ey: number,
  fromId: string, toId: string,
  label: string | undefined,
  edgeIndex: number,
): object[] {
  const GAP    = 8
  const points = [[0, 0], [ex - sx, ey - sy]]
  const arrowW = Math.abs(ex - sx)
  const arrowH = Math.abs(ey - sy)

  const elements: object[] = [{
    id:              arrowId,
    type:            'arrow',
    x:               sx,
    y:               sy,
    width:           arrowW || 1,
    height:          arrowH || 1,
    points,
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
  }]

  if (label) {
    const midX   = (sx + ex) / 2
    const midY   = (sy + ey) / 2
    const dx     = ex - sx
    const dy     = ey - sy
    const len    = Math.sqrt(dx * dx + dy * dy) || 1
    const perpX  = dy / len
    const perpY  = -dx / len
    const OFFSET = 18
    elements.push({
      id:              `elabel-${edgeIndex}`,
      type:            'text',
      x:               midX + perpX * OFFSET - 60,
      y:               midY + perpY * OFFSET - 10,
      width:           120,
      height:          20,
      text:            label,
      fontSize:        12,
      fontFamily:      1,
      textAlign:       'center',
      verticalAlign:   'middle',
      strokeColor:     '#666',
      backgroundColor: 'transparent',
      fillStyle:       'solid',
      strokeWidth:     1,
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
      containerId:     null,
      lineHeight:      1.25,
    })
  }

  return elements
}

/**
 * Resolve any pairwise overlapping node centers by nudging them apart.
 * Runs a simple iterative spring until no overlap remains (max 20 passes).
 */
function resolveOverlaps(nodes: FreeformPlanNode[]): void {
  const minDx = FREEFORM_NODE_W + 10
  const minDy = FREEFORM_NODE_H + 10
  for (let pass = 0; pass < 20; pass++) {
    let moved = false
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const na = nodes[a]
        const nb = nodes[b]
        const ox = Math.abs(na.x - nb.x)
        const oy = Math.abs(na.y - nb.y)
        if (ox < minDx && oy < minDy) {
          // Push apart along the dominant axis
          if (ox >= oy) {
            const push = (minDx - ox) / 2 + 1
            if (na.x <= nb.x) { na.x -= push; nb.x += push }
            else               { na.x += push; nb.x -= push }
          } else {
            const push = (minDy - oy) / 2 + 1
            if (na.y <= nb.y) { na.y -= push; nb.y += push }
            else               { na.y += push; nb.y -= push }
          }
          moved = true
        }
      }
    }
    if (!moved) break
  }
}

/**
 * Determine which sides of two nodes to connect based on their relative positions.
 * Returns fixedPoint values — relative [0–1] position within the element bounding box:
 *   [0, 0.5] = left mid  [1, 0.5] = right mid  [0.5, 0] = top mid  [0.5, 1] = bottom mid
 *
 * Uses a bias toward horizontal connections (left↔right) since most architecture
 * diagrams flow primarily left→right.
 */
function getConnectionSides(
  fromCx: number, fromCy: number, fromW: number, fromH: number,
  toCx: number,   toCy: number,   toW: number,   toH: number,
): { fromFixed: [number, number]; toFixed: [number, number] } {
  const dx = toCx - fromCx
  const dy = toCy - fromCy

  // Check if the nodes overlap vertically — if so, prefer horizontal connection
  const vertOverlap = Math.abs(dy) < (fromH + toH) / 2 + 10
  const horizOverlap = Math.abs(dx) < (fromW + toW) / 2 + 10

  if (vertOverlap && !horizOverlap) {
    // Same row → always connect horizontally
    return dx >= 0
      ? { fromFixed: [1, 0.5], toFixed: [0, 0.5] }
      : { fromFixed: [0, 0.5], toFixed: [1, 0.5] }
  }

  if (horizOverlap && !vertOverlap) {
    // Same column → always connect vertically
    return dy >= 0
      ? { fromFixed: [0.5, 1], toFixed: [0.5, 0] }
      : { fromFixed: [0.5, 0], toFixed: [0.5, 1] }
  }

  // General case — pick the dominant axis
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromFixed: [1, 0.5], toFixed: [0, 0.5] }
      : { fromFixed: [0, 0.5], toFixed: [1, 0.5] }
  } else {
    return dy >= 0
      ? { fromFixed: [0.5, 1], toFixed: [0.5, 0] }
      : { fromFixed: [0.5, 0], toFixed: [0.5, 1] }
  }
}

/**
 * Build an elbowed (orthogonal) arrow for freeform diagrams.
 * Connects from a specific side of the source node to a specific side of the target
 * using Excalidraw's elbowed routing (elbowed:true + fixedPoint in bindings).
 * Excalidraw's rendering engine handles the actual orthogonal path computation.
 */
function buildFreeformArrowElement(
  arrowId: string,
  fromNode: FreeformPlanNode, toNode: FreeformPlanNode,
  fromId: string, toId: string,
  fromW: number, fromH: number,
  toW: number, toH: number,
  label: string | undefined,
  edgeIndex: number,
): object[] {
  const GAP = 8
  const { fromFixed, toFixed } = getConnectionSides(
    fromNode.x, fromNode.y, fromW, fromH,
    toNode.x,   toNode.y,   toW,   toH,
  )

  // Pixel position of the arrow start/end on the node edges
  const sx = (fromNode.x - fromW / 2) + fromFixed[0] * fromW
  const sy = (fromNode.y - fromH / 2) + fromFixed[1] * fromH
  const ex = (toNode.x - toW / 2)     + toFixed[0]   * toW
  const ey = (toNode.y - toH / 2)     + toFixed[1]   * toH

  // For elbowed arrows Excalidraw only needs start+end; it computes the elbow path
  const points = [[0, 0], [ex - sx, ey - sy]]

  const elements: object[] = [{
    id:              arrowId,
    type:            'arrow',
    x:               sx,
    y:               sy,
    width:           Math.abs(ex - sx) || 1,
    height:          Math.abs(ey - sy) || 1,
    points,
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
    startBinding:    { elementId: fromId, gap: GAP, focus: 0, fixedPoint: fromFixed },
    endBinding:      { elementId: toId,   gap: GAP, focus: 0, fixedPoint: toFixed },
    startArrowhead:  null,
    endArrowhead:    'arrow',
    elbowed:         true,
  }]

  // Label placed beside the arrow midpoint
  if (label) {
    const midX = (sx + ex) / 2
    const midY = (sy + ey) / 2
    // Offset slightly away from the line to avoid overlap
    const isHoriz = Math.abs(ex - sx) >= Math.abs(ey - sy)
    elements.push({
      id:              `elabel-${edgeIndex}`,
      type:            'text',
      x:               midX - 55,
      y:               isHoriz ? midY - 20 : midY - 10,
      width:           110,
      height:          18,
      text:            label,
      fontSize:        11,
      fontFamily:      1,
      textAlign:       'center',
      verticalAlign:   'middle',
      strokeColor:     '#555',
      backgroundColor: 'transparent',
      fillStyle:       'solid',
      strokeWidth:     1,
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
      containerId:     null,
      lineHeight:      1.25,
    })
  }

  return elements
}

/**
 * Render a freeform plan (from image recreation) where nodes have absolute
 * pixel coordinates on a FREEFORM_CANVAS_W × FREEFORM_CANVAS_H canvas.
 * Uses elbowed (orthogonal) arrows that connect from/to the correct node side.
 */
function renderFreeformPlanToElements(plan: FreeformDiagramPlan): object[] {
  const elements: object[] = []

  // Mutable copy so resolveOverlaps can nudge positions safely
  const nodes: FreeformPlanNode[] = plan.nodes.map((n) => ({ ...n }))
  resolveOverlaps(nodes)

  const shapeIds = new Map<string, string>()
  nodes.forEach((n) => shapeIds.set(n.id, `shape-${n.id}`))

  const shapeBoundArrows = new Map<string, string[]>()
  nodes.forEach((n) => shapeBoundArrows.set(shapeIds.get(n.id)!, []))

  // Nodes
  for (const node of nodes) {
    const boundRef = shapeBoundArrows.get(shapeIds.get(node.id)!)!
    elements.push(...buildNodeElements(node, node.x, node.y, boundRef, FREEFORM_NODE_W, FREEFORM_NODE_H))
  }

  // Edges — elbowed orthogonal arrows
  for (let i = 0; i < plan.edges.length; i++) {
    const edge   = plan.edges[i]
    const fromId = shapeIds.get(edge.from)
    const toId   = shapeIds.get(edge.to)
    if (!fromId || !toId) continue

    const fromNode = nodes.find((n) => n.id === edge.from)!
    const toNode   = nodes.find((n) => n.id === edge.to)!

    const fromW = fromNode.shape === 'diamond' ? FREEFORM_NODE_W + DIAMOND_PADDING * 2 : FREEFORM_NODE_W
    const fromH = fromNode.shape === 'diamond' ? FREEFORM_NODE_H + DIAMOND_PADDING * 2 : FREEFORM_NODE_H
    const toW   = toNode.shape   === 'diamond' ? FREEFORM_NODE_W + DIAMOND_PADDING * 2 : FREEFORM_NODE_W
    const toH   = toNode.shape   === 'diamond' ? FREEFORM_NODE_H + DIAMOND_PADDING * 2 : FREEFORM_NODE_H

    const arrowId = `arrow-${i}-${edge.from}-${edge.to}`
    shapeBoundArrows.get(fromId)!.push(arrowId)
    shapeBoundArrows.get(toId)!.push(arrowId)

    elements.push(...buildFreeformArrowElement(
      arrowId, fromNode, toNode, fromId, toId,
      fromW, fromH, toW, toH, edge.label, i,
    ))
  }

  // Back-fill boundElements on shapes
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

function renderPlanToElements(plan: DiagramPlan): object[] {
  const elements: object[] = []

  const shapeIds = new Map<string, string>()
  plan.nodes.forEach((n) => shapeIds.set(n.id, `shape-${n.id}`))

  const shapeBoundArrows = new Map<string, string[]>()
  plan.nodes.forEach((n) => shapeBoundArrows.set(shapeIds.get(n.id)!, []))

  // Nodes — use shared builder
  for (const node of plan.nodes) {
    const cx = ORIG_X + node.col * CELL_W
    const cy = ORIG_Y + node.row * CELL_H
    const boundRef = shapeBoundArrows.get(shapeIds.get(node.id)!)!
    elements.push(...buildNodeElements(node, cx, cy, boundRef))
  }

  // Edges — elbow-routed arrows for the structured grid layout
  const GAP = 8
  for (let i = 0; i < plan.edges.length; i++) {
    const edge   = plan.edges[i]
    const fromId = shapeIds.get(edge.from)
    const toId   = shapeIds.get(edge.to)
    if (!fromId || !toId) continue

    const fromNode = plan.nodes.find((n) => n.id === edge.from)!
    const toNode   = plan.nodes.find((n) => n.id === edge.to)!

    const fcx = ORIG_X + fromNode.col * CELL_W
    const fcy = ORIG_Y + fromNode.row * CELL_H
    const tcx = ORIG_X + toNode.col   * CELL_W
    const tcy = ORIG_Y + toNode.row   * CELL_H
    const dx  = tcx - fcx
    const dy  = tcy - fcy

    const fromW = fromNode.shape === 'diamond' ? NODE_W + DIAMOND_PADDING * 2 : NODE_W
    const fromH = fromNode.shape === 'diamond' ? NODE_H + DIAMOND_PADDING * 2 : NODE_H
    const toW   = toNode.shape   === 'diamond' ? NODE_W + DIAMOND_PADDING * 2 : NODE_W
    const toH   = toNode.shape   === 'diamond' ? NODE_H + DIAMOND_PADDING * 2 : NODE_H

    const [sx, sy] = rectEdgePoint(fcx, fcy, fromW, fromH,  dx,  dy, GAP)
    const [ex, ey] = rectEdgePoint(tcx, tcy, toW,   toH,   -dx, -dy, GAP)

    const arrowId = `arrow-${i}-${edge.from}-${edge.to}`
    const routedPoints = routeArrow(sx, sy, ex, ey, fromNode, toNode, plan.nodes)

    const absXs  = routedPoints.map(([px]) => sx + px)
    const absYs  = routedPoints.map(([, py]) => sy + py)
    const arrowW = Math.max(...absXs) - Math.min(...absXs)
    const arrowH = Math.max(...absYs) - Math.min(...absYs)

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

    if (edge.label) {
      const midPtIdx = Math.floor(routedPoints.length / 2)
      const [mpx0, mpy0] = routedPoints[midPtIdx - 1] ?? [0, 0]
      const [mpx1, mpy1] = routedPoints[midPtIdx]     ?? routedPoints[routedPoints.length - 1]
      const segDx  = mpx1 - mpx0
      const segDy  = mpy1 - mpy0
      const segLen = Math.sqrt(segDx * segDx + segDy * segDy) || 1
      const perpX  = segDy / segLen
      const perpY  = -segDx / segLen
      const LABEL_OFFSET = 18
      const midX = sx + (mpx0 + mpx1) / 2 + perpX * LABEL_OFFSET
      const midY = sy + (mpy0 + mpy1) / 2 + perpY * LABEL_OFFSET
      elements.push({
        id:              `elabel-${i}`,
        type:            'text',
        x:               midX - 60,
        y:               midY - 10,
        width:           120,
        height:          20,
        text:            edge.label,
        fontSize:        12,
        fontFamily:      1,
        textAlign:       'center',
        verticalAlign:   'middle',
        strokeColor:     '#666',
        backgroundColor: 'transparent',
        fillStyle:       'solid',
        strokeWidth:     1,
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
        containerId:     null,
        lineHeight:      1.25,
      })
    }
  }

  // Back-fill boundElements on shapes
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
 * Generate an Excalidraw diagram from a free-text prompt or an image attachment.
 *
 * When images are provided (recreation from attachment):
 *   → Uses freeform coordinate-based planning: AI outputs normalized x/y positions
 *     (0.0–1.0 of canvas), preserving the exact spatial layout of the source image.
 *   → Renders with direct straight arrows for natural fidelity.
 *
 * When no images are provided (text description):
 *   → Uses grid-based planning (row/col integers) with elbow-routed arrows.
 *
 * Returns serialised JSON strings ready to store in the TipTap node attributes.
 */
export async function generateExcalidrawDiagram(
  prompt: string,
  db:     Database.Database,
  opts?: {
    images?: { dataUrl: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }[]
    overrideModelId?: string
  },
): Promise<{ elements: string; appState: string }> {
  const imageBlocks: ImageBlock[] = (opts?.images ?? []).map((img) => ({
    type: 'image',
    mediaType: img.mimeType,
    data: img.dataUrl.includes(',') ? img.dataUrl.split(',')[1] : img.dataUrl,
  }))

  let elements: object[]
  if (imageBlocks.length > 0) {
    // Image-recreation path: freeform x/y coordinates for spatial fidelity
    const plan = await planFreeformDiagram(prompt, db, imageBlocks, opts?.overrideModelId)
    elements   = renderFreeformPlanToElements(plan)
  } else {
    // Text-description path: structured grid layout
    const plan = await planDiagram(prompt, db, undefined, opts?.overrideModelId)
    elements   = renderPlanToElements(plan)
  }

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
