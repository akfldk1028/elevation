import sharp from "sharp";
import { COMPETITION_DAYLIGHT_STYLE_ID, renderStyleHash, resolvePbrRenderStyle } from "./render-style.mjs";

const REQUIRED_VIEWS = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const SHADOW_VIEWS = ["axon", "opposite-axon"];
const MATERIAL_SEPARATION_VIEWS = ["front", "back", "left", "right", "axon", "opposite-axon"];

function percentile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = values.toSorted((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}

function variance(values) {
	if (values.length === 0) return null;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function luminance(red, green, blue) {
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function evidenceNumber(value) {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function parseBackground(value) {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError("background must be a six-digit hex color");
	return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function normalizeBounds(bounds, width, height) {
	if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) {
		throw new TypeError("buildingBounds must contain finite minX, minY, maxX, and maxY values");
	}
	const result = {
		minX: Math.max(0, Math.floor(bounds.minX)), minY: Math.max(0, Math.floor(bounds.minY)),
		maxX: Math.min(width - 1, Math.ceil(bounds.maxX)), maxY: Math.min(height - 1, Math.ceil(bounds.maxY)),
	};
	if (result.minX > result.maxX || result.minY > result.maxY) throw new RangeError("buildingBounds do not overlap the PNG");
	return result;
}

function isInside(x, y, bounds) {
	return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

export async function analyzePresentationPng({ png, buildingBounds, background }) {
	const backgroundRgb = parseBackground(background);
	const decoded = await sharp(png)
		.flatten({ background: { r: backgroundRgb[0], g: backgroundRgb[1], b: backgroundRgb[2] } })
		.removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const { width, height } = decoded.info;
	const bounds = normalizeBounds(buildingBounds, width, height);
	const backgroundLuminance = luminance(...backgroundRgb);
	const buildingLuminance = [];
	const buildingChroma = [];
	const totalPixels = width * height;
	const foregroundMask = new Uint8Array(totalPixels);
	const shadowCandidateMask = new Uint8Array(totalPixels);
	const pixelLuminance = new Float64Array(totalPixels);
	const pixelDelta = new Float64Array(totalPixels);
	const pixelChroma = new Float64Array(totalPixels);
	const adjacency = Math.max(2, Math.ceil(Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1) * 0.35));

	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		const pixel = y * width + x;
		const offset = pixel * 3;
		const red = decoded.data[offset], green = decoded.data[offset + 1], blue = decoded.data[offset + 2];
		pixelLuminance[pixel] = luminance(red, green, blue);
		pixelDelta[pixel] = Math.hypot(red - backgroundRgb[0], green - backgroundRgb[1], blue - backgroundRgb[2]);
		pixelChroma[pixel] = Math.max(red, green, blue) - Math.min(red, green, blue);
		if (isInside(x, y, bounds) && pixelDelta[pixel] >= 4) {
			foregroundMask[pixel] = 1;
			buildingLuminance.push(pixelLuminance[pixel]);
			buildingChroma.push(pixelChroma[pixel]);
		}
		const darkening = backgroundLuminance - pixelLuminance[pixel];
		const adjacent = x >= bounds.minX - adjacency && x <= bounds.maxX + adjacency
			&& y >= bounds.minY - adjacency && y <= bounds.maxY + adjacency;
		if (!isInside(x, y, bounds) && adjacent && darkening >= 5 && darkening <= 90
			&& pixelDelta[pixel] >= 5 && pixelDelta[pixel] <= 120) shadowCandidateMask[pixel] = 1;
	}

	const neighborOffsets = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
	const seedPixels = [];
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		const pixel = y * width + x;
		if (!shadowCandidateMask[pixel]) continue;
		if (neighborOffsets.some(([dx, dy]) => {
			const nx = x + dx, ny = y + dy;
			return nx >= 0 && nx < width && ny >= 0 && ny < height && foregroundMask[ny * width + nx];
		})) seedPixels.push(pixel);
	}
	const connectedMask = new Uint8Array(totalPixels);
	const queue = [...seedPixels];
	for (const pixel of seedPixels) connectedMask[pixel] = 1;
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const pixel = queue[cursor], x = pixel % width, y = Math.floor(pixel / width);
		for (const [dx, dy] of neighborOffsets) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
			const neighbor = ny * width + nx;
			if (shadowCandidateMask[neighbor] && !connectedMask[neighbor]) {
				connectedMask[neighbor] = 1;
				queue.push(neighbor);
			}
		}
	}
	const shadowPixels = queue;
	const shadowLuminance = shadowPixels.map((pixel) => pixelLuminance[pixel]);
	const shadowChroma = shadowPixels.map((pixel) => pixelChroma[pixel]);
	const localDifferences = [];
	for (const pixel of shadowPixels) {
		const x = pixel % width, y = Math.floor(pixel / width);
		for (const [dx, dy] of [[1, 0], [0, 1]]) {
			const nx = x + dx, ny = y + dy;
			if (nx < width && ny < height && connectedMask[ny * width + nx]) {
				localDifferences.push(Math.abs(pixelLuminance[pixel] - pixelLuminance[ny * width + nx]));
			}
		}
	}
	const shadowAreaFraction = shadowPixels.length / (width * height);
	const shadowBuildingAreaFraction = buildingLuminance.length > 0 ? shadowPixels.length / buildingLuminance.length : Infinity;
	const imageMinimumPassed = shadowAreaFraction >= 0.002;
	const buildingMinimumPassed = shadowBuildingAreaFraction >= 0.01;
	const minimumCoverageRoute = imageMinimumPassed && buildingMinimumPassed ? "image-and-building"
		: imageMinimumPassed ? "image"
			: buildingMinimumPassed ? "building" : null;
	const shadowRange = shadowLuminance.length ? percentile(shadowLuminance, 0.95) - percentile(shadowLuminance, 0.05) : 0;
	const shadowChromaP95 = percentile(shadowChroma, 0.95);
	const localTextureP90 = percentile(localDifferences, 0.9) ?? 0;
	const contactShadowDetected = shadowPixels.length >= 4
		&& minimumCoverageRoute !== null && shadowAreaFraction <= 0.12
		&& shadowBuildingAreaFraction <= 0.5
		&& shadowRange >= 6
		&& shadowChromaP95 <= 12
		&& localTextureP90 <= 15;
	const backgroundDeltas = [];
	const backgroundLuminances = [];
	for (let pixel = 0; pixel < totalPixels; pixel += 1) if (!foregroundMask[pixel] && !connectedMask[pixel]) {
		backgroundDeltas.push(pixelDelta[pixel]);
		backgroundLuminances.push(pixelLuminance[pixel]);
	}

	return {
		image: { width, height },
		building: {
			sampleCount: buildingLuminance.length,
			luminanceP05: percentile(buildingLuminance, 0.05),
			luminanceP50: percentile(buildingLuminance, 0.5),
			luminanceP95: percentile(buildingLuminance, 0.95),
		},
		background: {
			sampleCount: backgroundDeltas.length,
			deltaP95: percentile(backgroundDeltas, 0.95),
			luminanceVariance: variance(backgroundLuminances),
		},
		contactShadow: {
			detected: contactShadowDetected,
			pixelCount: shadowPixels.length,
			areaFraction: shadowAreaFraction,
			buildingAreaFraction: shadowBuildingAreaFraction,
			minimumCoverageRoute,
			luminanceRange: shadowRange,
			chromaP95: shadowChromaP95,
			localTextureP90,
			connectedToForeground: seedPixels.length > 0,
			insideBuildingPixels: 0,
		},
		materialSeparation: {
			luminanceSpread: percentile(buildingLuminance, 0.9) - percentile(buildingLuminance, 0.1),
			chromaSpread: percentile(buildingChroma, 0.9) - percentile(buildingChroma, 0.1),
		},
	};
}

