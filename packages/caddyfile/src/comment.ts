import { parse } from './parser.js';
import { printBlockText } from './printer.js';
import type { Block, Caddyfile, Diagnostic, Trivia } from './types.js';

/**
 * "Disable a site" per DECISIONS.md: turn a block into comment lines in place,
 * one `#` per line, keeping its text exactly so that {@link uncommentTrivia}
 * restores it byte for byte. Returns the trivia lines that replaced the block;
 * they are attached to the following block (or the file's trailing trivia).
 */
export function commentOutBlock(file: Caddyfile, block: Block): Trivia[] {
	const i = file.blocks.indexOf(block);
	if (i < 0) throw new Error('block is not in this file');
	const text = printBlockText(block, { newline: file.newline, indentUnit: file.indentUnit });
	const newline = file.newline ?? '\n';
	const own: Trivia[] = [];
	// The block's own leading trivia stays as it is; only the block lines get a '#'.
	const bodyText = stripLeadingTrivia(text, block);
	const lines = bodyText.split(/\r?\n/);
	if (lines[lines.length - 1] === '') lines.pop();
	for (const line of lines) {
		own.push({ kind: 'comment', text: '#' + line, newline });
	}
	const replaced = [...block.trivia, ...own];
	file.blocks.splice(i, 1);
	const next = file.blocks[i];
	if (next) next.trivia = [...replaced, ...next.trivia];
	else file.trivia = [...replaced, ...file.trivia];
	return own;
}

function stripLeadingTrivia(text: string, block: Block): string {
	let n = 0;
	for (const t of block.trivia)
		n += (t.indent ?? '').length + (t.kind === 'comment' ? t.text.length : 0) + (t.newline ?? '\n').length;
	return text.slice(n);
}

export interface UncommentResult {
	blocks: Block[];
	diagnostics: Diagnostic[];
}

/**
 * Parse a run of comment lines as Caddyfile text with the first `#` of each
 * line removed (and one following space, when every line has it). Use it to
 * re-enable a block disabled with {@link commentOutBlock}, or to preview what
 * a commented-out region would mean.
 */
export function uncommentTrivia(trivia: readonly Trivia[], newline = '\n'): UncommentResult {
	const lines = trivia.map((t) => (t.kind === 'comment' ? t.text.replace(/^#/, '') : ''));
	const allSpaced = lines.every((l) => l === '' || l.startsWith(' ') || l.startsWith('\t'));
	const text = (allSpaced ? lines.map((l) => l.slice(1)) : lines).join(newline) + newline;
	const res = parse(text);
	return { blocks: res.file.blocks, diagnostics: res.diagnostics };
}
