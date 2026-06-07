import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	evaluateAll,
	readClaims,
	readVerdicts,
	type Claim,
	type ClaimStatus,
	type EvidenceSource,
	type InvestigationEvaluation,
} from "./claims.ts";
import { resolveMarathonDir } from "./mission.ts";

export interface InvestigationPaths {
	dir: string;
	brief: string;
	reportsDir: string;
	claims: string;
	verdicts: string;
	index: string;
	report: string;
	contested: string;
	readiness: string;
	runs: string;
}

export function investigationPaths(cwd: string, override?: string): InvestigationPaths {
	const dir = path.join(resolveMarathonDir(cwd, override), "investigation");
	return {
		dir,
		brief: path.join(dir, "brief.md"),
		reportsDir: path.join(dir, "reports"),
		claims: path.join(dir, "claims.jsonl"),
		verdicts: path.join(dir, "verdicts.jsonl"),
		index: path.join(dir, "index.md"),
		report: path.join(dir, "report.md"),
		contested: path.join(dir, "contested.md"),
		readiness: path.join(dir, "readiness.json"),
		runs: path.join(dir, "runs"),
	};
}

export function reportFileFor(paths: InvestigationPaths, source: EvidenceSource): string {
	return path.join(paths.reportsDir, `${source}.md`);
}

export async function ensureInvestigation(paths: InvestigationPaths): Promise<void> {
	await mkdir(paths.reportsDir, { recursive: true });
	await mkdir(paths.runs, { recursive: true });
}

export async function writeBrief(paths: InvestigationPaths, problem: string, subQuestions: string[]): Promise<void> {
	await ensureInvestigation(paths);
	const lines = [`# investigation brief`, "", `## Problem`, problem.trim(), "", `## Sub-questions`];
	if (subQuestions.length === 0) lines.push("- (none yet)");
	else subQuestions.forEach((question, index) => lines.push(`${index + 1}. ${question.trim()}`));
	lines.push("");
	await writeFile(paths.brief, lines.join("\n"), "utf8");
}

export interface CompileResult extends InvestigationEvaluation {
	totalClaims: number;
}

/** Build index.md, report.md, and contested.md from the claim/verdict ledgers. */
export async function compileReports(paths: InvestigationPaths, quorum: number): Promise<CompileResult> {
	const claims = await readClaims(paths.claims);
	const verdicts = await readVerdicts(paths.verdicts);
	const evaluation = evaluateAll(claims, verdicts, quorum);
	const byId = new Map(evaluation.evaluations.map((entry) => [entry.claimId, entry]));

	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.index, renderIndex(claims, evaluation, quorum), "utf8");
	await writeFile(paths.report, renderReport(claims, byId), "utf8");
	await writeFile(paths.contested, renderContested(claims, byId), "utf8");

	return { ...evaluation, totalClaims: claims.length };
}

function statusLine(counts: Record<ClaimStatus, number>): string {
	return `confirmed:${counts.confirmed} contested:${counts.contested} refuted:${counts.refuted} unverifiable:${counts.unverifiable} pending:${counts.pending}`;
}

function renderIndex(claims: Claim[], evaluation: InvestigationEvaluation, quorum: number): string {
	const bySource = new Map<EvidenceSource, number>();
	for (const claim of claims) bySource.set(claim.source, (bySource.get(claim.source) ?? 0) + 1);
	const lines = [
		`# investigation index`,
		"",
		`- quorum: ${quorum} independent verifiers`,
		`- agreement: ${(evaluation.agreement * 100).toFixed(0)}% (${evaluation.counts.confirmed}/${claims.length} claims confirmed)`,
		`- claim status: ${statusLine(evaluation.counts)}`,
		"",
		`## Reports`,
		...[...bySource.entries()].map(([source, count]) => `- reports/${source}.md — ${count} claim(s)`),
		"",
		`## Outputs`,
		`- report.md — confirmed findings with citations`,
		`- contested.md — contested / refuted / unverifiable claims`,
		"",
	];
	return lines.join("\n");
}

function renderClaim(claim: Claim, status: ClaimStatus): string {
	const cites = claim.citations.length > 0 ? claim.citations.map((c) => `    - ${c}`).join("\n") : "    - (no citation)";
	return `- [${status}] (${claim.source}) ${claim.statement}\n${cites}`;
}

function renderReport(claims: Claim[], byId: Map<string, { status: ClaimStatus }>): string {
	const confirmed = claims.filter((claim) => byId.get(claim.id)?.status === "confirmed");
	const lines = [`# investigation report`, "", `Confirmed findings (corroborated by an independent quorum against primary sources).`, ""];
	if (confirmed.length === 0) {
		lines.push("_No claims have reached quorum yet._");
	} else {
		const bySource = new Map<EvidenceSource, Claim[]>();
		for (const claim of confirmed) {
			const list = bySource.get(claim.source) ?? [];
			list.push(claim);
			bySource.set(claim.source, list);
		}
		for (const [source, list] of bySource) {
			lines.push(`## ${source}`);
			for (const claim of list) lines.push(renderClaim(claim, "confirmed"));
			lines.push("");
		}
	}
	return lines.join("\n");
}

function renderContested(claims: Claim[], byId: Map<string, { status: ClaimStatus }>): string {
	const flagged = claims.filter((claim) => {
		const status = byId.get(claim.id)?.status;
		return status === "contested" || status === "refuted" || status === "unverifiable" || status === "pending";
	});
	const lines = [`# contested & unverified claims`, "", `Claims that did not reach quorum. Review before relying on them.`, ""];
	if (flagged.length === 0) lines.push("_None._");
	else for (const claim of flagged) lines.push(renderClaim(claim, byId.get(claim.id)?.status ?? "pending"));
	return lines.join("\n");
}

export async function readBrief(paths: InvestigationPaths): Promise<string | undefined> {
	if (!existsSync(paths.brief)) return undefined;
	return readFile(paths.brief, "utf8");
}
