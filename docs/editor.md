# Editor

> **Draft.** Describes the planned editor from [PLAN.md](../PLAN.md) and
> [visual-editor-options.md](visual-editor-options.md). Screenshots and exact controls are
> added after the visual editor (W5) and text editor (W6) ship.

Both editors work on the same parsed document, so you can switch between them at any time
without losing comments or formatting.

## Visual editor: tree and inspector

- **Left**: an outline of the whole Caddyfile: global options, snippets, named routes and
  sites. Inside a site you see directives, matchers and subdirectives, each with a one-line
  summary such as `reverse_proxy → 10.0.0.103:3000`.
- **Right**: the inspector for the selected item, with a form for its arguments and the
  matching Caddy documentation and examples.
- **Reorder** siblings by dragging. **Keyboard**: arrows move, Enter edits, Cmd/Ctrl+D
  duplicates, Delete removes.
- **Recipes** create new sites from a template (reverse proxy, static files, redirect,
  forward auth and so on).
- **Raw rows** show anything the editor cannot model, such as plugin directives. They
  round-trip unchanged.
- **Effective order** view shows the order Caddy runs directives in, which differs from file
  order.
- **Diagnostics panel** lists parser and `/adapt` problems with line numbers.

Coverage of every directive, matcher and global option is in
[caddy-coverage.md](caddy-coverage.md).

## Text editor

CodeMirror 6 with Caddyfile highlighting (comments, addresses, directives, matchers,
placeholders, environment variables, quoted and heredoc strings), folding, bracket
matching, inline lint, autocomplete and hover docs from the schema. Format on demand.

## Applying changes

1. Review the diff.
2. The UI validates with the parser, then Caddy's `/adapt`.
3. A revision is stored, the file is written and Caddy loads the config.
4. If something is wrong, restore any earlier revision from History.

If the file changed on disk since you opened it, the UI asks before overwriting.

## Disabling a site

Disabling comments the block out, so it stays in the file and can be re-enabled. (Draft:
this is the default pending the owner's answer to question 5 in the options document.)
