import { readFile, realpath, stat } from "node:fs/promises";
import { sha256, stableJson } from "../core.mjs";

const FORMULA_VERSION = "arr.elevation3d.facade-score.v1";
const WEIGHTS = Object.freeze({ implementability: 0.35, multiview: 0.35, grammar: 0.20, visual: 0.10 });
const REPORT_NAMES = Object.freeze(["proposalReport", "grammarReport", "validationReport", "renderReport"]);
const SOURCE_NAMES = Object.freeze(["glb", "evidence", "cameras", "proposal"]);
const REPORT_SCHEMAS = Object.freeze({
	proposalReport: "arr.elevation3d.facade-proposal-report.v1",
	grammarReport: "arr.elevation3d.facade-grammar-report.v1",
	validationReport: "arr.elevation3d.facade-validation-report.v1",
	renderReport: "arr.elevation3d.facade-render-report.v1",
});
const MAX_BYTES = Object.freeze({ glb: 16 * 1024 * 1024, proposal: 32 * 1024 * 1024, evidence: 1024 * 1024, cameras: 1024 * 1024, report: 1024 * 1024 });
const SCORE_RESULTS = new WeakSet();

function rejected(provider, reason) {
	return Object.freeze({ status: "rejected", accepted: false, provider: typeof provider === "string" ? provider : "invalid-provider", reason, formula_version: FORMULA_VERSION });
}

function finiteNonnegative(value) {
	return Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
}

function finiteScore(value) {
	return finiteNonnegative(value) && value <= 100;
}

function unitInterval(value) {
	return finiteNonnegative(value) && value <= 1;
}

function roundedScore(value) {
	return Math.round((value + Number.EPSILON) * 10) / 10;
}

function compareProvider(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}

function descriptor(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		&& typeof value.path === "string" && /^[a-f0-9]{64}$/.test(value.sha256 ?? "") ? value : null;
}

async function verifiedBytes(name, value, maximum) {
	const item = descriptor(value);
	if (!item) throw new Error("ARTIFACT_DESCRIPTOR_INVALID");
	const path = await realpath(item.path);
	const metadata = await stat(path);
	if (!metadata.isFile() || metadata.size > maximum) throw new Error("ARTIFACT_BUDGET_EXCEEDED");
	const bytes = await readFile(path);
	if (bytes.length > maximum) throw new Error("ARTIFACT_BUDGET_EXCEEDED");
	if (sha256(bytes) !== item.sha256) throw new Error("ARTIFACT_HASH_MISMATCH");
	return { name, sha256: item.sha256, bytes };
}

function parsedCanonicalReport(item) {
	let report;
	try { report = JSON.parse(item.bytes.toString("utf8")); }
	catch { throw new Error("REPORT_INVALID"); }
	if (!report || typeof report !== "object" || Array.isArray(report)
		|| item.bytes.toString("utf8") !== stableJson(report)) throw new Error("REPORT_NOT_CANONICAL");
	return report;
}

function exactBinding(report, binding) {
	return report.provider === binding.provider && report.candidate_id === binding.candidate_id
		&& report.glb_sha256 === binding.glb_sha256 && report.evidence_sha256 === binding.evidence_sha256
		&& report.cameras_sha256 === binding.cameras_sha256 && report.proposal_sha256 === binding.proposal_sha256
		&& report.grammar_sha256 === binding.grammar_sha256;
}

async function verifiedArtifactSet(provider, artifacts) {
	if (typeof provider !== "string" || !provider.trim() || !artifacts || typeof artifacts !== "object") throw new Error("PROVIDER_INVALID");
	const sources = {};
	for (const name of SOURCE_NAMES) sources[name] = await verifiedBytes(name, artifacts[name], MAX_BYTES[name]);
	const reports = {};
	const reportSha256s = {};
	for (const name of REPORT_NAMES) {
		const item = await verifiedBytes(name, artifacts[name], MAX_BYTES.report);
		reportSha256s[name] = item.sha256;
		reports[name] = parsedCanonicalReport(item);
		if (reports[name].schema_version !== REPORT_SCHEMAS[name]) throw new Error("REPORT_SCHEMA_INVALID");
	}
	const grammar = reports.grammarReport.grammar;
	const grammarSha256 = sha256(stableJson(grammar));
	const binding = {
		provider, candidate_id: reports.proposalReport.candidate_id,
		glb_sha256: sources.glb.sha256, evidence_sha256: sources.evidence.sha256,
		cameras_sha256: sources.cameras.sha256, proposal_sha256: sources.proposal.sha256, grammar_sha256: grammarSha256,
	};
	if (!Object.values(reports).every((report) => exactBinding(report, binding))) throw new Error("REPORT_BINDING_MISMATCH");
	if (reports.proposalReport.accepted !== true || reports.validationReport.accepted !== true
		|| !Array.isArray(reports.validationReport.codes) || reports.validationReport.codes.length !== 0) throw new Error("HARD_GATE_REJECTED");
	return { binding, reportSha256s, grammar, validation: reports.validationReport.metrics, render: reports.renderReport.visual_metrics };
}

