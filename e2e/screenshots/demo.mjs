// Starts the e2e stack (support/stack.mjs) with made-up activity, so the README screenshots show live pages.
// Run as root in a throwaway container or VM (see docs/testing.md): it binds port 443 and adds
// the anonymised Caddyfile's 10.0.0.x addresses to the loopback interface.
//
// On top of the test stack it:
//   - starts stub upstreams on those 10.0.0.x addresses, leaving two down so the pages show a problem;
//   - starts from demoCaddyfile() (support/paths.mjs): the sample with per-site metrics and Caddy's internal CA;
//   - appends a fake JSON access log covering the last 24 hours, and keeps a trickle of real requests going to
//     port 443 for the metrics charts.
// Nothing here is real traffic: the hosts are the fixture's example domains and the client IPs in the fake log
// come from the documentation ranges (RFC 5737).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoCaddyfile, paths, sampleCaddyfile, UI_PORT } from '../support/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sample = sampleCaddyfile();

// --- stub upstreams --------------------------------------------------------------------------------------------
const DOWN = new Set(['10.0.0.111:8080', '10.0.0.102:4567']);
const upstreams = [...new Set(sample.match(/10\.0\.0\.\d+:\d+/g) ?? [])];
const ips = [...new Set(upstreams.map((u) => u.split(':')[0]))];
const alias = spawnSync('python3', [join(here, 'loopback-alias.py'), ...ips], { stdio: 'inherit' });
if (alias.status !== 0)
	console.error('demo: could not add loopback addresses; every upstream will show as down');
else
	for (const u of upstreams) {
		if (DOWN.has(u)) continue;
		const [host, port] = u.split(':');
		http
			.createServer((_req, res) => res.end('ok'))
			.on('error', (e) => console.error(`demo: stub ${u}: ${e.message}`))
			.listen(Number(port), host);
	}

// --- the stack -------------------------------------------------------------------------------------------------
const E2E_CADDYFILE = join(tmpdir(), 'caddy-ui-demo.Caddyfile');
writeFileSync(E2E_CADDYFILE, demoCaddyfile());
const stack = spawn(process.execPath, [join(here, '..', 'support', 'stack.mjs')], {
	stdio: 'inherit',
	env: { ...process.env, E2E_CADDYFILE }
});
stack.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => (stack.kill(s), process.exit(0)));

function get(url, { headers = {}, servername } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const req = (u.protocol === 'https:' ? https : http).request(
			u,
			{ headers, servername, rejectUnauthorized: false, agent: false, timeout: 5000 },
			(res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode ?? 0));
			}
		);
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', reject);
		req.end();
	});
}

for (let i = 0; ; i++) {
	try {
		if ((await get(`http://127.0.0.1:${UI_PORT}/api/health`)) === 200) break;
	} catch {
		// not up yet
	}
	if (i > 240) throw new Error('demo: the stack did not come up');
	await new Promise((r) => setTimeout(r, 250));
}

// --- a fake access log for the last 24 hours (the collector reads appends to a file it has already seen) -------
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const hosts = [...sample.matchAll(/^([a-z0-9][^\s,{(]*)(?:,[^{]*)? \{$/gm)].map((m) => m[1]);
const weights = hosts.map((_, i) => 1 + ((i * 7919) % 13) ** 1.6);
const total = weights.reduce((a, b) => a + b, 0);
const weightedHost = () => {
	let r = rnd() * total;
	for (let i = 0; i < hosts.length; i++) if ((r -= weights[i]) < 0) return hosts[i];
	return hosts[0];
};
const PATHS = [
	'/',
	'/',
	'/',
	'/api/status',
	'/api/items',
	'/login',
	'/assets/app.js',
	'/assets/app.css',
	'/favicon.ico',
	'/healthz',
	'/robots.txt',
	'/feed.xml',
	'/images/cover.webp'
];
const CLIENTS = [...Array(24)].map((_, i) => (i < 12 ? `192.0.2.${10 + i * 7}` : `198.51.100.${3 + i * 9}`));
const now = Date.now();
const lines = [];
for (let t = now - 24 * 3600_000; t < now - 120_000;) {
	const hour = new Date(t).getUTCHours();
	const busy = 0.35 + 0.65 * Math.max(0, Math.sin(((hour - 5) / 24) * Math.PI * 2));
	t += (2500 + rnd() * 5000) / busy;
	const r = rnd();
	const status = r < 0.006 ? 502 : r < 0.04 ? 404 : r < 0.05 ? 401 : r < 0.12 ? 304 : 200;
	lines.push(
		JSON.stringify({
			level: 'info',
			ts: t / 1000,
			logger: 'http.log.access',
			msg: 'handled request',
			request: {
				client_ip: pick(CLIENTS),
				proto: 'HTTP/2.0',
				method: 'GET',
				host: weightedHost(),
				uri: pick(PATHS)
			},
			duration: (status === 502 ? 3 : 0.004 + rnd() ** 3 * 0.4) * (1 + 0.5 * busy),
			size: status === 304 ? 0 : Math.floor(400 + rnd() ** 2 * 90_000),
			status
		})
	);
}
appendFileSync(paths.accessLog, lines.join('\n') + '\n');
console.error(
	`demo: ${upstreams.length - DOWN.size} of ${upstreams.length} upstreams stubbed, ${lines.length} log lines`
);

// --- a trickle of real requests through Caddy, for the metrics charts ------------------------------------------
setInterval(() => {
	const host = weightedHost();
	get(`https://127.0.0.1${pick(PATHS)}`, { headers: { host }, servername: host }).catch(() => {});
}, 200);
