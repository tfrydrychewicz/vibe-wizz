- [x] in ai chat: when an entity is mentioned, prompt context should include it's attributes (fields), and references attributes (watch out for cycles A -> B -> A). If a note is referenced in the entity field, the note also should become part of the context.
- [x] mention notes in ai chat with `[[`
- [ ] for every transcript for the same note wizz should always ensure that it's content is fully reflected in the note.
- [x] recurring meetings in calendar. The meeting should be recurring, but every occurence of this meetuing should have its own notes.
- [ ] daily review with a note template
- [ ] note editor mentions `@` support entity names with spaces in it
- [ ] add https://github.com/md2docx/tiptap-extension-mermaid/ and ensure AI can generate these graphs. It should be good enough to tell ai that it can return mermaid (https://mermaid.js.org/) graph in a code block, it should know what mermaid is.
- [x] support for openai models, alongside claude models
- [x] entity list allow grouping by entity field and sorting by [name, date created, date updated] in both direction [increment, decrement]
- [ ] automated daily review generation (morning and evening)
- [x] recurring summary for an entity type - configurable in entity type settings

PROMPT

For context read and @CLAUDE.md, @DESIGN.md.

Design a new feature.

Remember about reusability and consistency across whole app.

For this idea , first create a new file in the /features folder of this project. The file should have a design of the feature and the implementation plan in a form of a checklist (like in @DESIGN.md) 