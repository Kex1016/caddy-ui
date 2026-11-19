import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { join } from 'node:path';
import type {
	ApplyFailure,
	ApplyResult,
	CaddyfileDoc,
	CaddyStatus,
	Diagnostic,
	Drift,
	ExternalChange,
	Revision,
	RevisionSummary,
	UpstreamStatus,
	ValidateResult
} from '$lib/api/config';
import { AdminError, AdminUnreachableError, type CaddyAdmin } from '../caddy/admin';
import { configHash, processFacts, sameConfig, sha256, upstreamOwners } from '../caddy/inspect';
import type { Db } from '../db';
import type { CaddyfileParser } from './parser';

/**
 * Reads, validates, applies, backs up and rolls back the Caddyfile (PLAN.md §5, W3).
 *
 * Apply order: parser diagnostics → Caddy `/adapt` → backup the old file → write in place → Caddy `/load`.
 * If `/load` fails the old text is written back, so the file never describes a config Caddy refused.
 * Writes truncate and rewrite the same inode, never rename, because the Caddyfile is usually a
 * single-file bind mount and a rename would detach it from the Caddy container.
 */

export type AdminApi = Pick<CaddyAdmin, 'getConfig' | 'adapt' | 'load' | 'upstreams' | 'metrics'>;

export type ConfigServiceOptions = {
	admin: AdminApi;
	db: Db;
	caddyfilePath: string;
	backupDir: string;
	parser?: () => CaddyfileParser | null;
	now?: () => number;
	/** Revisions kept in SQLite (PLAN.md §3.2: last 200). */
	keepRevisions?: number;
	/** Backup files kept on disk next to the database. */
	keepBackups?: number;
	/** Write every save in `caddy fmt` style using the parser's `format()` (default true). */
	formatOnSave?: boolean;
};

/** When `formatted`, `diagnostics` describe the formatted text and replace the validation's. */
type Normalised = { text: string; formatted: boolean; diagnostics: Diagnostic[] };

export class ApplyError extends Error {
	constructor(
		readonly status: number,
		readonly body: ApplyFailure
	) {
		super(body.message);
		this.name = 'ApplyError';
	}
}

export type FileState = { exists: boolean; text: string; hash: string; mtimeMs: number | null };

type RevisionRow = { id: number; ts: number; author: string; text: string; note: string };

const BACKUP_PREFIX = 'Caddyfile-';

function summarize(row: RevisionRow): RevisionSummary {
	return {
		id: row.id,
		ts: row.ts,
		author: row.author,
		note: row.note,
		hash: sha256(row.text),
		bytes: Buffer.byteLength(row.text, 'utf8'),
		lines: row.text === '' ? 0 : row.text.split('\n').length - (row.text.endsWith('\n') ? 1 : 0)
	};
}

function unreachable(err: AdminUnreachableError, what: string): ApplyError {
	return new ApplyError(503, {
		code: 'unreachable',
		message: `${err.message}, so ${what}`,
		diagnostics: [{ severity: 'error', source: 'service', message: err.message }]
	});
}

export class ConfigService {
	private readonly admin: AdminApi;
	private readonly db: Db;
	readonly path: string;
	private readonly backupDir: string;
	private readonly parser: () => CaddyfileParser | null;
	private readonly now: () => number;
	private keepRevisions: number;
	private keepBackups: number;
	private readonly formatOnSave: boolean;

