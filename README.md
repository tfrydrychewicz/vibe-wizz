# Wizz

> A local-first AI knowledge OS — notes, entities, calendar, and a 3-layer RAG pipeline, all in SQLite on your Mac.

Wizz is a desktop app that connects your notes, people, projects, and calendar into a living knowledge graph — with a multi-layer AI pipeline running silently in the background.

---

## What it does

**Notes** are rich documents (TipTap/ProseMirror) where you `@mention` people and projects, `[[link]]` between notes, create action items with `/action`, and attach files. Every save triggers a background AI pipeline.

**Entities** are your knowledge graph nodes — people, projects, teams, decisions, OKRs. Custom entity types with arbitrary field schemas. Mentions in notes are auto-detected by NER and linked automatically.

**Calendar** is a full 4-view calendar (day / work-week / week / month) with meeting notes linked to events, attendee entity mapping, and external calendar sync via Google Apps Script.

**Actions** is a kanban board of action items extracted from your notes by Claude, with assignees, due dates, and status tracking.

**Ask Wizz** is an AI chat sidebar where Claude can read your knowledge base *and* act on it — creating events, updating tasks, writing notes — via a tool-use loop.

---

## The AI pipeline

Every note save fires a concurrent background pipeline:

```
Note saved
    │
    ├── L1: Chunk note → embed with text-embedding-3-small (OpenAI) → store in vec0
    ├── L2: Summarise note → Claude Haiku → embed summary → store in vec0
    ├── NER: Detect entity mentions → Claude Haiku → upsert auto_detected entity_mentions
    └── Actions: Extract action items → Claude Haiku → replace ai_extracted rows
```

Nightly, a **L3 cluster batch** runs K-means++ over all L2 summaries, generates a theme label per cluster with Claude Haiku, and stores cluster embeddings for search boosting.

**Semantic search** uses all three layers:

1. Claude Haiku expands the query into 4–8 synonyms/related concepts
2. FTS5 OR search on expanded terms (top 20) + KNN on chunk embeddings (top 20) run in parallel
3. Results merged with Reciprocal Rank Fusion (k=60) + L3 cluster boost (+0.05)
4. Claude Haiku re-ranks the final top 15 by relevance score (0–10)

---

## Meetings & transcription

When your mic activates, Wizz detects it and offers to transcribe. Three backends:

- **ElevenLabs Scribe v2** — realtime PCM streaming (WebSocket) or batch with speaker diarization
- **Deepgram Nova-3** — WebM/Opus streaming with live diarization
- **macOS SFSpeechRecognizer** — fully offline via Apple's on-device speech

**System audio capture** (macOS 14.2+) uses Core Audio Taps + AVAudioEngine to mix mic and all-process system audio into a single PCM stream. No screen recording required for audio.

After a session ends, Claude Haiku maps speaker IDs to calendar attendee names, then rewrites the note with a structured meeting summary. Raw transcript stored separately.

---

## Tech stack

| Layer | Tech |
|-------|------|
| Shell | Electron (main + preload + renderer) |
| UI | Vue 3 + TipTap (ProseMirror) |
| DB | better-sqlite3 · WAL mode · FTS5 · sqlite-vec |
| Embeddings | OpenAI text-embedding-3-small (1536d) |
| AI | Claude Sonnet (chat, daily brief, post-processing) · Claude Haiku (NER, actions, summaries, query expansion, re-ranking) |
| Swift | MicMonitor · Transcriber.app · AudioCapture.app |
| Build | electron-vite · electron-builder |

All data is local. No cloud backend. Everything lives in a single SQLite file in your Electron `userData` directory.

---

## Getting started

### Prerequisites

- macOS (primary target)
- Node.js 20+
- Anthropic API key (required for AI features)
- OpenAI API key (required for embeddings / semantic search)

### Install & run

```bash
npm install
npm run dev
```

### Build Swift binaries (run once)

```bash
npm run build:swift          # MicMonitor binary
npm run build:transcriber    # Transcriber.app bundle
npm run build:audiocapture   # AudioCapture.app bundle
```

### Build for distribution

```bash
npm run build   # electron-vite bundle + macOS DMG
```

### Type checking

```bash
npm run typecheck
```

---

## Architecture

```
src/
├── main/           # Electron main process
│   ├── db/         # SQLite schema, migrations, all IPC handlers
│   ├── embedding/  # Chunker, embedder, NER, action extractor, chat, daily brief
│   ├── calendar/   # Sync engine, providers, scheduler
│   ├── mic/        # MicMonitor subprocess wrapper
│   └── transcription/  # Session routing, post-processor, Swift wrappers
├── preload/        # Context bridge → typed window.api surface
└── renderer/       # Vue 3 SPA
    ├── components/ # NoteEditor, EntityDetail, CalendarView, ChatSidebar, …
    ├── stores/     # tabStore, chatStore, mentionStore, noteLinkStore, transcriptionStore
    └── composables/ # useInputMention, useInputNoteLink
```

Three-process boundary is strict: renderer has no Node access and communicates exclusively via `window.api` IPC.

---

## API keys

Set in **Settings → AI**:

| Key | Used for |
|-----|----------|
| `anthropic_api_key` | Chat, NER, action extraction, summaries, query expansion, re-ranking, daily brief |
| `openai_api_key` | Embeddings (L1/L2/L3) and semantic search |
| `deepgram_api_key` | Deepgram transcription backend |
| `elevenlabs_api_key` | ElevenLabs transcription backend |

The app works without any keys — AI features degrade gracefully.

---

## License

MIT
