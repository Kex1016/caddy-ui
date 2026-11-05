# Caddyfile coverage

What the visual editor, the text editor and the schema must support. Compiled from the
Caddy docs (`caddyserver/website`, `src/docs/markdown/caddyfile/`) on 5 Nov 2026. The
"Used" column marks what David's current Caddyfile uses; those get bespoke forms first,
everything else gets a schema-generated form.

Form levels:

- **bespoke** — a hand-designed form (W5).
- **generic** — a form generated from the schema: positional args as typed fields,
  subdirectives as a list of rows, nested blocks as nested forms (W5).
- **raw** — a line of tokens the user edits as text inside the visual editor; used for
  plugin directives and anything the schema does not know (always available).

## Structure

| Construct | Notes for the parser (W1) and editor (W5) | Used |
| --- | --- | --- |
| Global options block `{ … }` | First block only, at most one | yes |
| Site block `addr1, addr2 { … }` | Addresses separated by spaces or commas; scheme, host, wildcard, port forms; `http://`, `https://`, `:8080` catch-alls | yes |
| Snippet `(name) { … }` | Arguments via `{args[N]}` and `{args[:]}`; experimental `{block}` | yes (`tinyauth_forwarder`) |
| Named route `&(name) { … }` | Experimental; invoked with `invoke` | no |
| `import <pattern> [args…] [{block}]` | Snippet or file glob; may appear outside site blocks | yes (commented out) |
| Comments `# …` | Must survive round trip; "disable a block" is implemented as commenting out | yes |
| Tokens | Double quotes with `\"`, backticks, heredocs `<<MARKER … MARKER` with indentation stripping and trailing args, quoted braces are not blocks | yes (quotes) |
| Env vars `{$VAR}` / `{$VAR:default}` | Substituted before parse by Caddy; the editor keeps them as tokens and shows the resolved value as a hint only | no (but compose sets some) |
| Placeholders `{…}` | Catalogue in the schema; editor offers a picker; regex captures `{re.name.N}`, `{path.N}` | yes |
| Directive order and sorting | The editor shows the effective order (default order list, `order` global option, `route` for literal order) | implicit |

## Directives (41)

| Directive | Form | Key fields | Used |
| --- | --- | --- | --- |
| `abort` | generic | matcher | |
| `acme_server` | generic | ca, lifetime, resolvers, challenges, allow/deny policy, sign_with_root | |
| `basic_auth` | generic | matcher, hash algo, realm, user/hash rows | |
| `bind` | generic | hosts, protocols | |
| `encode` | generic | formats, minimum_length, match block, gzip level, zstd level | |
| `error` | generic | matcher, message, code | |
| `file_server` | bespoke | browse toggle, fs, root, hide, index, precompressed, status, disable_canonical_uris, pass_thru, browse options | yes |
| `forward_auth` | bespoke | matcher, upstreams, uri, copy_headers (with rename `>` form) | yes |
| `fs` | generic | backend | |
| `handle` | bespoke (container) | matcher, nested directives | yes |
| `handle_errors` | bespoke (container) | status codes list, nested directives | yes |
| `handle_path` | bespoke (container) | path matcher, nested directives | |
| `header` | generic | matcher, +/-/?/> ops, field, value, replace, defer, match block | |
| `import` | bespoke | snippet or file picker, args, optional block | yes (commented) |
| `intercept` | generic | response matchers, handle_response blocks, replace_status | |
| `invoke` | generic | route name | |
| `log` | generic (+ helper "enable access logging") | name, hostnames, output module, format module, level, no_hostname | no (planned) |
| `log_append` | generic | matcher, field, value | |
| `log_level` | generic | matcher, level | |
| `log_name` | generic | matcher, names | |
| `log_skip` | generic | matcher | |
| `map` | generic | source, destinations, mapping rows with regex, default | |
| `method` | generic | matcher, method | |
| `metrics` | generic | matcher, disable_openmetrics | |
| `php_fastcgi` | generic | upstreams, root, split, env, index, try_files, resolve_root_symlink, dial_timeout, read/write timeouts, capture_stderr, plus all `reverse_proxy` subdirectives | |
| `push` | generic | matcher, path, headers | |
| `redir` | bespoke | matcher, target, code (301/302/303/307/308/permanent/temporary/html/js) | yes |
| `request_body` | generic | matcher, max_size, read/write timeouts | |
| `request_header` | generic | matcher, +/-/> ops, field, value, replace | |
| `respond` | generic | matcher, status, body incl. heredoc, close | |
| `reverse_proxy` | bespoke | upstreams (static, `to`, `dynamic srv/a/multi`), lb (`lb_policy` with per-policy options, retries, try duration/interval, retry match), active health (uri, upstream, port, interval, passes, fails, timeout, method, status, request_body, body, follow_redirects, headers), passive health (fail_duration, max_fails, unhealthy_*), streaming (flush_interval, buffers, stream timeouts), proxy_status_name, trusted_proxies, `header_up`/`header_down` rows with regex replace, method, rewrite, `transport http|fastcgi` with every option (tls, tls_insecure_skip_verify, tls_server_name, versions, keepalive, dial_timeout, …), response matchers `@name { status, header }`, `replace_status`, `handle_response` with nested directives plus `copy_response` and `copy_response_headers` | yes |
| `rewrite` | bespoke | matcher, target (path, query, both) | yes |
| `root` | generic | matcher, path | |
| `route` | bespoke (container) | matcher, nested directives in literal order | yes |
| `templates` | generic | matcher, mime, between, root, extensions | |
| `timeouts` | generic | read_body, read_header, write, idle | |
| `tls` | generic | cert/key files, internal, acme options, dns provider, protocols, ciphers, curves, alpn, client_auth block, on_demand, issuer blocks, get_certificate, insecure_secrets | |
| `tracing` | generic | span name | |
| `try_files` | bespoke | files list, policy | yes |
| `uri` | bespoke | strip_prefix, strip_suffix, replace, path_regexp, query ops incl. block form | yes |
| `vars` | generic | matcher, name/value rows | |