	/** Hash of the file as this service last wrote or accepted it; anything else on disk is an outside edit. */
	private knownHash: string | null = null;
	private external: ExternalChange | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private watching = false;
	private readonly onWatch = (curr: Stats, prev: Stats) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size || curr.ino !== prev.ino) {
			void this.checkForExternalEdit().catch((err) =>
				console.error('caddy-ui: watching the Caddyfile:', err)
			);
		}
	};

	constructor(opts: ConfigServiceOptions) {
		this.admin = opts.admin;
		this.db = opts.db;
		this.path = opts.caddyfilePath;
		this.backupDir = opts.backupDir;
		this.parser = opts.parser ?? (() => null);
		this.now = opts.now ?? Date.now;
		this.keepRevisions = opts.keepRevisions ?? 200;
		this.keepBackups = opts.keepBackups ?? 50;
		this.formatOnSave = opts.formatOnSave ?? true;
	}

	/** Run one state-changing step at a time, so two applies or an apply and the watcher never interleave. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	async readFile(): Promise<FileState> {
		try {
			const [text, st] = await Promise.all([readFile(this.path, 'utf8'), stat(this.path)]);
			return { exists: true, text, hash: sha256(text), mtimeMs: st.mtimeMs };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return { exists: false, text: '', hash: sha256(''), mtimeMs: null };
			}
			throw err;
		}
	}

	get externalChange(): ExternalChange | null {
		return this.external;
	}

	// ── validation ────────────────────────────────────────────────────────────────────────────

	private parse(text: string): { cst: unknown; diagnostics: Diagnostic[]; ready: boolean } {
		const parser = this.parser();
		if (!parser) return { cst: null, diagnostics: [], ready: false };
		try {
			const { cst, diagnostics } = parser.parse(text);
			return { cst, diagnostics, ready: true };
		} catch (err) {
			const message = `The parser failed on this file: ${err instanceof Error ? err.message : String(err)}`;
			return { cst: null, diagnostics: [{ severity: 'error', source: 'parser', message }], ready: true };
		}
	}

	/**
	 * Dry-run validation: parser (when installed) and Caddy's `/adapt`. Throws AdminUnreachableError
	 * when Caddy cannot be asked, because "valid" would then be a guess.
	 */
	async validate(text: string): Promise<ValidateResult & { config: unknown }> {
		const parsed = this.parse(text);
		const adapted = await this.admin.adapt(text);
		const diagnostics = [...parsed.diagnostics, ...adapted.diagnostics];
		const ok = adapted.ok && !diagnostics.some((d) => d.severity === 'error');
		return { ok, diagnostics, config: adapted.ok ? adapted.config : null };
	}

	// ── reading ───────────────────────────────────────────────────────────────────────────────

	async document(): Promise<CaddyfileDoc> {
		const file = await this.readFile();
		const parsed = this.parse(file.text);
		const diagnostics = [...parsed.diagnostics];
		let drift: Drift;
		if (!file.exists) {
			drift = { state: 'unknown', message: `There is no file at ${this.path} yet` };
		} else {
			try {
				const [adapted, running] = await Promise.all([this.admin.adapt(file.text), this.admin.getConfig()]);
				diagnostics.push(...adapted.diagnostics);
				drift = adapted.ok ? this.compare(adapted.config, running) : this.brokenFile(adapted.diagnostics);
			} catch (err) {
				drift = this.unknownDrift(err);
				diagnostics.push({ severity: 'info', source: 'service', message: drift.message });
			}
		}
		return {
			path: this.path,
			exists: file.exists,
			text: file.text,
			hash: file.hash,
			mtimeMs: file.mtimeMs,
			cst: parsed.cst,
			parser: parsed.ready ? 'ready' : 'unavailable',
			diagnostics,
			drift,
			externalChange: this.external
		};
	}

	private compare(fileConfig: unknown, running: unknown): Drift {
		return sameConfig(fileConfig, running)
			? { state: 'in_sync' }
			: { state: 'file_differs', message: 'The Caddyfile on disk is not what Caddy is running' };
	}

	private brokenFile(diagnostics: Diagnostic[]): Drift {
		const first = diagnostics.find((d) => d.severity === 'error');
		const where = first?.line ? ` (line ${first.line})` : '';
		return {
			state: 'file_differs',
			message: `The Caddyfile on disk does not adapt${where}, so Caddy cannot be running it: ${first?.message ?? 'unknown error'}`
		};
	}

	private unknownDrift(err: unknown): Extract<Drift, { state: 'unknown' }> {
		if (err instanceof AdminUnreachableError) return { state: 'unknown', message: err.message };
		if (err instanceof AdminError)
			return { state: 'unknown', message: `Caddy answered ${err.status}: ${err.message}` };
		throw err;
	}

	async drift(): Promise<Drift> {
		const file = await this.readFile();
		if (!file.exists) return { state: 'unknown', message: `There is no file at ${this.path} yet` };
		try {
			const [adapted, running] = await Promise.all([this.admin.adapt(file.text), this.admin.getConfig()]);
			return adapted.ok ? this.compare(adapted.config, running) : this.brokenFile(adapted.diagnostics);
		} catch (err) {
			return this.unknownDrift(err);
		}
	}

	async status(): Promise<CaddyStatus> {
		const checkedAt = this.now();
		const file = await this.readFile();
		const base = {
			checkedAt,
			file: { path: this.path, exists: file.exists, hash: file.hash },
			externalChange: this.external
		};
		try {
			const [running, metrics, drift] = await Promise.all([
				this.admin.getConfig(),
				this.admin.metrics().catch((err: unknown) => {
					if (err instanceof AdminError) return ''; // metrics can be switched off; status still works
					throw err;
				}),
				this.drift()
			]);
			return {
				...base,
				reachable: true,
				error: null,
				...processFacts(metrics),
				configHash: configHash(running),
				drift
			};
		} catch (err) {
			const drift = this.unknownDrift(err);
			return {
				...base,
				reachable: !(err instanceof AdminUnreachableError),
				error: drift.message,
				version: null,
				startedAt: null,
				lastReload: null,
				configHash: null,
				drift
			};
		}
	}

	async upstreams(): Promise<UpstreamStatus[]> {
		const [list, running] = await Promise.all([this.admin.upstreams(), this.admin.getConfig()]);
		const owners = upstreamOwners(running);
		return list.map((u) => ({
			address: u.address,
			numRequests: u.num_requests ?? 0,
			fails: u.fails ?? 0,
			sites: (owners.get(u.address) ?? []).map((hosts) => ({ hosts }))
		}));
	}

	// ── applying ──────────────────────────────────────────────────────────────────────────────

	/**
	 * Validate, write and load `text`. With `baseHash`, refuses (409) when the file changed since the
	 * caller read it. Applying the text that is already on disk and already running changes nothing.
	 */
	apply(text: string, opts: { author: string; note?: string; baseHash?: string }): Promise<ApplyResult> {
		return this.exclusive(() => this.applyNow(text, opts));
	}

	private async applyNow(
		text: string,
		opts: { author: string; note?: string; baseHash?: string }
	): Promise<ApplyResult> {
		const before = await this.readFile();
		if (opts.baseHash && opts.baseHash !== before.hash) {
			throw new ApplyError(409, {
				code: 'conflict',
				message: 'The Caddyfile changed on disk since you opened it. Reload it, or apply again to overwrite.',
				diagnostics: [],
				currentHash: before.hash
			});
		}

		let validation: Awaited<ReturnType<ConfigService['validate']>>;
		let running: unknown;
		try {
			[validation, running] = await Promise.all([this.validate(text), this.admin.getConfig()]);
		} catch (err) {
			if (err instanceof AdminUnreachableError) throw unreachable(err, 'nothing was written');
			throw err;
		}
		if (!validation.ok) {
			const first = validation.diagnostics.find((d) => d.severity === 'error');
			throw new ApplyError(422, {
				code: 'invalid',
				message: first
					? `${first.line ? `Line ${first.line}: ` : ''}${first.message}`
					: 'The Caddyfile is not valid',
				diagnostics: validation.diagnostics
			});
		}

		let normal: Normalised;
		try {
			normal = await this.normalise(text, validation.config);
		} catch (err) {
			if (err instanceof AdminUnreachableError) throw unreachable(err, 'nothing was written');
			throw err;
		}
		const diagnostics = normal.formatted
			? normal.diagnostics
			: [...validation.diagnostics, ...normal.diagnostics];
		text = normal.text;
		const hash = sha256(text);
		const needsWrite = !before.exists || before.text !== text;
		const needsLoad = !sameConfig(validation.config, running);
		if (!needsWrite && !needsLoad) {
			this.accept(hash);
			const latest = this.latestRow();
			return {
				changed: false,
				text,
				formatted: normal.formatted,
				written: false,
				loaded: false,
				hash,
				revision: latest ? summarize(latest) : null,
				diagnostics
			};
		}

		if (needsWrite) {
			if (before.exists) await this.backup(before.text);
			try {
				this.knownHash = hash; // set first, so the watcher does not report our own write
				await writeFile(this.path, text, 'utf8');
			} catch (err) {
				this.knownHash = before.hash;
				throw new ApplyError(500, {
					code: 'write_failed',
					message: `Could not write ${this.path}: ${err instanceof Error ? err.message : String(err)}`,
					diagnostics: []
				});
			}
		}

		if (needsLoad) {
			try {
				await this.admin.load(text);
			} catch (err) {
				if (needsWrite) await this.restoreFile(before);
				if (err instanceof AdminUnreachableError) throw unreachable(err, 'the file was left as it was');
				const message = err instanceof Error ? err.message : String(err);
				throw new ApplyError(502, {
					code: 'load_failed',
					message: `Caddy refused the new config and kept the old one running: ${message}`,
					diagnostics: [{ severity: 'error', source: 'load', message }]
				});
			}
		}

		const revision = this.record(text, opts.author, opts.note ?? '');
		this.accept(hash);
		return {
			changed: true,
			text,
			formatted: normal.formatted,
			written: needsWrite,
			loaded: needsLoad,
			hash,
			revision: summarize(revision),
			diagnostics
		};
	}

	/**
	 * Every save is written in `caddy fmt` style (DECISIONS.md, 6 Nov). The formatted text is adapted again
	 * and must give exactly the config the text as sent gives; if it does not (a formatter bug), the text is
	 * saved as sent with a warning rather than changing what Caddy runs.
	 */
	private async normalise(text: string, config: unknown): Promise<Normalised> {
		const parser = this.formatOnSave ? this.parser() : null;
		if (!parser) return { text, formatted: false, diagnostics: [] };
		let formatted: string;
		try {
			formatted = parser.format(text);
		} catch (err) {
			return this.keepAsSent(
				text,
				`the formatter failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		if (formatted === text) return { text, formatted: false, diagnostics: [] };
		const adapted = await this.admin.adapt(formatted);
		if (!adapted.ok) return this.keepAsSent(text, 'Caddy refused the formatted text');
		if (!sameConfig(adapted.config, config))
			return this.keepAsSent(text, 'formatting changed the adapted config');
		// Diagnostics for the text that is written, so their line numbers match the file on disk.
		return {
			text: formatted,
			formatted: true,
			diagnostics: [...this.parse(formatted).diagnostics, ...adapted.diagnostics]
		};
	}

	private keepAsSent(text: string, why: string): Normalised {
		console.error(`caddy-ui: not formatting the Caddyfile on save: ${why}`);
		return {
			text,
			formatted: false,
			diagnostics: [
				{
					severity: 'warning',
					source: 'service',
					message: `Saved as written, not in caddy fmt style, because ${why}`
				}
			]
		};
	}

	/** Put the file back the way it was before a failed apply. */
	private async restoreFile(before: FileState): Promise<void> {
		this.knownHash = before.hash;
		if (before.exists) await writeFile(this.path, before.text, 'utf8');
		else await unlink(this.path).catch(() => undefined);
	}

	private accept(hash: string): void {
		this.knownHash = hash;
		this.external = null;
	}

	/** Restore a revision: the same validate → write → load path as any edit, recorded as a new revision. */
	async restore(id: number, author: string): Promise<ApplyResult | null> {
		const rev = this.getRevision(id);
		if (!rev) return null;
		return this.apply(rev.text, { author, note: `Restored revision #${id}` });
	}

	// ── backups ───────────────────────────────────────────────────────────────────────────────

	private async backup(text: string): Promise<void> {
		await mkdir(this.backupDir, { recursive: true });
		const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace('.', '');
		let name = `${BACKUP_PREFIX}${stamp}.bak`;
		const existing = new Set(await readdir(this.backupDir));
		for (let i = 1; existing.has(name); i++) name = `${BACKUP_PREFIX}${stamp}-${i}.bak`;
		await writeFile(join(this.backupDir, name), text, { encoding: 'utf8', mode: 0o600 });
		await this.trimBackups();
	}

	private async trimBackups(): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.backupDir);
		} catch {
			return;
		}
		const backups = names.filter((f) => f.startsWith(BACKUP_PREFIX)).sort();
		for (const old of backups.slice(0, Math.max(0, backups.length - this.keepBackups))) {
			await unlink(join(this.backupDir, old)).catch(() => undefined);
		}
	}

	/** How many revisions and backup files are kept. */
	get keeping(): { revisions: number; backups: number } {
		return { revisions: this.keepRevisions, backups: this.keepBackups };
	}

	/**
	 * Change how many revisions and backups are kept (Settings → Data and storage, `CADDY_UI_REVISIONS_KEEP` and
	 * `CADDY_UI_BACKUPS_KEEP`). A lower number trims the oldest at once; a higher one keeps more from now on.
	 */
	async setKeep(keep: { revisions: number; backups: number }): Promise<void> {
		this.keepRevisions = keep.revisions;
		this.keepBackups = keep.backups;
		// One synchronous DELETE, so the page that saved the setting already sees the shorter History.
		this.trimRevisions();
		await this.exclusive(() => this.trimBackups());
	}

	/** Revisions and backup files kept now. */
	async historyCounts(): Promise<{ revisions: number; backups: number }> {
		const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number };
		let backups = 0;
		try {
			backups = (await readdir(this.backupDir)).filter((f) => f.startsWith(BACKUP_PREFIX)).length;
		} catch {
			// No backup written yet.
		}
		return { revisions: n, backups };
	}

	private trimRevisions(): void {
		this.db
			.prepare('DELETE FROM revisions WHERE id NOT IN (SELECT id FROM revisions ORDER BY id DESC LIMIT ?)')
			.run(this.keepRevisions);
	}

	// ── revisions ─────────────────────────────────────────────────────────────────────────────

	private latestRow(): RevisionRow | undefined {
		return this.db.prepare('SELECT * FROM revisions ORDER BY id DESC LIMIT 1').get() as
			RevisionRow | undefined;
	}

	/** Store `text` as a revision unless it equals the newest one, then prune to the newest N. */
	private record(text: string, author: string, note: string): RevisionRow {
		const latest = this.latestRow();
		if (latest && latest.text === text) return latest;
		const info = this.db
			.prepare('INSERT INTO revisions (ts, author, text, note) VALUES (?, ?, ?, ?)')
			.run(this.now(), author, text, note);
		this.trimRevisions();
		return this.getRevision(Number(info.lastInsertRowid)) as RevisionRow;
	}

	listRevisions(limit = 200): RevisionSummary[] {
		const rows = this.db
			.prepare('SELECT * FROM revisions ORDER BY id DESC LIMIT ?')
			.all(limit) as RevisionRow[];
		return rows.map(summarize);
	}

	getRevision(id: number): Revision | undefined {
		const row = this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(id) as RevisionRow | undefined;
		return row ? { ...summarize(row), text: row.text } : undefined;
	}

	// ── outside edits ─────────────────────────────────────────────────────────────────────────

	/**
	 * At start: remember the file as known, and record it as a revision when it differs from the newest one,
	 * so history always contains what was on disk before the UI touched it.
	 */
	async init(): Promise<void> {
		await this.exclusive(async () => {
			const file = await this.readFile();
			this.knownHash = file.hash;
			if (!file.exists) return;
			const latest = this.latestRow();
			if (latest?.text === file.text) return;
			const row = this.record(
				file.text,
				'outside the UI',
				latest ? 'Changed on disk while the UI was stopped' : 'First seen on disk'
			);
			if (latest) this.external = { at: this.now(), hash: file.hash, revisionId: row.id };
		});
	}

	/** Called by the watcher: an edit made outside the UI becomes a revision and a flag the editor shows. */
	checkForExternalEdit(): Promise<ExternalChange | null> {
		return this.exclusive(async () => {
			const file = await this.readFile();
			if (!file.exists || file.hash === this.knownHash) return null;
			const row = this.record(file.text, 'outside the UI', 'Edited outside the UI');
			this.knownHash = file.hash;
			this.external = { at: this.now(), hash: file.hash, revisionId: row.id };
			return this.external;
		});
	}

	/**
	 * Poll the file's stat (default every 2s). Polling, not inotify, because inotify events do not cross
	 * a Docker bind mount reliably and editors that replace the file would break an fs.watch handle.
	 */
	watch(intervalMs = 2000): void {
		if (this.watching) return;
		this.watching = true;
		watchFile(this.path, { interval: intervalMs, persistent: false }, this.onWatch);
	}

	unwatch(): void {
		if (!this.watching) return;
		this.watching = false;
		unwatchFile(this.path, this.onWatch);
	}
}
