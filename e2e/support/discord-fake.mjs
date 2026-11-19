// A fake Discord webhook endpoint for the e2e suite (S5, docs/settings-and-perf-plan.md §3.1). It is the same fake the
// unit tests use (apps/ui/src/lib/server/notify/fake-discord.ts), served on DISCORD_PORT so the built UI reaches it
// through CADDY_UI_DISCORD_API_URL. Nothing here talks to the real Discord. Control paths are listed in that file.
//
// Run alone with `node support/discord-fake.mjs` (port E2E_DISCORD_PORT, default 3103); stack.mjs starts it.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DISCORD_PORT, paths } from './paths.mjs';

// Node 22.18+ loads the .ts file as it is: it imports only node:http and uses erasable TypeScript.
const { startFakeDiscord } = await import(
	pathToFileURL(join(paths.uiDir, 'src', 'lib', 'server', 'notify', 'fake-discord.ts')).href
);

export function startDiscordFake(port = DISCORD_PORT) {
	return startFakeDiscord(port);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const fake = await startDiscordFake();
	console.log(`fake Discord on ${fake.url}`);
}
