# Editor

The Caddyfile editor has three modes on one page, **Visual | Text | Split**. They all work on
the same document, so you can switch at any time without losing comments. Every save is
written in `caddy fmt` style.

Open it from **Editor** in the sidebar, from a site's "Edit" link, or from a site page. Links
can aim at a block: `/editor?site=<id>`, `?at=<address>`, `?line=<n>`, and `?mode=text` opens
text mode.

## Visual mode: tree and inspector

- **Left, the tree.** Global options, snippets, named routes and sites, then inside a site its
  directives, matchers and subdirectives, each with a one-line summary such as
  `reverse_proxy → 10.0.0.103:3000`.
- **Right, the inspector.** A form for the selected item, with the directive's documentation
  and examples. Every standard directive and every matcher has its own form. Plugin
  directives get a form generated from the schema, and anything else shows as raw text that
  still round-trips. Lines a form does not model appear under **Other lines**.
- **Matcher builder.** The matcher slot of a directive takes a named matcher, a path or `*`,
  and a builder for new named matchers covering all matcher types.
- **Placeholder picker** offers `{host}`, `{path.N}`, `{http.request.header.*}`, `{env.*}`,
  regexp captures such as `{re.name.1}` and the rest of the catalogue.
- **Effective order** shows the order Caddy runs directives in, which differs from file
  order.
- **Tree keys.** Arrows move, Enter edits, Ctrl/Cmd+D duplicates, Delete removes. Drag a row
  to reorder siblings.
- **Add block** opens the recipe picker (below).

### Recipes

New blocks start from a recipe, defined in `lib/visual/recipes.ts`. The same list feeds
**Add site** on the Sites page and **Add block** in the editor.

| Recipe | Makes |
| --- | --- |
| Reverse proxy | `reverse_proxy` to an upstream, with an optional WebSocket toggle |
| Redirect | `redir` to a target, keeping the path or not, with a status code |
| Static files | `file_server` with root, optional browse, single-page-app fallback and compression |
| PHP | `php_fastcgi` with a root |
| Protected | A proxy behind `forward_auth` (inline or through a snippet) |
| Proxy with error page | A proxy plus a `handle_errors` page |
| Snippet | A named `(snippet)` block |
| Blank | An empty site block |

## Text mode

CodeMirror 6 with Caddyfile highlighting (comments, addresses, directives, matchers,
placeholders, environment variables, quoted and heredoc strings), folding, bracket matching,
lint as you type, autocomplete and hover docs from the schema. Parser errors underline
within about 200 ms. **Check with Caddy** runs `/adapt` on demand, and **Format** applies
`caddy fmt` style.

Schema findings (for example an unknown directive from a plugin) are warnings and never block
an apply. Only the parser and Caddy itself can refuse.

## Split mode

Visual and Text side by side. Edits in either appear in the other straight away.

## Globals

`/globals` is the same editor limited to the non-site blocks: global options, snippets and
named routes. Its text mode shows the whole file. `?block=global` or `?block=snippets`
selects that part.

## Applying changes

1. **Review and apply** (Ctrl+S) shows a line diff of the file on disk against the text that
   will be written. The first save of a hand-indented file shows the whole file re-indented.
2. The UI validates with the parser and then Caddy's `/adapt`.
3. The old file is copied to a backup, the new text is written, Caddy loads it, and a
   revision is stored. A save that only changes layout is written without reloading Caddy.
4. To undo, restore an earlier revision on **History**.

If the file changed on disk since you opened it, the UI refuses with a conflict and offers to
compare your edits with the current file or drop them. Unapplied edits are kept in your
browser, tied to the version they started from, and come back on your next visit.

## Sites page

Per-site actions edit the file directly and keep everything else in it untouched:

- **Add** from a recipe, **duplicate**, **delete** (with confirmation) and **reorder**.
- **Disable** comments the block out under a marker line `# caddy-ui:disabled lines=N`.
  **Enable** reverses it exactly. Caddy sees comments, so a disabled site is simply gone
  until re-enabled.

Sites written without braces (a single-site Caddyfile) cannot be edited from the list.

## Coverage

The directives, matchers and global options the editor supports, and which ones the sample
Caddyfile uses, are in [caddy-coverage.md](caddy-coverage.md).
