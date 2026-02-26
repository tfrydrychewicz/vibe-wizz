import type { Migration } from './index'

/**
 * Migrate built-in entity type schemas:
 *
 * Person.team: text → entity_ref (entity_type: team)
 *   Allows the reverse-relationship WQL query in Team to match by entity ID.
 *
 * Team.members: entity_ref_list → computed
 *   WQL: SELECT p FROM Person WHERE p.team = {this}
 *
 * Both updates are surgical — only applied if the field still has the old type,
 * so user customisations of other fields are preserved.
 */
export const migration: Migration = {
  version: 3,
  name: 'team_computed_members',
  up(db) {
    // ── Person: team text → entity_ref ─────────────────────────────────────
    const personRow = db
      .prepare(`SELECT schema FROM entity_types WHERE id = 'person'`)
      .get() as { schema: string } | undefined

    if (personRow) {
      const schema = JSON.parse(personRow.schema) as {
        fields: { name: string; type: string; entity_type?: string }[]
      }
      const teamField = schema.fields.find((f) => f.name === 'team')
      if (teamField && teamField.type === 'text') {
        teamField.type = 'entity_ref'
        teamField.entity_type = 'team'
        db.prepare(`UPDATE entity_types SET schema = ? WHERE id = 'person'`).run(
          JSON.stringify(schema),
        )
      }
    }

    // ── Team: members entity_ref_list → computed ────────────────────────────
    const teamRow = db
      .prepare(`SELECT schema FROM entity_types WHERE id = 'team'`)
      .get() as { schema: string } | undefined

    if (teamRow) {
      const schema = JSON.parse(teamRow.schema) as {
        fields: { name: string; type: string; entity_type?: string; query?: string }[]
      }
      const membersField = schema.fields.find((f) => f.name === 'members')
      if (membersField && membersField.type === 'entity_ref_list') {
        membersField.type = 'computed'
        membersField.query = 'SELECT p FROM Person WHERE p.team = {this}'
        delete membersField.entity_type
        db.prepare(`UPDATE entity_types SET schema = ? WHERE id = 'team'`).run(
          JSON.stringify(schema),
        )
      }
    }
  },
}
