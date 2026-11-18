import type { ApiError, DnsRecord, DnsRecordInput, DryRun, ImportResult } from '$lib/api/porkbun';

/**
 * Shapes of the DNS records tab (workstream P2): what the page sends to `/api/porkbun/domains/:d/dns/*` and
 * what comes back. Client-safe.
 */

/** The data of a record, without its id and full name. */
export type RecordSnapshot = Pick<DnsRecord, 'host' | 'type' | 'content' | 'ttl' | 'prio' | 'notes'>;

/**
 * One change to a zone. An edit carries the whole record as it should be afterwards; the server sends Porkbun
 * only the fields that differ. `expect` is the record as the person saw it when they decided: when the live
 * record differs, the change is refused instead of overwriting what somebody else did.
 */
export type RecordChange =
	| { op: 'create'; record: DnsRecordInput }
	| { op: 'edit'; id: string; record: DnsRecordInput; expect?: RecordSnapshot }
	| { op: 'delete'; id: string; expect?: RecordSnapshot };

export type FieldName = 'host' | 'type' | 'content' | 'ttl' | 'prio' | 'notes';

/** What is wrong with one field of a record. `part` names the field of the type's form inside `content`. */
export type FieldError = { field: FieldName; part?: string; message: string };

/** Why a change can not be applied, found by this UI before Porkbun is asked. */
export type ProblemCode =
	| 'INVALID'
	| 'MISSING'
	| 'STALE'
	| 'READ_ONLY_TYPE'
	| 'TYPE_CHANGE'
	| 'REPEATED'
	| 'DUPLICATE'
	| 'CNAME_CONFLICT'
	| 'SPF_CONFLICT';

export type Problem = {
	code: ProblemCode;
	message: string;
	/** Records in the way, for a conflict. */
	records?: RecordSnapshot[];
	/** INVALID only. */
	fields?: FieldError[];
};

/** One change of a batch, worked out against the zone as it will be when the change's turn comes. */
export type PlannedChange = {
	index: number;
	op: RecordChange['op'];
	/** The full name the change is about. */
	name: string;
	type: string;
	/** The live record, for an edit or a delete. */
	before: RecordSnapshot | null;
	/** The record afterwards, for a create or an edit. */
	after: RecordSnapshot | null;
	/** Create only: the record in its canonical spelling, as it is sent. */
	input: DnsRecordInput | null;
	/** Edit only: the names of the fields that change. Empty means there is nothing to send. */
	changed: FieldName[];
	problems: Problem[];
	/** Worth saying, not blocking: a TTL Porkbun will raise, a CNAME at the apex. */
	advice: string[];
	/**
	 * True when the change only works after an earlier change of the same batch (a CNAME replacing the A record
	 * the batch deletes first). Porkbun's dry run sees the zone as it is now, so it can not judge such a change.
	 */
	needsEarlier: boolean;
};

/** `POST …/dns/preview`: the plan and, per change, Porkbun's dry run. */
export type PreviewItem = PlannedChange & {
	/** null where no dry run was made: the change has a problem, sends nothing, or needs an earlier change. */
	dryRun: DryRun | null;
};

export type Preview = {
	items: PreviewItem[];
	/** True when no change has a problem and Porkbun would accept every change it could check. */
	wouldSucceed: boolean;
	/** Porkbun's advisory warnings, each once. */
	warnings: string[];
	/** When the zone the plan was made against was read. */
	fetchedAt: number;
	/** Whether applying needs the domain name typed (more than one delete). */
	confirm: boolean;
};

export type BatchItemStatus =
	/** Sent and accepted. */
	| 'applied'
	/** Nothing had to be sent: the record already was as asked. */
	| 'unchanged'
	/** A create that found the same record already there; its id was adopted. */
	| 'adopted'
	/** Sent and refused, or not answered. */
	| 'failed'
	/** Not sent, because an earlier change failed. */
	| 'not_applied';

export type BatchItem = {
	index: number;
	status: BatchItemStatus;
	op: RecordChange['op'];
	name: string;
	type: string;
	/** The record's id: the new one after a create. */
	id?: string;
	error?: ApiError;
	warnings: string[];
	auditId?: number;
};

/** `POST …/dns/batch`. `ok` is true only when nothing failed and nothing was left unapplied. */
export type BatchResult = {
	ok: boolean;
	items: BatchItem[];
	counts: Record<BatchItemStatus, number>;
	/** Porkbun's advisory warnings, each once. */
	warnings: string[];
};

/** Body of the 409 the preview, batch, edit and delete routes answer when the plan has problems. */
export type PlanRefusal = { message: string; code: 'PLAN_REFUSED'; items: PlannedChange[] };

/** Body of a 400 for a record that failed validation. */
export type InvalidRecord = { message: string; code: 'INVALID_RECORD'; fields: FieldError[]; index?: number };

/** A record read from a zone file, a JSON list or a scan, before it is known whether it can be imported. */
export type ImportCandidate = {
	/** 1-based line (zone file) or position (JSON, scan) it came from. */
	line: number;
	host: string;
	type: string;
	content: string;
	ttl?: number;
	prio?: number;
	/** Notes found in the source. Porkbun's import does not take notes; they are reported, not sent. */
	notes?: string;
};

export type ImportVerdict =
	/** Will be created. */
	| 'new'
	/** Same name, type and value is already in the zone. */
	| 'existing'
	/** Can not be created next to what is in the zone or earlier in the file. */
	| 'conflict'
	/** Not something an import carries: SOA, the domain's own NS records, a type Porkbun's DNS does not have. */
	| 'ignored'
	/** Not a valid record. */
	| 'invalid';

export type ImportEntry = ImportCandidate & { verdict: ImportVerdict; reason?: string };

/** `POST …/dns/import`. With `dryRun` nothing was changed and `porkbun` is Porkbun's rehearsal. */
export type ImportReview = {
	dryRun: boolean;
	source: 'zone' | 'json' | 'records' | 'scan';
	entries: ImportEntry[];
	counts: Record<ImportVerdict, number>;
	/** Lines of the source that could not be read at all. */
	unreadable: { line: number; message: string }[];
	/** Porkbun's answer for the records sent in one import call. null when there was nothing to send. */
	porkbun: ImportResult | null;
	/** NS records below the apex are created one by one, because Porkbun's import skips every NS record. */
	delegations: BatchItem[];
	/** The failure of the import call, where there was one. */
	error?: ApiError;
	warnings: string[];
	/** True when the import (or its rehearsal) went through with nothing failed. */
	ok: boolean;
};
