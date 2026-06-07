import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type EvidenceSource = "slack" | "jira" | "confluence" | "repo" | "other";
export type Verdict = "supported" | "partial" | "refuted" | "unverifiable";
export type ClaimStatus = "confirmed" | "refuted" | "contested" | "unverifiable" | "pending";

export const EVIDENCE_SOURCES: EvidenceSource[] = ["slack", "jira", "confluence", "repo", "other"];
export const VERDICTS: Verdict[] = ["supported", "partial", "refuted", "unverifiable"];

export interface Claim {
	id: string;
	source: EvidenceSource;
	statement: string;
	citations: string[];
	/** Whether the orchestrator marked this as feeding a conclusion (verified first). */
	key?: boolean;
	reportFile?: string;
	createdBy?: string;
	createdAt: string;
}

export interface ClaimVerdict {
	claimId: string;
	verifier: string;
	verdict: Verdict;
	citation?: string;
	quote?: string;
	confidence?: string;
	createdAt: string;
}

export interface QuorumTally {
	total: number;
	/** `supported` verdicts that carry a re-fetched citation (count toward quorum). */
	groundedSupports: number;
	/** `supported` verdicts with no citation (do not count toward quorum). */
	ungroundedSupports: number;
	partials: number;
	refutes: number;
	unverifiables: number;
}

export interface ClaimEvaluation extends QuorumTally {
	claimId: string;
	status: ClaimStatus;
}

export function makeClaimId(index: number): string {
	return `c${index + 1}`;
}

async function appendJsonl(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonl<T>(file: string): Promise<T[]> {
	if (!existsSync(file)) return [];
	const text = await readFile(file, "utf8");
	const out: T[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// skip malformed lines rather than failing the whole ledger
		}
	}
	return out;
}

export function appendClaim(file: string, claim: Claim): Promise<void> {
	return appendJsonl(file, claim);
}

export function readClaims(file: string): Promise<Claim[]> {
	return readJsonl<Claim>(file);
}

export function appendVerdict(file: string, verdict: ClaimVerdict): Promise<void> {
	return appendJsonl(file, verdict);
}

export function readVerdicts(file: string): Promise<ClaimVerdict[]> {
	return readJsonl<ClaimVerdict>(file);
}

export function tallyVerdicts(verdicts: ClaimVerdict[]): QuorumTally {
	const tally: QuorumTally = { total: 0, groundedSupports: 0, ungroundedSupports: 0, partials: 0, refutes: 0, unverifiables: 0 };
	for (const verdict of verdicts) {
		tally.total++;
		switch (verdict.verdict) {
			case "supported":
				if (verdict.citation && verdict.citation.trim().length > 0) tally.groundedSupports++;
				else tally.ungroundedSupports++;
				break;
			case "partial":
				tally.partials++;
				break;
			case "refuted":
				tally.refutes++;
				break;
			case "unverifiable":
				tally.unverifiables++;
				break;
		}
	}
	return tally;
}

/**
 * Decide a claim's status from its verdict tally under a quorum of `quorum` independent verifiers.
 * Only grounded supports (verdict `supported` WITH a re-fetched citation) count toward confirmation.
 */
export function classifyClaim(tally: QuorumTally, quorum: number): ClaimStatus {
	const need = Math.max(1, Math.trunc(quorum));
	if (tally.groundedSupports >= need) return "confirmed";
	if (tally.refutes >= need) return "refuted";
	if (tally.total < need) return "pending";
	if (tally.groundedSupports === 0 && tally.refutes === 0) return "unverifiable";
	return "contested";
}

export function evaluateClaim(claimId: string, verdicts: ClaimVerdict[], quorum: number): ClaimEvaluation {
	const relevant = verdicts.filter((verdict) => verdict.claimId === claimId);
	const tally = tallyVerdicts(relevant);
	return { claimId, status: classifyClaim(tally, quorum), ...tally };
}

export interface InvestigationEvaluation {
	evaluations: ClaimEvaluation[];
	counts: Record<ClaimStatus, number>;
	/** Confirmed claims as a fraction of all claims (higher is better). */
	agreement: number;
}

export function evaluateAll(claims: Claim[], verdicts: ClaimVerdict[], quorum: number): InvestigationEvaluation {
	const counts: Record<ClaimStatus, number> = { confirmed: 0, refuted: 0, contested: 0, unverifiable: 0, pending: 0 };
	const evaluations = claims.map((claim) => {
		const evaluation = evaluateClaim(claim.id, verdicts, quorum);
		counts[evaluation.status]++;
		return evaluation;
	});
	const agreement = claims.length === 0 ? 0 : counts.confirmed / claims.length;
	return { evaluations, counts, agreement };
}

const CLAIMS_BLOCK = /<claims>\s*([\s\S]*?)\s*<\/claims>/i;

export interface ParsedClaim {
	statement: string;
	citations: string[];
	confidence?: string;
}

/**
 * Parse the machine-readable `<claims>` block a specialist appends to its report. Each line is a
 * JSON object `{ statement, citations[], confidence? }`. Malformed lines are skipped.
 */
export function parseClaimsBlock(reportText: string): ParsedClaim[] {
	const match = CLAIMS_BLOCK.exec(reportText);
	if (!match) return [];
	const body = match[1] ?? "";
	const out: ParsedClaim[] = [];
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<ParsedClaim>;
			if (typeof parsed.statement !== "string" || parsed.statement.trim().length === 0) continue;
			const citations = Array.isArray(parsed.citations) ? parsed.citations.filter((c): c is string => typeof c === "string") : [];
			out.push({ statement: parsed.statement.trim(), citations, confidence: typeof parsed.confidence === "string" ? parsed.confidence : undefined });
		} catch {
			// skip malformed claim line
		}
	}
	return out;
}

const VERDICT_BLOCK = /<verdict>\s*([\s\S]*?)\s*<\/verdict>/i;

export interface ParsedVerdict {
	verdict: Verdict;
	citation?: string;
	quote?: string;
	confidence?: string;
}

/** Parse the `<verdict>` JSON block a verifier subagent appends to its answer. */
export function parseVerdictBlock(text: string): ParsedVerdict | undefined {
	const match = VERDICT_BLOCK.exec(text);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse((match[1] ?? "").trim()) as Partial<ParsedVerdict>;
		if (typeof parsed.verdict !== "string" || !VERDICTS.includes(parsed.verdict as Verdict)) return undefined;
		return {
			verdict: parsed.verdict as Verdict,
			citation: typeof parsed.citation === "string" ? parsed.citation : undefined,
			quote: typeof parsed.quote === "string" ? parsed.quote : undefined,
			confidence: typeof parsed.confidence === "string" ? parsed.confidence : undefined,
		};
	} catch {
		return undefined;
	}
}
