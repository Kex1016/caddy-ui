# Visual editor: approaches considered

The visual editor is the hardest part of the UI to get right. These are the shapes that
were brainstormed, what each is good at, and the recommendation. David's answers to the
questions at the end decide the final shape; until then W5 is not launched.

Every approach shares the same foundation: the editor edits the concrete syntax tree from
`packages/caddyfile`, never free text, so the text editor and the visual editor are two
views of one document and switching between them is lossless. Anything the visual editor
cannot model is shown as a raw row that still round-trips.

## A. Directive cards

Each site block is a page. Its body is a vertical list of directive cards in file order.
A card shows the directive name, its matcher as a chip, a summary line, and expands into
the directive's form. Container directives (`handle`, `route`, `handle_errors`,
`handle_path`) are cards that contain cards.

- Good: no learning curve, every edit is in place, works on a phone.
- Bad: David's `haiiro.moe` block is three levels deep with a `forward_auth` inside a
  `route` inside a `handle`; cards nest into a tall, narrow column. Reordering nested
  cards by drag is fiddly.

## B. Tree outline with an inspector

Left: a collapsible tree of the whole Caddyfile (global options, snippets, sites;
inside a site, directives, matchers, subdirectives). Right: an inspector form for the
selected node, with the matching doc excerpt and examples pulled from the schema. The
tree shows summaries (`reverse_proxy → 10.0.0.103:3000`, `@protected path /edit* …`),
and drag-and-drop reorders siblings. Keyboard: arrows move, Enter edits, Cmd+D
duplicates, Delete removes.

- Good: scales to deep nesting and to 35 blocks; the inspector gives room for the big
  `reverse_proxy` form; feels like an IDE outline, which suits the audience.
- Bad: one more click than cards for simple edits; needs a two-pane layout, so phones
  get a stacked version.

## C. Request-flow diagram

Each site rendered as a flow: request enters, passes matchers (diamonds) and middleware
(nodes), ends in a handler (`reverse_proxy`, `file_server`, `redir`, …). Edges show the
effective order Caddy will use after sorting. Click a node to edit it in a side panel.

- Good: the only approach that shows what Caddy will actually do, including the
  directive-order surprises (`redir` before `handle`, path sorting).
- Bad: by far the most work; mapping arbitrary Caddyfiles to a faithful diagram and back
  is lossy for things like `route` blocks and snippets; most of David's sites are one
  node, where a diagram adds nothing.

Recommendation: keep C as a read-only "Flow" tab on the site page later (post 1.0), not
as the editor.

## D. Split view with live text

Not a different editor, a layout: the visual editor on one side, the CodeMirror text on
the other, both bound to the same tree. Selecting a node highlights its lines; editing
text re-parses and refreshes the tree. Can be combined with A or B.

- Good: builds trust in the round trip; power users see the result immediately.
- Bad: needs wide screens; David asked for text editing "when in this mode", which reads
  as a mode switch rather than always-on.

Recommendation: a mode switch (Visual | Text) by default, with a "show text" toggle that
opens the split for people who want it.

## E. Recipes for new blocks

A higher-level entry point used when adding a block (and offered as a one-click upgrade
on existing simple blocks): "Reverse proxy", "Redirect to another site", "Static site",
"PHP site", "Protected by tinyauth", "Custom error page", "Just a snippet". Each recipe
is a short form that generates canonical Caddyfile, which then opens in the normal
editor. Recipes cover the 80 percent case (most of David's blocks are a one-line
`reverse_proxy`) and keep the full editor for the rest.

- Good: adding a site takes ten seconds; new users never see `reverse_proxy` options
  they do not need.
- Bad: recipes must be maintained alongside the schema; they are sugar, not coverage.

## Recommendation

B + E, with D as an optional toggle:

1. Tree outline with inspector (B) as the visual editor. Bespoke inspector forms for
   the directives and matchers David uses (`reverse_proxy`, `forward_auth`, `handle`,
   `route`, `handle_errors`, `handle_path`, `redir`, `rewrite`, `uri`, `try_files`,
   `file_server`, `import`, `path`, `path_regexp`, named matchers, wildcard), generic
   schema-driven forms for everything else, raw rows for the unknown.
2. Recipes (E) on "Add site" and on the empty state.
3. Mode switch Visual | Text, with an optional split (D).
4. An "Effective order" view in the inspector that lists the directives of the current
   block in the order Caddy will run them, with a note when the file order differs.
5. A matcher builder shared by every form: pick type, fill fields, see the Caddyfile
   line it produces, and the CEL equivalent for `expression`.
6. A placeholder picker in every text field that knows which placeholders are valid in
   that position (regex captures only after a `path_regexp`, `{rp.header.*}` only inside
   `handle_response`, and so on).
7. Round trip preserves David's formatting and comments exactly; a "Format" action
   applies `caddy fmt` style when he wants it.

## David's answers (6 Nov 2026)

1. Editor shape: **B, tree + inspector**, with recipes.
2. Text mode: **Visual | Text switch**, with an optional side-by-side split toggle.
3. Round trip: **normalise to `caddy fmt` style on every save**; comments are kept.
   The byte-exact printer stays for in-editor diffs and history.
4. First release scope: **bespoke forms for all 41 directives** (and all 19 matchers).
   PLAN.md splits this into W5a (core and the directives in use) and W5b (the rest).
5. Disable a site: **comment the block out**.

## Open questions for David (answered above, kept for the record)

1. Editor shape: B (tree + inspector) as recommended, A (cards), or C (flow diagram)?
2. Text mode: a Visual | Text switch (recommended), always side by side, or both?
3. Round trip: keep formatting and comments byte for byte (recommended), or normalise to
   `caddy fmt` style on every save?
4. First release scope: generic forms for all directives plus bespoke forms for the ones
   in use (recommended), or bespoke forms for all 41 before shipping?
5. Should "disable a site" comment the block out (recommended, reversible and visible in
   the file) or move it to a separate `disabled/` file imported with a glob?
