import type { Migration } from './index'

/**
 * Introduce multi-provider AI model configuration.
 *
 * Three new tables:
 *
 * 1. ai_providers — one row per vendor the user has configured (Anthropic, OpenAI, Gemini).
 *    Stores the API key and an enabled flag.
 *
 * 2. ai_models — models the user has selected/enabled per provider.
 *    Stores provider model ID, human label, capability list, and enabled flag.
 *
 * 3. ai_feature_models — ordered fallback chain per AI feature slot.
 *    E.g. { feature_slot: 'chat', position: 0, model_id: 'claude-sonnet-4-6' }
 *         { feature_slot: 'chat', position: 1, model_id: 'gpt-4o' }
 *
 * Seeding strategy:
 * - If `anthropic_api_key` already exists in settings → migrate it into ai_providers
 *   and enable all three Anthropic models (Opus, Sonnet, Haiku).
 * - If `openai_api_key` already exists → migrate it and enable GPT-4o, GPT-4o mini,
 *   and text-embedding-3-small.
 * - Set default chains for all feature slots matching the previously hardcoded assignments.
 */
export const migration: Migration = {
  version: 7,
  name: 'ai_providers',
  up(db) {
    // ── 1. Tables ──────────────────────────────────────────────────────────

    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_providers (
        id        TEXT PRIMARY KEY,
        api_key   TEXT NOT NULL DEFAULT '',
        enabled   INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS ai_models (
        id           TEXT PRIMARY KEY,
        provider_id  TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
        label        TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '["chat"]',
        enabled      INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS ai_feature_models (
        feature_slot TEXT NOT NULL,
        position     INTEGER NOT NULL,
        model_id     TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
        PRIMARY KEY (feature_slot, position)
      );
    `)

    // ── 2. Seed providers & models from existing settings keys ─────────────

    const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?")

    const anthropicKey = (getSetting.get('anthropic_api_key') as { value: string } | undefined)?.value ?? ''
    const openaiKey    = (getSetting.get('openai_api_key')    as { value: string } | undefined)?.value ?? ''

    if (anthropicKey) {
      db.prepare(`INSERT OR IGNORE INTO ai_providers (id, api_key) VALUES ('anthropic', ?)`).run(anthropicKey)

      const anthropicModels: Array<{ id: string; label: string; capabilities: string }> = [
        { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',  capabilities: '["chat"]' },
        { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', capabilities: '["chat"]' },
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', capabilities: '["chat"]' },
      ]
      const insertModel = db.prepare(
        `INSERT OR IGNORE INTO ai_models (id, provider_id, label, capabilities, enabled)
         VALUES (?, 'anthropic', ?, ?, 1)`
      )
      for (const m of anthropicModels) {
        insertModel.run(m.id, m.label, m.capabilities)
      }
    }

    if (openaiKey) {
      db.prepare(`INSERT OR IGNORE INTO ai_providers (id, api_key) VALUES ('openai', ?)`).run(openaiKey)

      const openaiModels: Array<{ id: string; label: string; capabilities: string }> = [
        { id: 'gpt-4o',                  label: 'GPT-4o',                   capabilities: '["chat"]' },
        { id: 'gpt-4o-mini',             label: 'GPT-4o mini',              capabilities: '["chat"]' },
        { id: 'text-embedding-3-small',  label: 'text-embedding-3-small',   capabilities: '["embedding"]' },
      ]
      const insertModel = db.prepare(
        `INSERT OR IGNORE INTO ai_models (id, provider_id, label, capabilities, enabled)
         VALUES (?, 'openai', ?, ?, 1)`
      )
      for (const m of openaiModels) {
        insertModel.run(m.id, m.label, m.capabilities)
      }
    }

    // ── 3. Default feature chains ──────────────────────────────────────────
    //
    // Only insert rows for models that were actually seeded above (i.e. the
    // corresponding API key exists). This ensures foreign-key integrity without
    // requiring both keys to be present.

    const insertChain = db.prepare(
      `INSERT OR IGNORE INTO ai_feature_models (feature_slot, position, model_id)
       VALUES (?, ?, ?)`
    )

    // Anthropic-based slots (Sonnet = conversation; Haiku = everything else)
    if (anthropicKey) {
      const sonnetSlots = ['chat', 'daily_brief'] as const
      const haikuSlots  = [
        'note_summary', 'ner', 'action_extract', 'inline_ai',
        'meeting_summary', 'cluster_summary', 'query_expand', 'rerank',
      ] as const

      for (const slot of sonnetSlots) {
        insertChain.run(slot, 0, 'claude-sonnet-4-6')
      }
      for (const slot of haikuSlots) {
        insertChain.run(slot, 0, 'claude-haiku-4-5-20251001')
      }
    }

    // OpenAI embedding slot
    if (openaiKey) {
      insertChain.run('embedding', 0, 'text-embedding-3-small')
    }
  },
}
