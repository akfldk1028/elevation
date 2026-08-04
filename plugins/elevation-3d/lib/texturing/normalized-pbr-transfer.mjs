import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { TexturingError } from "./contract.mjs";
import { canonicalSurfaceSignature, compareCanonicalSurfaces } from "./geometry-signature.mjs";
import { isProtectedGlassMaterial } from "./material-validator.mjs";

function primitiveIndices(primitive, count) {
	const indices = primitive.getIndices();
	return indices
		? Array.from({ length: indices.getCount() }, (_, index) => indices.getScalar(index))
		: Array.from({ length: count }, (_, index) => index);
}

function meshBounds(mesh) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const primitive of mesh.listPrimitives()) {
		const position = primitive.getAttribute("POSITION");
		if (!position) continue;
		for (let index = 0; index < position.getCount(); index += 1) {
			const point = position.getElement(index, [0, 0, 0]);
			for (let axis = 0; axis < 3; axis += 1) {
				min[axis] = Math.min(min[axis], point[axis]);
				max[axis] = Math.max(max[axis], point[axis]);
			}
		}
	}
	if (min.some((value) => !Number.isFinite(value))) throw new TexturingError("TRANSFER_MESH_EMPTY", `Mesh ${mesh.getName()} has no positions`);
	return { min, max, center: min.map((value, axis) => (value + max[axis]) / 2), size: min.map((value, axis) => max[axis] - value) };
}

function deriveNormalization(authoritativeMesh, providerMesh, tolerance = 0.0001) {
	const authoritative = meshBounds(authoritativeMesh);
	const provider = meshBounds(providerMesh);
	const axisScales = authoritative.size.map((size, axis) => size / provider.size[axis]);
	const uniformScale = axisScales.reduce((sum, value) => sum + value, 0) / axisScales.length;
	const maximumRelativeDeviation = Math.max(...axisScales.map((value) => Math.abs(value - uniformScale) / uniformScale));
	const reasons = [];
	if (!axisScales.every((value) => Number.isFinite(value) && value > 0)) reasons.push("NORMALIZATION_SCALE_INVALID");
	if (maximumRelativeDeviation > tolerance) reasons.push("NORMALIZATION_NON_UNIFORM_SCALE");
	return {
		accepted: reasons.length === 0,
		reasons,
		uniformScale,
		axisScales,
		maximumRelativeDeviation,
		authoritativeCenter: authoritative.center,
		providerCenter: provider.center,
	};
}

function denormalize(point, normalization) {
	return point.map((value, axis) =>
		(value - normalization.providerCenter[axis]) * normalization.uniformScale + normalization.authoritativeCenter[axis]);
}

function meshSurfaceSignature(mesh, transform = (point) => point) {
	const vertices = [];
	const triangles = [];
	for (const primitive of mesh.listPrimitives()) {
		const position = primitive.getAttribute("POSITION");
		if (!position) continue;
		const offset = vertices.length;
		for (let index = 0; index < position.getCount(); index += 1) {
			vertices.push(transform(position.getElement(index, [0, 0, 0])));
		}
		const indices = primitiveIndices(primitive, position.getCount());
		for (let index = 0; index + 2 < indices.length; index += 3) {
			triangles.push(indices.slice(index, index + 3).map((value) => value + offset));
		}
	}
	return canonicalSurfaceSignature({ vertices, triangles });
}

function pointKey(point, quantizationMeters) {
	return point.map((value) => Math.round(value / quantizationMeters)).join(",");
}

function triangleKey(points, quantizationMeters) {
	return points.map((point) => pointKey(point, quantizationMeters)).sort().join("|");
}

function triangleArea(a, b, c) {
	const ab = b.map((value, axis) => value - a[axis]);
	const ac = c.map((value, axis) => value - a[axis]);
	return Math.hypot(
		ab[1] * ac[2] - ab[2] * ac[1],
		ab[2] * ac[0] - ab[0] * ac[2],
		ab[0] * ac[1] - ab[1] * ac[0],
	) / 2;
}

function vectorSubtract(a, b) {
	return a.map((value, axis) => value - b[axis]);
}

function vectorCross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function vectorDot(a, b) {
	return a.reduce((sum, value, axis) => sum + value * b[axis], 0);
}

