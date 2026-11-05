// Production entry point. Maps the Caddy UI variables onto the ones adapter-node reads, then starts the
// built SvelteKit server. adapter-node's own variables (ORIGIN, PROTOCOL_HEADER, ...) still work as-is.
import process from 'node:process';

process.env.PORT ??= process.env.CADDY_UI_PORT || '3001';
process.env.HOST ??= '0.0.0.0';

await import('./build/index.js');
