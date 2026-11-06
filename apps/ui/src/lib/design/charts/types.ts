/** Chart data, mirroring the collector API (apps/ui/src/lib/server/collector/README.md). */

/** [bucket start ms, value]; null is "no data for this bucket", 0 is "the source ran and saw nothing". */
export type Point = [number, number | null];
export type SourceName = 'metrics' | 'logs' | 'probes';
export type Series = { source: SourceName | null; points: Point[] };

export type StripState = 'up' | 'down' | 'mixed' | 'unknown';
export type StripCell = { t: number; state: StripState; upRatio: number | null };

export type View = 'charts' | 'tables';

export type BarRow = { key: string; label: string; v: number; display: string; href?: string; sub?: string };

/** What every chart frame needs besides its data. */
export type Frame = {
	title: string;
	sub?: string;
	/** The source note in the card foot, e.g. "From Caddy's metrics". */
	note?: string;
	asOf?: number;
	stale?: boolean;
	timeZone: string;
	view?: View;
	emptyTitle?: string;
	emptyLine?: string;
};

export type RangeKey = '1h' | '24h' | '7d' | '30d';
