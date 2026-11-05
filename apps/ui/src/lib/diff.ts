/** Line diff for showing revisions. LCS over the lines between the common prefix and suffix. */

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number };
export type DiffHunk = { lines: DiffLine[]; skippedBefore: number };

function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	return lines;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const n = midA.length;
	const m = midB.length;
	// lcs[i][j] = LCS length of midA[i..] and midB[j..], in one flat array.
	const lcs = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * (m + 1) + j] =
				midA[i] === midB[j]
					? (lcs[(i + 1) * (m + 1) + j + 1] as number) + 1
					: Math.max(lcs[(i + 1) * (m + 1) + j] as number, lcs[i * (m + 1) + j + 1] as number);
		}
	}
	const out: DiffLine[] = [];
	for (let k = 0; k < start; k++)
		out.push({ kind: 'same', text: a[k] as string, oldLine: k + 1, newLine: k + 1 });
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && midA[i] === midB[j]) {
			out.push({ kind: 'same', text: midA[i] as string, oldLine: start + i + 1, newLine: start + j + 1 });
			i++;
			j++;
		} else if (
			j < m &&
			(i >= n || (lcs[i * (m + 1) + j + 1] as number) > (lcs[(i + 1) * (m + 1) + j] as number))
		) {
			out.push({ kind: 'add', text: midB[j] as string, newLine: start + j + 1 });
			j++;
		} else {
			out.push({ kind: 'del', text: midA[i] as string, oldLine: start + i + 1 });
			i++;
		}
	}
	for (let k = 0; k < a.length - endA; k++) {
		out.push({ kind: 'same', text: a[endA + k] as string, oldLine: endA + k + 1, newLine: endB + k + 1 });
	}
	return out;
}

/** Changed lines with `context` unchanged lines around them; long unchanged runs are folded. */
export function hunks(lines: DiffLine[], context = 3): DiffHunk[] {
	const keep = lines.map(() => false);
	lines.forEach((l, idx) => {
		if (l.kind === 'same') return;
		for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++)
			keep[k] = true;
	});
	const out: DiffHunk[] = [];
	let skipped = 0;
	let current: DiffHunk | null = null;
	lines.forEach((l, idx) => {
		if (!keep[idx]) {
			skipped++;
			current = null;
			return;
		}
		if (!current) {
			current = { lines: [], skippedBefore: skipped };
			out.push(current);
			skipped = 0;
		}
		current.lines.push(l);
	});
	return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of lines) {
		if (l.kind === 'add') added++;
		else if (l.kind === 'del') removed++;
	}
	return { added, removed };
}
