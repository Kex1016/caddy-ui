// Starts what the e2e suite runs against: a real Caddy and the built UI (apps/ui/build), wired together the way
// deploy/compose.example.yml wires them. Playwright runs this as its webServer and waits for /api/health.
//
// Caddy comes from one of two places:
//   CADDY_ADMIN_URL  an already running Caddy (CI starts the official caddy image with `docker run`), or
//   CADDY_BIN        a caddy binary this script starts itself (local runs).
// Either way the script loads the e2e Caddyfile into it through the admin API, so Caddy never needs the file.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { baseCaddyfile, paths, UI_PORT } from './paths.mjs';

const children = [];
function stop() {
	for (const c of children) c.kill('SIGTERM');
}
process.on('SIGINT', () => (stop(), process.exit(0)));
process.on('SIGTERM', () => (stop(), process.exit(0)));
process.on('exit', stop);

function admin(method, path, body, contentType) {
	const url = new URL(path, paths.adminUrl);
	return new Promise((resolve, reject) => {
		const req = http.request(
			url,
			{
				method,
				headers: body ? { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } : {}
			},
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}

async function waitFor(what, fn, ms = 30_000) {
	const end = Date.now() + ms;
	for (;;) {
		try {
			if (await fn()) return;
		} catch {
			// not up yet
		}
		if (Date.now() > end) throw new Error(`e2e stack: ${what} did not come up within ${ms / 1000}s`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

rmSync(paths.dir, { recursive: true, force: true });
mkdirSync(paths.uiData, { recursive: true });
mkdirSync(paths.caddyData, { recursive: true });
// E2E_CADDYFILE swaps the starting file; screenshots/demo.mjs uses it. The tests always start from the base one.
const text = process.env.E2E_CADDYFILE ? readFileSync(process.env.E2E_CADDYFILE, 'utf8') : baseCaddyfile();
writeFileSync(paths.caddyfile, text);
writeFileSync(paths.accessLog, '');

if (!process.env.CADDY_ADMIN_URL) {
	const bin = process.env.CADDY_BIN;
	if (!bin) {
		console.error('e2e stack: set CADDY_BIN to a caddy binary, or CADDY_ADMIN_URL to a running Caddy');
		process.exit(1);
	}
	writeFileSync(paths.bootConfig, JSON.stringify({ admin: { listen: '127.0.0.1:2019' } }));
	const caddy = spawn(bin, ['run', '--config', paths.bootConfig], {
		stdio: ['ignore', openSync(paths.caddyLog, 'a'), openSync(paths.caddyLog, 'a')],
		env: { ...process.env, XDG_DATA_HOME: paths.caddyData, XDG_CONFIG_HOME: paths.caddyData }
	});
	caddy.on('exit', (code) => {
		console.error(`e2e stack: caddy exited with ${code}`);
		process.exit(1);
	});
	children.push(caddy);
}

await waitFor('Caddy admin API', async () => (await admin('GET', '/config/')).status === 200);
const loaded = await admin('POST', '/load', text, 'text/caddyfile');
if (loaded.status !== 200) {
	console.error(`e2e stack: Caddy refused the e2e Caddyfile: ${loaded.text}`);
	process.exit(1);
}

const ui = spawn(process.execPath, ['server.js'], {
	cwd: paths.uiDir,
	stdio: ['ignore', 'inherit', 'inherit'],
	env: {
		...process.env,
		CADDY_UI_PORT: String(UI_PORT),
		CADDY_ADMIN_URL: paths.adminUrl,
		CADDYFILE_PATH: paths.caddyfile,
		CADDY_UI_DATA: paths.uiData,
		CADDY_LOG_PATH: paths.accessLog,
		CADDY_DATA_PATH: paths.caddyData,
		CADDY_UI_AUTH_MODE: 'local',
		CADDY_UI_USER: 'e2e',
		CADDY_UI_PASSWORD: 'e2e-password',
		CADDY_UI_SESSION_SECRET: 'e2e-session-secret-not-a-real-one-0123456789',
		CADDY_UI_PROBE_INTERVAL: '5s',
		CADDY_UI_SCRAPE_INTERVAL: '5s',
		ORIGIN: `http://127.0.0.1:${UI_PORT}`,
		TZ: 'Europe/Budapest'
	}
});
ui.on('exit', (code) => {
	console.error(`e2e stack: the UI exited with ${code}`);
	process.exit(1);
});
children.push(ui);