const SEMANTIC_ROLE_IDS = Object.freeze({
	concrete: [255, 0, 0], glass: [0, 255, 0], bronze: [0, 0, 255], opaque: [255, 255, 0],
});

export async function analyzeSemanticRolePng({ finalPng, roleMaskPng, geometry = {} }) {
	const [finalImage, maskImage] = await Promise.all([
		sharp(finalPng).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
		sharp(roleMaskPng).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
	]);
	if (finalImage.info.width !== maskImage.info.width || finalImage.info.height !== maskImage.info.height) {
		throw new RangeError("semantic role mask dimensions must match the final PNG");
	}
	const accumulators = Object.fromEntries(Object.keys(SEMANTIC_ROLE_IDS).map((role) => [role, { pixelCount: 0, sums: [0, 0, 0] }]));
	for (let offset = 0; offset < maskImage.data.length; offset += 3) {
		let matched = null, closest = Infinity;
		for (const [role, id] of Object.entries(SEMANTIC_ROLE_IDS)) {
			const distance = Math.hypot(maskImage.data[offset] - id[0], maskImage.data[offset + 1] - id[1], maskImage.data[offset + 2] - id[2]);
			if (distance < closest) { matched = role; closest = distance; }
		}
		if (closest > 24) continue;
		const record = accumulators[matched];
		record.pixelCount++;
		for (let channel = 0; channel < 3; channel++) record.sums[channel] += finalImage.data[offset + channel];
	}
	const totalRolePixels = Object.values(accumulators).reduce((sum, record) => sum + record.pixelCount, 0);
	const roles = Object.fromEntries(Object.entries(accumulators).sort(([left], [right]) => left.localeCompare(right)).map(([role, record]) => {
		const meanColor = record.pixelCount ? record.sums.map((sum) => Math.round(sum / record.pixelCount * 1e6) / 1e6) : [0, 0, 0];
		const geometryTriangles = geometry?.[role]?.triangleCount ?? null;
		return [role, {
			pixelCount: record.pixelCount,
			coverageFraction: totalRolePixels ? evidenceNumber(record.pixelCount / totalRolePixels) : 0,
			meanColor, meanLuminance: evidenceNumber(luminance(...meanColor)),
			visibility: {
				status: record.pixelCount > 0 ? "visible" : "not_visible",
				reason: record.pixelCount > 0 ? "authoritative_role_mask_fragments" : "no_authoritative_role_mask_fragments_survived_depth_and_clipping",
				geometryTriangles,
			},
		}];
	}));
	const pairwise = {};
	const roleOrder = Object.keys(SEMANTIC_ROLE_IDS);
	for (let left = 0; left < roleOrder.length; left++) for (let right = left + 1; right < roleOrder.length; right++) {
		const leftRole = roleOrder[left], rightRole = roleOrder[right];
		pairwise[`${leftRole}:${rightRole}`] = {
			colorDistance: evidenceNumber(Math.hypot(...roles[leftRole].meanColor.map((value, index) => value - roles[rightRole].meanColor[index]))),
			luminanceDistance: evidenceNumber(Math.abs(roles[leftRole].meanLuminance - roles[rightRole].meanLuminance)),
		};
	}
	return { roles, pairwise };
}

