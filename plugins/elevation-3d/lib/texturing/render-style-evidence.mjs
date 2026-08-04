import sharp from "sharp";
import { COMPETITION_DAYLIGHT_STYLE_ID, renderStyleHash, resolvePbrRenderStyle } from "./render-style.mjs";

const REQUIRED_VIEWS = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const SHADOW_VIEWS = ["axon", "opposite-axon"];

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
	const decoded = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const { width, height } = decoded.info;
	const bounds = normalizeBounds(buildingBounds, width, height);
	const backgroundRgb = parseBackground(background);
	const backgroundLuminance = luminance(...backgroundRgb);
	const buildingLuminance = [];
	const buildingChroma = [];
	const outside = [];
	const adjacency = Math.max(2, Math.ceil(Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1) * 0.35));

	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		const offset = (y * width + x) * 3;
		const red = decoded.data[offset], green = decoded.data[offset + 1], blue = decoded.data[offset + 2];
		const pixelLuminance = luminance(red, green, blue);
		if (isInside(x, y, bounds)) {
			buildingLuminance.push(pixelLuminance);
			buildingChroma.push(Math.max(red, green, blue) - Math.min(red, green, blue));
			continue;
		}
		const delta = Math.hypot(red - backgroundRgb[0], green - backgroundRgb[1], blue - backgroundRgb[2]);
		const darkening = backgroundLuminance - pixelLuminance;
		const adjacent = x >= bounds.minX - adjacency && x <= bounds.maxX + adjacency
			&& y >= bounds.minY - adjacency && y <= bounds.maxY + adjacency;
		const shadowCandidate = adjacent && darkening >= 5 && darkening <= 90 && delta >= 5 && delta <= 120;
		outside.push({ delta, luminance: pixelLuminance, darkening, shadowCandidate });
	}

	const shadowPixels = outside.filter((pixel) => pixel.shadowCandidate);
	const shadowLuminance = shadowPixels.map((pixel) => pixel.luminance);
	const shadowAreaFraction = shadowPixels.length / (width * height);
	const shadowRange = shadowLuminance.length ? percentile(shadowLuminance, 0.95) - percentile(shadowLuminance, 0.05) : 0;
	const buildingArea = buildingLuminance.length;
	const contactShadowDetected = shadowPixels.length >= 4
		&& shadowAreaFraction >= 0.002 && shadowAreaFraction <= 0.12
		&& shadowPixels.length / buildingArea <= 0.5
		&& shadowRange >= 6;
	const cleanBackground = outside.filter((pixel) => !pixel.shadowCandidate);
	const backgroundDeltas = cleanBackground.map((pixel) => pixel.delta);
	const backgroundLuminances = cleanBackground.map((pixel) => pixel.luminance);

	return {
		image: { width, height },
		building: {
			sampleCount: buildingLuminance.length,
			luminanceP05: percentile(buildingLuminance, 0.05),
			luminanceP50: percentile(buildingLuminance, 0.5),
			luminanceP95: percentile(buildingLuminance, 0.95),
		},
		background: {
			sampleCount: cleanBackground.length,
			deltaP95: percentile(backgroundDeltas, 0.95),
			luminanceVariance: variance(backgroundLuminances),
		},
		contactShadow: {
			detected: contactShadowDetected,
			pixelCount: shadowPixels.length,
			areaFraction: shadowAreaFraction,
			luminanceRange: shadowRange,
			insideBuildingPixels: 0,
		},
		materialSeparation: {
			luminanceSpread: percentile(buildingLuminance, 0.9) - percentile(buildingLuminance, 0.1),
			chromaSpread: percentile(buildingChroma, 0.9) - percentile(buildingChroma, 0.1),
		},
	};
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
		|| !Number.isFinite(record.background?.luminanceVariance) || record.background.luminanceVariance > 25
		|| !(finiteAtLeast(record.materialSeparation?.luminanceSpread, 15)
			|| finiteAtLeast(record.materialSeparation?.chromaSpread, 15)));
	if (rangeInvalid) codes.push("PBR_PRESENTATION_RANGE_INVALID");
	if (SHADOW_VIEWS.some((name) => {
		const shadow = views?.[name]?.contactShadow;
		return shadow?.detected !== true || shadow.insideBuildingPixels !== 0
			|| !finiteAtLeast(shadow.areaFraction, 0.002) || shadow.areaFraction > 0.12;
	})) codes.push("PBR_CONTACT_SHADOW_MISSING");
	return { accepted: codes.length === 0, codes: [...new Set(codes)] };
}
