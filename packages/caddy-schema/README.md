# @caddy-ui/caddy-schema

A machine-readable schema of every standard Caddyfile directive, request matcher,
response matcher, global option and placeholder, generated from the Caddy docs
(`caddyserver/website`, `src/docs/markdown/caddyfile/`). The visual editor (W5) builds
its forms from it, the text editor (W6) uses it for autocomplete, hover docs and lint,
and `GET /api/schema` serves it.

## What is in it

| Export | Contents |
| --- | --- |
| `schema` | The whole bundle (`SchemaBundle`), also importable as `@caddy-ui/caddy-schema/schema.json` |
| `directives` | 41 directives: summary, docs link, category, default order, matcher support, typed positional args, subdirectives (recursive), module variants (`transport http`, `lb_policy cookie`, `issuer acme`, `output file`, `uri strip_prefix` …), examples |
| `matchers` | 17 standard request matchers with args, block form options and CEL form |
| `responseMatchers` | `status` and `header` |
| `schema.matcherTokenForms` | `*`, `/path`, `@name` |
| `globalOptions` | Every option in the global options block, with nested blocks (`servers`, `pki`, `log`, …) |
| `placeholders` | 180+ placeholders: shorthands linked to long forms, scope (http, reverse_proxy, error, tls, matcher, snippet, global) |
| `defaultOrder`, `effectiveOrder()` | Caddy's handler order, and the order after `order` global options |
| `checkValue()`, `UPSTREAM_FORMS`, `DURATION_RE`, `SIZE_RE`, … | Value grammars per argument type |
| `validateBlocks()`, `validateSiteBody()`, `validateDirective()`, `validateGlobalOptions()` | Schema validation with line-precise diagnostics |

The types in `src/types.ts` are the contract from `PLAN.md` §3.2. Fields marked
"extension" are optional additions (see `DECISIONS.md`).

### Argument model

Each directive line is `name [<matcher>] args… [{ block }]`. `matcher: true` means the
first token may be a matcher (`*`, `/path`, `@name`). `args` lists positional
arguments with a type (`duration`, `size`, `status`, `upstream`, `header`, `path`,
`url`, `regexp`, `cel`, `placeholder`, `matcher`, `enum`, `int`, `string`), plus
`optional`, `variadic`, `enum`, `literals` (keywords accepted besides the type, such as
`off`) and `prefixes` (operators such as `+`/`-` on header fields). When the docs give
several shapes, `forms` lists them and `args` is their union. `variants` holds modules
picked by the first argument. A block holds `subdirectives`, free-form `rows`
(`basic_auth` users, `map` rows, `header` fields), nested HTTP directives
(`allowsDirectives`), or response matcher definitions (`allowsResponseMatchers`).

### Validation

The validators take a minimal node shape, so they work on W1's CST (map `name.text`
and `args[].text`) or anything else:

```ts
import { schema, validateSiteBody } from '@caddy-ui/caddy-schema';

validateSiteBody(schema, [
	{ name: 'reverse_proxy', args: ['localhost:8080'], line: 2, body: [{ name: 'health_interval', args: ['ten'], line: 3 }] }
]);
// → [{ severity: 'error', code: 'bad-value', path: ['reverse_proxy', 'health_interval'], argIndex: 0, line: 3,
//      message: 'health_interval: duration: expected a duration like 30s, 5m or 1h30m, got "ten"' }]
```

Unknown directives and global options are warnings (they may come from plugins).
Values with placeholders or `{$ENV}` pass, since they are only known at runtime.
Caddy's `/adapt` remains the final word; this gives instant feedback while typing.

## Regenerating

```sh
pnpm --filter @caddy-ui/caddy-schema generate          # from the pinned docs commit
pnpm --filter @caddy-ui/caddy-schema generate:check    # fail if schema.json is stale
CADDY_DOCS_DIR=../website pnpm … generate              # from a local checkout
CADDY_DOCS_REF=master pnpm … generate -- --pin         # move the pin to the latest docs
```

The pin lives in `docs-source.json`. The docs are fetched once into
`node_modules/.cache/caddy-docs/`. The output is a pure function of the docs and
`scripts/overrides.ts`, so a re-run on the same commit is byte-identical, and a test
checks that.

How it works: `scripts/md.ts` reads headings, code blocks and bullets;
`scripts/syntax.ts` parses the `caddy-d` syntax skeletons (`<arg>`, `[optional]`,
`a|b`, `...`, nested blocks); `scripts/infer.ts` guesses value types from argument
names; `scripts/extract.ts` assembles directives, module variants, matchers, global
options and placeholders and attaches the bullet docs; `scripts/overrides.ts` holds
the hand-curated corrections (categories, enums stated in prose, `tls` and `uri`
argument forms, response-matcher arguments, `php_fastcgi` and `forward_auth`
inheriting `reverse_proxy` subdirectives). An override that no longer finds its node
throws, so a docs change cannot silently drop a correction.

## Tests

- `test/schema.test.ts`: contract shape for every node, counts, ordering, value grammars.
- `test/validate.test.ts`: the sample home-lab Caddyfile (`test/fixtures/sample-home.Caddyfile`, David's file with hostnames anonymised) validates with no errors or warnings, and each diagnostic fires where it should.
- `test/docs.test.ts`: against the pinned docs, every directive, matcher heading and global option is present, the generator reproduces `schema.json` byte for byte, and every `caddy`/`caddy-d` example in the directive, matcher and options docs validates without errors (200+ examples).
- `.github/workflows/caddy-docs-drift.yml` runs the coverage tests weekly against the docs' `master`, so a new directive in Caddy shows up as a failing run.

`test/mini-parse.ts` is a small reader for the tests only; the real parser is `packages/caddyfile` (W1).