export function validateSemanticRoleEvidence({ views }) {
	const codes = [];
	const requiredViews = ["front", "back", "left", "right", "axon", "opposite-axon"];
	const requiredRoles = ["concrete", "glass", "bronze"];
	const minimumPixels = 4, minimumCoverageFraction = 0.0005;
	if (requiredViews.some((name) => requiredRoles.some((role) => {
		const record = views?.[name]?.roles?.[role];
		return !(record?.pixelCount >= minimumPixels) || !(record?.coverageFraction == null || record.coverageFraction >= minimumCoverageFraction);
	}))) {
		codes.push("PBR_SEMANTIC_ROLE_MISSING");
	}
	for (const name of [...requiredViews, "plan", "top"]) {
		const evidence = views?.[name];
		if (!evidence) { codes.push("PBR_SEMANTIC_ROLE_MISSING"); continue; }
		const visible = Object.entries(evidence.roles ?? {}).filter(([, record]) => record.pixelCount >= 4).map(([role]) => role);
		for (let left = 0; left < visible.length; left++) for (let right = left + 1; right < visible.length; right++) {
			const direct = `${visible[left]}:${visible[right]}`, reverse = `${visible[right]}:${visible[left]}`;
			const separation = evidence.pairwise?.[direct] ?? evidence.pairwise?.[reverse];
			if (!separation || !(separation.colorDistance >= 5)) codes.push("PBR_SEMANTIC_ROLE_COLLAPSED");
		}
	}
	return { accepted: codes.length === 0, codes: [...new Set(codes)], thresholds: { minimumPixels, minimumCoverageFraction, minimumColorDistance: 5 }, requiredRoles };
}