function normalized(value) {
	const length = Math.hypot(...value);
	return length > 0 ? value.map((component) => component / length) : [0, 0, 0];
}

function barycentric(point, triangle) {
	const [a, b, c] = triangle;
	const v0 = vectorSubtract(b, a);
	const v1 = vectorSubtract(c, a);
	const v2 = vectorSubtract(point, a);
	const d00 = vectorDot(v0, v0);
	const d01 = vectorDot(v0, v1);
	const d11 = vectorDot(v1, v1);
	const d20 = vectorDot(v2, v0);
	const d21 = vectorDot(v2, v1);
	const denominator = d00 * d11 - d01 * d01;
	if (Math.abs(denominator) < 1e-16) return null;
	const v = (d11 * d20 - d01 * d21) / denominator;
	const w = (d00 * d21 - d01 * d20) / denominator;
	return [1 - v - w, v, w];
}

function interpolate(values, weights) {
	return values[0].map((_, axis) => weights.reduce((sum, weight, index) => sum + weight * values[index][axis], 0));
}

function createProviderTriangleIndex(mesh, normalization, quantizationMeters) {
	const byKey = new Map();
	const triangles = [];
	for (const primitive of mesh.listPrimitives()) {
		const position = primitive.getAttribute("POSITION");
		const uv = primitive.getAttribute("TEXCOORD_0");
		if (!position || !uv) continue;
		const indices = primitiveIndices(primitive, position.getCount());
		for (let index = 0; index + 2 < indices.length; index += 3) {
			const corners = indices.slice(index, index + 3);
			const points = corners.map((value) => denormalize(position.getElement(value, [0, 0, 0]), normalization));
			const record = {
				points,
				uvs: corners.map((value) => uv.getElement(value, [0, 0])),
				normal: normalized(vectorCross(vectorSubtract(points[1], points[0]), vectorSubtract(points[2], points[0]))),
			};
			const key = triangleKey(points, quantizationMeters);
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push(record);
			triangles.push(record);
		}
	}
	return { byKey, triangles };
}

function matchingProviderTriangle(points, providerIndex, quantizationMeters) {
	const exact = providerIndex.byKey.get(triangleKey(points, quantizationMeters));
	if (exact?.length) return { matched: true, mode: "exact", record: exact[0], candidates: [] };
	const centroid = points[0].map((_, axis) => points.reduce((sum, point) => sum + point[axis], 0) / 3);
	const normal = normalized(vectorCross(vectorSubtract(points[1], points[0]), vectorSubtract(points[2], points[0])));
	const candidates = [];
	for (const record of providerIndex.triangles) {
		if (vectorDot(normal, record.normal) < 0.99999) continue;
		if (Math.abs(vectorDot(vectorSubtract(centroid, record.points[0]), record.normal)) > quantizationMeters) continue;
		const weights = barycentric(centroid, record.points);
		if (!weights || weights.some((weight) => weight < -1e-6 || weight > 1 + 1e-6)) continue;
		candidates.push({ record, centroidUv: interpolate(record.uvs, weights) });
	}
	if (candidates.length === 0) return { matched: false, mode: "missing", record: null, candidates: [] };
	const uvKeys = new Set(candidates.map(({ centroidUv }) => centroidUv.map((value) => Math.round(value * 100_000)).join(",")));
	if (uvKeys.size !== 1) return { matched: false, mode: "ambiguous", record: null, candidates };
	return { matched: true, mode: "coplanar", record: candidates[0].record, candidates: [] };
}