The `copy_response` and `copy_response_headers` directives exist only inside
`reverse_proxy … handle_response` and are modelled there.

## Matchers (19 standard plus syntax forms)

| Matcher | Form | Notes | Used |
| --- | --- | --- | --- |
| `*` wildcard | bespoke | explicit "all requests" | yes (`reverse_proxy *`, `rewrite *`) |
| `/path` inline path | bespoke | single path token; sorted by specificity | yes |
| `@name` named matcher | bespoke | block form with multiple matchers (AND), single-line form, CEL backtick shorthand | yes |
| `client_ip` | generic | ranges, `private_ranges` | |
| `expression` | bespoke | CEL text with heredoc; validation via `/adapt` | |
| `file` | generic | root, try_files, try_policy, split_path | |
| `header` | generic | field, value with `*` wildcards, `!` absence | |
| `header_regexp` | generic | name, field, regexp | |
| `host` | generic | hosts | |
| `method` | generic | verbs | |
| `not` | bespoke | wraps matchers; block form | |
| `path` | bespoke | paths with `*`, `%` escapes | yes |
| `path_regexp` | bespoke | optional name, regexp; capture placeholders offered after | yes |
| `protocol` | generic | http / https / grpc / http/N+ | |
| `query` | generic | key=value rows | |
| `remote_ip` | generic | ranges, `private_ranges` | |
| `tls` | generic | any / early_data | |
| `url_pattern` | generic | pattern, base_url, ignore_case | |
| `vars` | generic | variable, values | |
| `vars_regexp` | generic | name, variable, regexp | |

Response matchers (`status`, `header`) inside `reverse_proxy` and `intercept` are a
separate small schema.

## Global options

All options in `caddyfile/options.md`, grouped as the docs do: General (`debug`,
`http_port`, `https_port`, `default_bind`, `order`, `storage`, `storage_clean_interval`,
`admin` with `origins` and `enforce_origin`, `persist_config`, `log`, `grace_period`,
`shutdown_delay`, `metrics` with `per_host`, `observe_catchall_hosts`, `otlp`), TLS
(`auto_https`, `tls_automate_names`, `email`, `default_sni`, `fallback_sni`,
`local_certs`, `skip_install_trust`, `acme_ca`, `acme_ca_root`, `acme_eab`, `acme_dns`,
`dns`, `tls_resolvers`, `ech`, `on_demand_tls`, `key_type`, `cert_issuer`,
`renew_interval`, `cert_lifetime`, `ocsp_interval`, `ocsp_stapling`,
`renewal_window_ratio`, `preferred_chains`), Server (`servers` with `name`,
`listener_wrappers`, `timeouts`, keepalive options, `trusted_proxies`,
`trusted_proxies_strict`, `trusted_proxies_unix`, `client_ip_headers`, `metrics`,
`max_header_size`, `enable_full_duplex`, `log_credentials`, `protocols`,
`strict_sni_host`), File systems (`filesystem`), PKI (`pki` with `ca` blocks), Events
(`events` with `on`).

David uses `servers { trusted_proxies static … }`, `admin <addr>`, `email`. Those three
get bespoke fields on the Globals page; the rest are generic.

## Placeholder catalogue (for the picker)

Caddyfile shorthands: `{host}`, `{hostport}`, `{port}`, `{path}`, `{path.N}` and
`{path.N}` from path captures, `{query}`, `{query.key}`, `{uri}`, `{scheme}`, `{method}`,
`{remote}`, `{remote_host}`, `{remote_port}`, `{client_ip}`, `{dir}`, `{file}`,
`{file_match.relative}`, `{header.Field}`, `{cookie.name}`, `{re.N}`, `{re.name.N}`,
`{vars.name}`, `{rp.header.Field}`, `{err.status_code}`, `{err.message}`, `{tls_cipher}`,
`{tls_version}`, `{tls_client_*}`, `{upstream_hostport}`; long forms
`{http.request.*}`, `{http.reverse_proxy.*}`, `{http.error.*}`, `{env.*}`, `{system.*}`,
`{time.now.*}`. The schema generator (W2) extracts the full list from
`caddyfile/concepts.md#placeholders` and the JSON docs.
