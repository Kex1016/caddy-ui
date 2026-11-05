# @caddy-ui/caddyfile

A lossless Caddyfile parser in pure TypeScript: lexer, concrete syntax tree (CST), printer,
formatter and small edit helpers. No DOM, no Node APIs, so it runs in the browser (visual
and text editors) and on the server (validation, apply, history).

The one rule everything else follows: `print(parse(text)) === text` for every input,
valid or not. Comments, blank lines, indentation, quoting, heredocs, line continuations and
line endings all survive. Edits re-print only the nodes they touch, in the indentation
style of the surrounding block.

## Usage

```ts
import { parse, print, format, createDirective, insertNode, sites } from '@caddy-ui/caddyfile';

const { file, diagnostics } = parse(text); // never throws; problems are diagnostics with spans
const site = sites(file).find((s) => s.addresses.some((a) => a.text === 'example.com'));
insertNode(site.body, createDirective('encode', ['zstd', 'gzip']));
const updated = print(file); // only the new line differs from `text`
const tidy = format(text); // caddy fmt style: tabs, one space between tokens
```

## Tree shape

See [`src/types.ts`](src/types.ts); it follows PLAN.md §3.2 with the additions logged in
DECISIONS.md.

- `Caddyfile { blocks, trivia }`. Blocks are `global`, `snippet`, `named_route`, `site`,
  plus `import` (a top-level `import` line) and `raw` (a top-level line the parser could
  not classify, always with a diagnostic).
- Nodes inside bodies are `directive` (`name [matcher] args… [{ body }]`), `matcher`
  (`@name` definitions in block, single-module and CEL shorthand forms) and `raw`.
- `Token { text, raw, quote, span, leading }`: `text` is the decoded value, `raw` is what the
  printer writes. Synthesised tokens may give `text` only; `quoteToken()` picks the quoting
  Caddy needs (`"…"` with `\"`, backticks, or a heredoc).
- `Trivia` are comment and blank lines; `layout` holds the whitespace of a line (indent,
  trailing comment, newline, brace style, closing brace line).

## API

| Function | Purpose |
| --- | --- |
| `parse(text, options?)` | Text to tree plus diagnostics. Options let the schema pass the full set of matcher-taking and container directives. |
| `parseFragment(text)` | A list of directive lines (recipe templates, raw rows). |
| `print(file)`, `printNodes(nodes)`, `printBlockText(block)` | Tree to text, byte-exact for unchanged parts. |
| `format(textOrFile)` | `caddy fmt` style output, idempotent. |
| `createToken`, `createDirective`, `createMatcherDef`, `createCelMatcherDef`, `createSite`, `createSnippet`, `nodesFromText` | Build nodes from plain values. |
| `setArgs`, `setMatcher`, `setTokenText`, `insertNode`, `removeNode`, `replaceNode`, `insertBlock`, `removeBlock`, `relayout` | Change a tree; `relayout` forgets stored whitespace so a moved node is re-indented. |
| `commentOutBlock`, `uncommentTrivia` | Disable a site by commenting it out, and restore it byte for byte. |
| `walk`, `findDirectives`, `sites`, `nodeAt`, `tokenAt`, `blockAt`, `summarize` | Queries for editors. |
| `positionAt`, `offsetAt`, `lineSpan` | Offsets to Caddy-style 1-based lines and back (for `/adapt` errors). |
| `siteKey`, `siteId` | Stable identity of a site block from its address list (PLAN.md §3.2). |
| `lex` | The logical-line lexer, for the text editor's highlighter. |

## Lexing rules implemented

From `caddyconfig/caddyfile/lexer.go` and the docs: whitespace-separated tokens; `#` starts
a comment only at a token start; `"…"` with `\"` as the only escape (other backslashes are
literal) and newlines allowed inside; `` `…` `` with no escapes; heredocs `<<MARKER … MARKER`
with the closing marker's indentation stripped from every line, the last newline dropped,
trailing arguments after the closing marker, and `\<<` to escape; `\`-newline line
continuation; `\r\n` line endings. Quoted braces are plain tokens; only bare `{`, `}` and
`{}` open or close blocks.

## Tests

`pnpm --filter @caddy-ui/caddyfile test` runs:

- unit tests for the lexer, parser, printer, formatter and edit helpers;
- a byte-exact round trip of the anonymised copy of David's Caddyfile and of every
  ```` ```caddy ```` and ```` ```caddy-d ```` block in the Caddy docs (520 blocks, zero raw
  nodes, zero diagnostics), plus local fixtures (CRLF, no final newline, braceless site,
  odd spacing, invalid files);
- fuzz tests with fast-check: 10,000 arbitrary strings and 10,000 strings built from
  Caddyfile ingredients must round-trip; generated Caddyfiles must parse clean, round-trip,
  format idempotently and keep the same token structure after formatting; `quoteToken`
  must lex back to its input.

`FUZZ_RUNS=100000 pnpm test` runs a longer fuzz. `pnpm fixtures:docs [dir]` regenerates the
docs fixtures from GitHub or a local checkout of `caddyserver/website`.
