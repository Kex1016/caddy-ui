import { parse } from '@caddy-ui/caddyfile';
import { describe, expect, it } from 'vitest';
import { enableAccessLog, enableMetricsPerHost } from './caddy-helpers';

const LOG = '/var/log/caddy/access.log';
const noErrors = (text: string) => expect(parse(text).diagnostics).toEqual([]);

describe('enableMetricsPerHost', () => {
	it('adds a global options block when there is none', () => {
		const r = enableMetricsPerHost('a.example.com {\n\trespond 200\n}\n');
		expect(r.changed).toBe(true);
		expect(r.text).toBe('{\n\tmetrics {\n\t\tper_host\n\t}\n}\n\na.example.com {\n\trespond 200\n}\n');
		noErrors(r.text);
	});

	it('adds metrics to existing global options and keeps the rest', () => {
		const r = enableMetricsPerHost('{\n\tadmin 0.0.0.0:2019\n}\n\na.example.com {\n\trespond 200\n}\n');
		expect(r.text).toContain('\tadmin 0.0.0.0:2019\n\tmetrics {\n\t\tper_host\n\t}\n}');
	});

	it('adds per_host to a bare metrics option', () => {
		const r = enableMetricsPerHost('{\n\tmetrics\n}\n');
		expect(r.text).toBe('{\n\tmetrics {\n\t\tper_host\n\t}\n}\n');
		expect(r.summary).toMatch(/Adds per_host/);
	});

	it('changes nothing when it is already on', () => {
		const text = '{\n\tmetrics {\n\t\tper_host\n\t}\n}\n';
		expect(enableMetricsPerHost(text)).toMatchObject({ changed: false, text });
	});
});

describe('enableAccessLog', () => {
	it('adds a snippet and imports it in every site without a log', () => {
		const r = enableAccessLog(
			'{\n\tadmin :2019\n}\n\na.example.com {\n\trespond 200\n}\n\nb.example.com {\n\treverse_proxy 10.0.0.2:80\n}\n',
			LOG
		);
		expect(r.changed).toBe(true);
		expect(r.text).toContain(`(access_log) {\n\tlog {\n\t\toutput file ${LOG}\n\t\tformat json\n\t}\n}`);
		expect(r.text).toContain('a.example.com {\n\timport access_log\n\trespond 200\n}');
		expect(r.text).toContain('b.example.com {\n\timport access_log\n\treverse_proxy 10.0.0.2:80\n}');
		// The snippet goes before the first site, after the global options.
		expect(r.text.indexOf('(access_log)')).toBeGreaterThan(r.text.indexOf('admin'));
		expect(r.text.indexOf('(access_log)')).toBeLessThan(r.text.indexOf('a.example.com'));
		expect(r.summary).toMatch(/2 sites/);
		noErrors(r.text);
	});

	it('reuses a snippet that already writes the file, and leaves sites with their own log alone', () => {
		const text = [
			'(logs) {',
			'\tlog {',
			`\t\toutput file ${LOG}`,
			'\t\tformat json',
			'\t}',
			'}',
			'',
			'a.example.com {',
			'\timport logs',
			'}',
			'',
			'b.example.com {',
			'\trespond 200',
			'}',
			'',
			'c.example.com {',
			'\tlog {',
			'\t\toutput file /var/log/other.log',
			'\t}',
			'}',
			''
		].join('\n');
		const r = enableAccessLog(text, LOG);
		expect(r.text).toContain('b.example.com {\n\timport logs\n\trespond 200\n}');
		expect(r.text.match(/import logs/g)).toHaveLength(2);
		expect(r.text).not.toContain('(access_log)');
		expect(r.notes.join(' ')).toMatch(/c\.example\.com/);
		expect(r.summary).toMatch(/existing logs snippet/);
	});

	it('picks another name when access_log is taken by something else', () => {
		const r = enableAccessLog(
			'(access_log) {\n\theader X-A 1\n}\n\na.example.com {\n\trespond 200\n}\n',
			LOG
		);
		expect(r.text).toContain('(caddy_ui_access_log) {');
		expect(r.text).toContain('import caddy_ui_access_log');
	});

	it('changes nothing when every site logs already', () => {
		const text = `a.example.com {\n\tlog {\n\t\toutput file ${LOG}\n\t}\n}\n`;
		expect(enableAccessLog(text, LOG)).toMatchObject({ changed: false });
	});
});
