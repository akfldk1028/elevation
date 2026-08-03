import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REQUIRED_BRIEF_FIELDS = ["summary_ko", "materials", "window_rhythm", "ground_floor", "roof", "negative_constraints"];

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
	}
	return value;
}

export function stableJson(value) {
	return JSON.stringify(stable(value));
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function flattenArtifacts(manifest) {
	const result = [];
	for (const [name, item] of Object.entries(manifest.artifacts ?? {})) {
		if (name === "views") {
			for (const [view, entry] of Object.entries(item.paths ?? {})) result.push({ name: `view_${view}`, ...entry });
		} else {
			result.push({ name, ...item });
		}
	}
	return result;
}

export async function loadCandidatePackage(datasetRoot, candidateId) {
	const root = resolve(datasetRoot);
	const candidateRoot = join(root, "candidates", candidateId);
	const massRoot = join(candidateRoot, "mass");
	await access(candidateRoot);
	const [candidate, manifest, mesh, cameras, floorGuides, facadePlanes, normals] = await Promise.all([
		readJson(join(candidateRoot, "candidate.json")),
		readJson(join(massRoot, "manifest.json")),
		readJson(join(massRoot, "mesh", "indexed-mesh.json")),
		readJson(join(massRoot, "elevation-research", "camera-poses.json")),
		readJson(join(massRoot, "elevation-research", "floor-guides.json")),
		readJson(join(massRoot, "elevation-research", "facade-planes.json")),
		readJson(join(massRoot, "elevation-research", "surface-normals.json")),
	]);
	const artifacts = flattenArtifacts(manifest);
	for (const artifact of artifacts) {
		const path = join(massRoot, artifact.path);
		let bytes;
		try { bytes = await readFile(path); } catch { throw new Error(`Missing manifest artifact: ${artifact.path}`); }
		const actual = sha256(bytes);
		if (actual !== String(artifact.sha256).toLowerCase()) throw new Error(`SHA-256 mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`);
		artifact.absolute_path = path;
	}
	if (manifest.identity?.candidate_id !== candidateId || mesh.identity?.geometry_hash !== manifest.identity?.geometry_hash) {
		throw new Error("Candidate identity mismatch between manifest and mesh");
	}
	return { dataset_root: root, candidate_root: candidateRoot, mass_root: massRoot, candidate, identity: manifest.identity, manifest, mesh, cameras, floor_guides: floorGuides, facade_planes: facadePlanes, surface_normals: normals, artifacts };
}

function validateBrief(brief) {
	if (!brief || typeof brief !== "object") throw new Error("facade_brief is required");
	for (const field of REQUIRED_BRIEF_FIELDS) if (brief[field] === undefined || brief[field] === "") throw new Error(`facade_brief.${field} is required`);
}

function makePrompts(brief) {
	const materialText = brief.materials.join(", ");
	return {
		hunyuan_zh: `现代建筑外立面，${materialText}，${brief.window_rhythm}，${brief.ground_floor}，${brief.roof}，保持原几何和层数不变`.slice(0, 200),
		wan_en: [brief.summary_ko, `Materials: ${materialText}.`, `Windows: ${brief.window_rhythm}.`, `Ground floor: ${brief.ground_floor}.`, `Roof: ${brief.roof}.`, `Generate exactly five orthographic views of the same building in this order: front, right, back, left, top. Preserve the supplied silhouette, storey count and camera framing.`, `Do not: ${brief.negative_constraints.join(", ")}. No text, labels, people, trees, cars, sky replacement or perspective camera.`].join(" "),
	};
}

export async function prepareRun({ datasetRoot, candidateId = "creative-004", facadeBrief, outputRoot = "results", runId }) {
	validateBrief(facadeBrief);
	const input = await loadCandidatePackage(datasetRoot, candidateId);
	const run_id = runId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	const run_dir = resolve(outputRoot, candidateId, run_id);
	const prompts = makePrompts(facadeBrief);
	const approvalPayload = {
		schema_version: "arr.elevation3d.run.v1",
		run_id,
		dataset_root: input.dataset_root,
		source_obj: join(input.mass_root, "mesh", "mass.obj"),
		source_views: Object.fromEntries(Object.entries(input.cameras.views).map(([name, view]) => [name, join(input.mass_root, view.path)])),
		candidate_id: candidateId,
		identity: input.identity,
		artifact_hashes: Object.fromEntries(input.artifacts.map((item) => [item.path, item.sha256])),
		facade_brief: facadeBrief,
		prompts,
		providers: {
			hunyuan: { model: "3.1", api_version: "2025-05-13", region: "ap-guangzhou", texture_size: 2048, enable_pbr: true, enable_keep_uv: false, estimated_cost_cny: 3.6 },
			wan: { model: "wan2.7-image-pro", region: "cn-beijing", size: "2K", n: 5, enable_sequential: true, watermark: false, estimated_cost_cny: 2.5 },
		},
		estimated_cost_cny: 6.1,
	};
	const approval_id = sha256(stableJson(approvalPayload)).slice(0, 16);
	const plan = { ...approvalPayload, plan_id: sha256(stableJson(approvalPayload)), approval_id, run_dir, state: "prepared" };
	await mkdir(run_dir, { recursive: true });
	await writeFile(join(run_dir, "plan.json"), JSON.stringify(plan, null, 2));
	await writeFile(join(run_dir, "state.json"), JSON.stringify({ schema_version: plan.schema_version, run_id, state: "prepared", strategies: { hunyuan: "prepared", wan_projection: "prepared" } }, null, 2));
	return plan;
}

export function assertExecutionApproved(plan, { approvalId, confirmLive, approvedMaxCostCny }) {
	if (confirmLive !== true) throw new Error("Live execution requires confirm_live=true");
	if (approvalId !== plan.approval_id) throw new Error("Approval ID does not match the immutable plan");
	if (!Number.isFinite(approvedMaxCostCny) || approvedMaxCostCny < plan.estimated_cost_cny) throw new Error(`Approved cost cap must be at least ${plan.estimated_cost_cny} CNY`);
}

export function redactSecrets(value) {
	if (Array.isArray(value)) return value.map(redactSecrets);
	if (!value || typeof value !== "object") return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (/(secret|api[_-]?key|authorization|token)/i.test(key)) out[key] = "[REDACTED]";
		else if (typeof item === "string" && /^data:image\/[^;]+;base64,/i.test(item)) {
			out[key] = "[REDACTED_BASE64_IMAGE]";
		} else if (typeof item === "string" && /^https?:\/\//i.test(item)) {
			const url = new URL(item); url.search = ""; url.hash = ""; out[key] = url.toString().replace(/\/$/, item.endsWith("/") ? "/" : "");
		} else out[key] = redactSecrets(item);
	}
	return out;
}
