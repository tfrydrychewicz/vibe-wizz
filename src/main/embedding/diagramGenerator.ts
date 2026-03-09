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
function renderPlanToElements(plan: DiagramPlan): object[] {
  const elements: object[] = []

  // Map nodeId → generated Excalidraw shape ID (same as nodeId for simplicity)
  const shapeIds = new Map<string, string>()
  plan.nodes.forEach((n) => shapeIds.set(n.id, `shape-${n.id}`))

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

    if (node.shape === 'diamond') {
      elements.push({
        ...base,
        type:   'diamond',
        x:      cx - (NODE_W / 2 + DIAMOND_PADDING),
        y:      cy - (NODE_H / 2 + DIAMOND_PADDING),
        width:  NODE_W + DIAMOND_PADDING * 2,
        height: NODE_H + DIAMOND_PADDING * 2,
      })
    } else {
      elements.push({ ...base, type: node.shape })
    }

    // Inline text label — use containerId so Excalidraw centres it
    const textId = `text-${node.id}`
    elements.push({
      id:             textId,
      type:           'text',
      x:              cx - NODE_W / 2,
      y:              cy - NODE_H / 2,
      width:          NODE_W,
      height:         NODE_H,
      text:           node.label,
      fontSize:       15,
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
      containerId:    shapeId,
      lineHeight:     1.25,
    })
  }

  // ── Edges / Arrows ───────────────────────────────────────────────────────
  for (let i = 0; i < plan.edges.length; i++) {
    const edge  = plan.edges[i]
    const fromId = shapeIds.get(edge.from)
    const toId   = shapeIds.get(edge.to)
    if (!fromId || !toId) continue

    const fromNode = plan.nodes.find((n) => n.id === edge.from)!
    const toNode   = plan.nodes.find((n) => n.id === edge.to)!

    // Arrow start/end are approximate midpoints; Excalidraw binding snaps to edges
    const fx = ORIG_X + fromNode.col * CELL_W
    const fy = ORIG_Y + fromNode.row * CELL_H
    const tx = ORIG_X + toNode.col   * CELL_W
    const ty = ORIG_Y + toNode.row   * CELL_H

    const arrowId = `arrow-${i}-${edge.from}-${edge.to}`

    elements.push({
      id:              arrowId,
      type:            'arrow',
      x:               fx,
      y:               fy,
      width:           tx - fx,
      height:          ty - fy,
      points:          [[0, 0], [tx - fx, ty - fy]],
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
      startBinding:    { elementId: fromId, gap: 8, focus: 0 },
      endBinding:      { elementId: toId,   gap: 8, focus: 0 },
      startArrowhead:  null,
      endArrowhead:    'arrow',
      elbowed:         false,
    })

    // Optional edge label
    if (edge.label) {
      const midX = (fx + tx) / 2
      const midY = (fy + ty) / 2
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
  }

  return {
    elements: JSON.stringify(elements),
    appState: JSON.stringify(appState),
  }
}