function analyzeTransferMesh(mesh, providerIndex, quantizationMeters) {
	const materials = {};
	const matchModes = { exact: 0, coplanar: 0, contextual: 0, missing: 0, ambiguous: 0 };
	let totalArea = 0;
	let matchedArea = 0;
	let totalPrimitives = 0;
	let matchedPrimitives = 0;
	for (const primitive of mesh.listPrimitives()) {
		const material = primitive.getMaterial();
		if (!material || isProtectedGlassMaterial(material)) continue;
		const name = material.getName() || "unnamed";
		materials[name] ??= { totalArea: 0, matchedArea: 0, totalPrimitives: 0, matchedPrimitives: 0, areaCoverage: 0 };
		const position = primitive.getAttribute("POSITION");
		if (!position) continue;
		const indices = primitiveIndices(primitive, position.getCount());
		let primitiveArea = 0;
		const matches = [];
		for (let index = 0; index + 2 < indices.length; index += 3) {
			const points = indices.slice(index, index + 3).map((value) => position.getElement(value, [0, 0, 0]));
			primitiveArea += triangleArea(...points);
			matches.push(matchingProviderTriangle(points, providerIndex, quantizationMeters));
		}
		const anchorUvs = matches.filter((match) => match.matched).flatMap((match) => match.record.uvs);
		for (const match of matches.filter((candidate) => candidate.mode === "ambiguous")) {
			if (anchorUvs.length === 0) continue;
			const scored = match.candidates.map((candidate) => ({
				...candidate,
				score: Math.min(...anchorUvs.map((uv) => Math.hypot(uv[0] - candidate.centroidUv[0], uv[1] - candidate.centroidUv[1]))),
			})).sort((a, b) => a.score - b.score);
			if (scored.length > 1 && scored[1].score - scored[0].score <= 1e-6) continue;
			match.matched = true;
			match.mode = "contextual";
			match.record = scored[0].record;
		}
		const complete = matches.every((match) => match.matched);
		for (const match of matches) matchModes[match.mode] += 1;
		totalArea += primitiveArea;
		totalPrimitives += 1;
		materials[name].totalArea += primitiveArea;
		materials[name].totalPrimitives += 1;
		if (complete) {
			matchedArea += primitiveArea;
			matchedPrimitives += 1;
			materials[name].matchedArea += primitiveArea;
			materials[name].matchedPrimitives += 1;
		}
	}
	for (const report of Object.values(materials)) report.areaCoverage = report.totalArea > 0 ? report.matchedArea / report.totalArea : 0;
	const reasons = [];
	const areaCoverage = totalArea > 0 ? matchedArea / totalArea : 0;
	if (areaCoverage < 0.97) reasons.push("PBR_TRANSFER_COVERAGE_REVIEW");
	if (Object.values(materials).some((report) => report.areaCoverage < 0.95)) reasons.push("PBR_MATERIAL_COVERAGE_REVIEW");
	return {
		totalArea,
		matchedArea,
		areaCoverage,
		totalPrimitives,
		matchedPrimitives,
		materials,
		matchModes,
		status: reasons.length === 0 ? "accepted" : "review",
		reasons,
	};
}

function namedMesh(document, name) {
	const mesh = document.getRoot().listMeshes().find((candidate) => candidate.getName() === name);
	if (!mesh) throw new TexturingError("TRANSFER_MESH_MISSING", `Required mesh ${name} is missing`);
	return mesh;
}

export async function analyzeNormalizedPbrTransfer({
	authoritativeGlb,
	providerGlb,
	anchorMeshName = "exact-mass",
	transferMeshName = "facade-details",
	quantizationMeters = 0.0001,
} = {}) {
	const io = new NodeIO();
	const [authoritative, provider] = await Promise.all([
		io.read(resolve(authoritativeGlb)),
		io.read(resolve(providerGlb)),
	]);
	const authoritativeAnchor = namedMesh(authoritative, anchorMeshName);
	const providerAnchor = namedMesh(provider, anchorMeshName);
	const normalization = deriveNormalization(authoritativeAnchor, providerAnchor);
	const authoritativeAnchorSignature = meshSurfaceSignature(authoritativeAnchor);
	const providerAnchorSignature = meshSurfaceSignature(providerAnchor, (point) => denormalize(point, normalization));
	const anchorSurface = compareCanonicalSurfaces(authoritativeAnchorSignature, providerAnchorSignature);
	const providerIndex = createProviderTriangleIndex(namedMesh(provider, transferMeshName), normalization, quantizationMeters);
	const transfer = analyzeTransferMesh(namedMesh(authoritative, transferMeshName), providerIndex, quantizationMeters);
	return {
		accepted: normalization.accepted && anchorSurface.accepted,
		normalization,
		anchorSurface: { ...anchorSurface, authoritative: authoritativeAnchorSignature, provider: providerAnchorSignature },
		transfer,
		quantizationMeters,
	};
}
