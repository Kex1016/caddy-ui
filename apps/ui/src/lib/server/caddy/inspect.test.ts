import { describe, expect, it } from 'vitest';
import { canonicalJson, configHash, parseMetrics, processFacts, sameConfig, upstreamOwners } from './inspect';

describe('config comparison', () => {
	it('ignores key order but not array order', () => {
		expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
		expect(sameConfig({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(sameConfig({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
		expect(configHash(null)).toBe(configHash({}));
	});
});

describe('metrics', () => {
	it('parses labels with escapes and reads process facts', () => {
		const text = [
			'# HELP x y',
			'caddy_http_requests_total{handler="reverse_proxy",host="a.b",note="q\\"x"} 42',
			'process_start_time_seconds 1.762e+09',
			'caddy_config_last_reload_successful 0',
			'caddy_config_last_reload_success_timestamp_seconds 0',
			'go_build_info{path="x",version="(devel)"} 1',
			'caddy_build_info{version="v2.10.2"} 1'
		].join('\n');
		expect(parseMetrics(text)[0]).toEqual({
			name: 'caddy_http_requests_total',
			labels: { handler: 'reverse_proxy', host: 'a.b', note: 'q"x' },
			value: 42
		});
		expect(processFacts(text)).toEqual({
			version: 'v2.10.2',
			startedAt: 1_762_000_000_000,
			lastReload: { ok: false, at: null }
		});
		expect(processFacts('')).toEqual({ version: null, startedAt: null, lastReload: null });
	});
});

describe('upstreamOwners', () => {
	it('walks nested subroutes and inherits the host from the enclosing route', () => {
		const config = {
			apps: {
				http: {
					servers: {
						srv0: {
							routes: [
								{
									match: [{ host: ['apps.example.com'] }],
									handle: [
										{
											handler: 'subroute',
											routes: [
												{
													match: [{ path: ['/api/*'] }],
													handle: [
														{
															handler: 'subroute',
															routes: [
																{
																	handle: [
																		{ handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.40:8080' }] }
																	]
																}
															]
														}
													]
												},
												{
													handle: [
														{
															handler: 'reverse_proxy',
															upstreams: [{ dial: '10.0.0.41:80' }, { dial: '10.0.0.42:80' }]
														}
													]
												}
											]
										}
									]
								},
								{
									match: [{ host: ['a.example.com', 'b.example.com'] }],
									handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.41:80' }] }]
								}
							],
							errors: {
								routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.9:1' }] }] }]
							}
						}
					}
				}
			}
		};
		const owners = upstreamOwners(config);
		expect(owners.get('10.0.0.40:8080')).toEqual([['apps.example.com']]);
		expect(owners.get('10.0.0.41:80')).toEqual([['apps.example.com'], ['a.example.com', 'b.example.com']]);
		expect(owners.get('10.0.0.9:1')).toEqual([[]]);
		expect(upstreamOwners(null).size).toBe(0);
	});
});