function scoreComponents({ grammar, validation: metrics, render }) {
	if (!metrics || !unitInterval(metrics.canonical_surface_match) || !unitInterval(metrics.opaque_wall_coverage)
		|| !finiteNonnegative(metrics.minimum_reveal_depth_m) || !finiteNonnegative(metrics.corner_max_gap_m)
		|| !finiteNonnegative(metrics.floor_alignment_max_error_m) || !unitInterval(metrics.facade_orientation_coverage)) {
		throw new Error("VALIDATION_METRICS_INVALID");
	}
	if (grammar?.system !== "brick-punched-window-v1" || !finiteNonnegative(grammar.reveal_depth_m) || grammar.reveal_depth_m === 0
		|| !unitInterval(grammar.confidence)) throw new Error("GRAMMAR_METRICS_INVALID");
	if (!render || !finiteScore(render.score)) throw new Error("VISUAL_METRICS_INVALID");
	const implementability = 100 * (metrics.canonical_surface_match + metrics.opaque_wall_coverage
		+ Math.min(1, metrics.minimum_reveal_depth_m / grammar.reveal_depth_m)) / 3;
	const cornerQuality = Math.max(0, 1 - metrics.corner_max_gap_m / 0.00001);
	const floorQuality = Math.max(0, 1 - metrics.floor_alignment_max_error_m / 0.00001);
	return {
		implementability: roundedScore(implementability),
		multiview: roundedScore(100 * (metrics.facade_orientation_coverage + cornerQuality + floorQuality) / 3),
		grammar: roundedScore(grammar.confidence * 100), visual: roundedScore(render.score),
	};
}

export async function scoreFacadeCandidate({ provider, artifacts } = {}) {
	try {
		const verified = await verifiedArtifactSet(provider, artifacts);
		const components = scoreComponents(verified);
		const score = roundedScore(Object.entries(WEIGHTS).reduce((sum, [name, weight]) => sum + components[name] * weight, 0));
		if (!finiteScore(score)) throw new Error("SCORE_INVALID");
		const breakdown = {
			formula_version: FORMULA_VERSION,
			formula: "0.35*implementability + 0.35*multiview + 0.20*grammar + 0.10*visual",
			provider, candidate_id: verified.binding.candidate_id, bindings: verified.binding,
			report_sha256s: verified.reportSha256s, components, score,
		};
		const serialized = stableJson(breakdown);
		const result = deepFreeze({
			status: "scored", accepted: true, provider, score, components, formula_version: FORMULA_VERSION,
			breakdown, serialized, sha256: sha256(serialized),
		});
		SCORE_RESULTS.add(result);
		return result;
	} catch (error) {
		return rejected(provider, error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ARTIFACT_VERIFICATION_FAILED");
	}
}

export function selectFacadeWinner(candidates, tolerance = 0.5) {
	if (!Array.isArray(candidates) || !finiteNonnegative(tolerance)) return { status: "no-winner", candidates: [] };
	const scored = candidates.filter((candidate) => SCORE_RESULTS.has(candidate) && candidate.accepted === true)
		.sort((left, right) => right.score - left.score || compareProvider(left.provider, right.provider));
	if (!scored.length) return { status: "no-winner", candidates: [] };
	const review = scored.filter((candidate) => scored[0].score - candidate.score <= tolerance);
	if (review.length > 1) {
		if (review.every((candidate) => candidate.score === review[0].score)) review.sort((left, right) => compareProvider(left.provider, right.provider));
		return { status: "human-review", candidates: review, tolerance, formula_version: FORMULA_VERSION };
	}
	return { status: "winner", provider: scored[0].provider, score: scored[0].score, candidate: scored[0], formula_version: FORMULA_VERSION };
}
