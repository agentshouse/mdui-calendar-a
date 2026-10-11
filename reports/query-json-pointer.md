# Current Local Query JSON Pointer contract

Master 20261011T1742Z requires frontmatter selectors to be JSON Pointers. Verified against official @agentshouse/mdruntime 0.1.0-c2647c1a232dd AGENTS.md (Fields/Relations/Parts/Order) and dist/query.js, without changing the App Runtime dependency or importing a Runtime implementation.

Production correction: calendarQuery orderBy.by.field /start. select.fields all and metadata orderBy.by path stay unchanged.

The boundary tests now reject bare selectors in where (including nested logical conditions), select.fields, orderBy, groupBy, hop and backlinks, and reject malformed pointer escapes. Metadata names and section headings stay distinct. Tests execute the actual production objects. Selected fields retain their natural frontmatter keys. No UI, schema, binding or data change. Publication remains gated on Tasks-first coordination and actual hosted first-page acceptance.