function semanticMaterialScore(view) {
	const distances = ["concrete:glass", "concrete:bronze", "glass:bronze"].map((pair) => view?.pairwise?.[pair]?.colorDistance);
	return distances.every(Number.isFinite) ? evidenceNumber(Math.min(...distances)) : null;
}

export function evaluatePresentationImprovement({ current, baseline, semantic, baselineSemantic }) {
	const views = {};
	let accepted = validateSemanticRoleEvidence({ views: semantic }).accepted;
	for (const name of ["front", "back", "left", "right"]) {
		const currentSpread = current?.[name]?.materialSeparation?.luminanceSpread;
		const baselineSpread = baseline?.[name]?.materialSeparation?.luminanceSpread;
		const luminanceRetention = Number.isFinite(currentSpread) && Number.isFinite(baselineSpread)
			? (baselineSpread > 0 ? evidenceNumber(currentSpread / baselineSpread) : (currentSpread >= 15 ? 1 : 0)) : 0;
		const rangeValid = current?.[name]?.building?.luminanceP05 >= 10
			&& current?.[name]?.building?.luminanceP95 <= 248;
		const viewAccepted = luminanceRetention >= 0.75 && rangeValid;
		views[name] = {
			accepted: viewAccepted, luminanceRetention,
			old: baseline?.[name]?.materialSeparation ?? null, new: current?.[name]?.materialSeparation ?? null,
			reasons: [luminanceRetention >= 0.75 ? "luminance_spread_retained" : "luminance_spread_collapsed", rangeValid ? "presentation_range_valid" : "presentation_range_invalid"],
		};
		if (!viewAccepted) accepted = false;
	}
	for (const name of ["axon", "opposite-axon"]) {
		const separation = current?.[name]?.materialSeparation;
		const nonCollapsed = separation?.luminanceSpread >= 15 || separation?.chromaSpread >= 15;
		const groundingImproved = current?.[name]?.contactShadow?.detected === true && baseline?.[name]?.contactShadow?.detected !== true;
		const semanticAccepted = validateSemanticRoleEvidence({ views: Object.fromEntries(
			["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((view) => [view, semantic?.[view]]),
		) }).accepted;
		const oldScore = semanticMaterialScore(baselineSemantic?.[name]);
		const newScore = semanticMaterialScore(semantic?.[name]);
		const gain = Number.isFinite(oldScore) && Number.isFinite(newScore) ? evidenceNumber(newScore - oldScore) : null;
		const semanticMaterialImproved = Number.isFinite(gain) && gain >= 1;
		const viewAccepted = nonCollapsed && groundingImproved && semanticAccepted && semanticMaterialImproved;
		views[name] = {
			accepted: viewAccepted, groundingImproved, nonCollapsed, semanticAccepted,
			semanticMaterialScore: { old: oldScore, new: newScore, gain, improved: semanticMaterialImproved },
			old: baseline?.[name]?.materialSeparation ?? null, new: separation ?? null,
			delta: baseline?.[name] ? comparePresentationEvidence(current[name], baseline[name]) : null,
			reasons: [groundingImproved ? "bounded_grounding_added" : "grounding_not_improved", nonCollapsed ? "material_evidence_noncollapsed" : "material_evidence_collapsed", semanticAccepted ? "semantic_roles_separated" : "semantic_roles_invalid", semanticMaterialImproved ? "role_aware_material_score_improved" : "role_aware_material_score_not_improved"],
		};
		if (!viewAccepted) accepted = false;
	}
	for (const name of ["plan", "top"]) views[name] = {
		accepted: true, comparison: "geometry_and_range_only", old: baseline?.[name]?.materialSeparation ?? null, new: current?.[name]?.materialSeparation ?? null,
	};
	return { accepted, thresholds: { elevationLuminanceRetentionMinimum: 0.75, nonCollapsedSpreadMinimum: 15, semanticMaterialScoreMinimumGain: 1, semanticMaterialScore: "minimum RGB distance across concrete/glass, concrete/bronze, and glass/bronze" }, views };
}

export function comparePresentationEvidence(current, baseline) {
	return {
		contrastDelta: current.materialSeparation.luminanceSpread - baseline.materialSeparation.luminanceSpread,
		materialSeparation: {
			luminanceSpreadDelta: current.materialSeparation.luminanceSpread - baseline.materialSeparation.luminanceSpread,
			chromaSpreadDelta: current.materialSeparation.chromaSpread - baseline.materialSeparation.chromaSpread,
		},
		background: {
			deltaP95Change: current.background.deltaP95 - baseline.background.deltaP95,
			luminanceVarianceChange: current.background.luminanceVariance - baseline.background.luminanceVariance,
		},
	};
}

function finiteAtLeast(value, minimum) {
	return Number.isFinite(value) && value >= minimum;
}

export function validatePresentationEvidence({ views, style, styleHash }) {
	const codes = [];
	let resolvedStyle;
	try {
		resolvedStyle = resolvePbrRenderStyle(style);
		if (resolvedStyle.id !== COMPETITION_DAYLIGHT_STYLE_ID || styleHash !== renderStyleHash(resolvedStyle)) {
			codes.push("PBR_RENDER_STYLE_INVALID");
		}
	} catch {
		codes.push("PBR_RENDER_STYLE_INVALID");
	}
	const records = REQUIRED_VIEWS.map((name) => views?.[name]);
	const rangeInvalid = records.some((record) => !record
		|| !finiteAtLeast(record.building?.sampleCount, 1)
		|| !finiteAtLeast(record.building?.luminanceP05, 10)
		|| !Number.isFinite(record.building?.luminanceP95) || record.building.luminanceP95 > 248
		|| !finiteAtLeast(record.background?.sampleCount, 1)
		|| !Number.isFinite(record.background?.deltaP95) || record.background.deltaP95 > 12
		|| !Number.isFinite(record.background?.luminanceVariance) || record.background.luminanceVariance > 25);
	const materialSeparationInvalid = MATERIAL_SEPARATION_VIEWS.some((name) => {
		const separation = views?.[name]?.materialSeparation;
		return !(finiteAtLeast(separation?.luminanceSpread, 15) || finiteAtLeast(separation?.chromaSpread, 15));
	});
	if (rangeInvalid || materialSeparationInvalid) codes.push("PBR_PRESENTATION_RANGE_INVALID");
	if (SHADOW_VIEWS.some((name) => {
		const shadow = views?.[name]?.contactShadow;
		return shadow?.detected !== true || shadow.insideBuildingPixels !== 0
			|| !(finiteAtLeast(shadow.areaFraction, 0.002) || finiteAtLeast(shadow.buildingAreaFraction, 0.01))
			|| shadow.areaFraction > 0.12 || shadow.buildingAreaFraction > 0.5;
	})) codes.push("PBR_CONTACT_SHADOW_MISSING");
	return { accepted: codes.length === 0, codes: [...new Set(codes)] };
}
