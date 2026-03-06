- [x] in ai chat: when an entity is mentioned, prompt context should include it's attributes (fields), and references attributes (watch out for cycles A -> B -> A). If a note is referenced in the entity field, the note also should become part of the context.
- [x] mention notes in ai chat with `[[`
- [ ] for every transcript for the same note wizz should always ensure that it's content is fully reflected in the note.
- [x] recurring meetings in calendar. The meeting should be recurring, but every occurence of this meetuing should have its own notes.
- [ ] daily review with a note template
- [ ] note editor mentions `@` support entity names with spaces in it
- [ ] add https://github.com/md2docx/tiptap-extension-mermaid/ and ensure AI can generate these graphs. It should be good enough to tell ai that it can return mermaid (https://mermaid.js.org/) graph in a code block, it should know what mermaid is.
- [ ] support for openai models, alongside claude models
- [x] entity list allow grouping by entity field and sorting by [name, date created, date updated] in both direction [increment, decrement]
- [ ] automated daily review generation (morning and evening)
- [ ] recurring summary for an entity type - configurable in entity type settings

PROMPT

Design a new feature.

Redesign tasks to implement GTD (getting things done) methodology. In the settings I should be able to set the entity type for projects. Tasks can be parts of projects. Tasks can be assigned to someoone. Tasks can have due date. Tasks can have sub-tasks. 

Also redesign how we attach tasks in notes to tasks in the actions view. I should be able to set tasks attributes from the note view as well, if the task has been attached. When attaching the task, run an AI prompt to try to derive the task attributes from the task description in the note.

All have too look professionally and nice and allow to fully implement the GTD methodology.

Remember about reusability and consistency across whole app.

For this idea , first create a new file in the /features folder of this project. The file should have a design of the feature and the implementation plan in a form of a checklist (like in @DESIGN.md) 