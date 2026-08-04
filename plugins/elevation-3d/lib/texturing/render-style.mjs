export const COMPETITION_DAYLIGHT_STYLE_ID = "competition-daylight-v1";

const PRESET = {
	id: COMPETITION_DAYLIGHT_STYLE_ID,
	background: "#fafaf7",
	toneMapping: "aces-filmic",
	exposure: 0.94,
	environment: { type: "room-pmrem", intensity: 0.45 },
	hemisphere: { sky: "#ffffff", ground: "#d8d1c5", intensity: 0.8 },
	sun: {
		color: "#fff8ec",
		intensity: 1.9,
		position: [12, -8, 60],
		shadowMapSize: 2048,
		radius: 5,
		bias: -0.0002,
		normalBias: 0.02,
	},
	ground: { enabledFor: ["axon", "opposite-axon"], opacity: 0.14, padding: 0.16 },
	materialResponse: {
		concrete: { maxRoughnessDelta: -0.08, tintMultiplier: "#fff4e6" },
		glass: { maxEnvIntensity: 1.35, preserveTransparency: true, tintMultiplier: "#a8c0cc" },
		bronze: { maxMetalnessDelta: 0.08, tintMultiplier: "#8a5a32" },
		opaque: { maxRoughnessDelta: -0.04, tintMultiplier: "#454b52" },
	},
};

class PbrRenderStyleError extends Error {
	constructor(message) {
		super(message);
		this.name = "PbrRenderStyleError";
		this.code = "PBR_RENDER_STYLE_INVALID";
	}
}

function invalid(message) {
	throw new PbrRenderStyleError(message);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeKnown(template, overrides, path = "style") {
	if (!isRecord(overrides)) invalid(`${path} must be an object`);
	for (const key of Object.keys(overrides)) {
		if (!Object.hasOwn(template, key)) invalid(`${path}.${key} is not supported`);
	}
	return Object.fromEntries(Object.entries(template).map(([key, fallback]) => {
		if (!Object.hasOwn(overrides, key)) return [key, structuredClone(fallback)];
		const override = overrides[key];
		if (isRecord(fallback)) return [key, mergeKnown(fallback, override, `${path}.${key}`)];
		return [key, structuredClone(override)];
	}));
}

function finite(value, path) {
	if (!Number.isFinite(value)) invalid(`${path} must be finite`);
	return value;
}

function nonNegative(value, path) {
	finite(value, path);
	if (value < 0) invalid(`${path} must not be negative`);
}

function bounded(value, minimum, maximum, path, { minimumExclusive = false } = {}) {
	finite(value, path);
	if ((minimumExclusive ? value <= minimum : value < minimum) || value > maximum) {
		invalid(`${path} must be between ${minimumExclusive ? "greater than " : ""}${minimum} and ${maximum}`);
	}
}

function color(value, path) {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) invalid(`${path} must be a six-digit hex color`);
	return value.toLowerCase();
}

function validate(style) {
	if (style.id !== COMPETITION_DAYLIGHT_STYLE_ID) invalid("style.id is not supported");
	style.background = color(style.background, "style.background");
	if (style.toneMapping !== "aces-filmic") invalid("style.toneMapping is not supported");
	bounded(style.exposure, 0, 3, "style.exposure", { minimumExclusive: true });
	if (style.environment.type !== "room-pmrem") invalid("style.environment.type is not supported");
	bounded(style.environment.intensity, 0, 10, "style.environment.intensity");
	style.hemisphere.sky = color(style.hemisphere.sky, "style.hemisphere.sky");
	style.hemisphere.ground = color(style.hemisphere.ground, "style.hemisphere.ground");
	bounded(style.hemisphere.intensity, 0, 10, "style.hemisphere.intensity");
	style.sun.color = color(style.sun.color, "style.sun.color");
	bounded(style.sun.intensity, 0, 10, "style.sun.intensity");
	if (!Array.isArray(style.sun.position) || style.sun.position.length !== 3) invalid("style.sun.position must be a three-element vector");
	style.sun.position.forEach((value, index) => bounded(value, -1000, 1000, `style.sun.position[${index}]`));
	if (style.sun.position.every((value) => value === 0)) invalid("style.sun.position must be nonzero");
	if (!Number.isInteger(style.sun.shadowMapSize)
		|| style.sun.shadowMapSize < 256 || style.sun.shadowMapSize > 4096
		|| (style.sun.shadowMapSize & (style.sun.shadowMapSize - 1)) !== 0) {
		invalid("style.sun.shadowMapSize must be a power of two between 256 and 4096");
	}
	bounded(style.sun.radius, 0, 20, "style.sun.radius");
	bounded(style.sun.bias, -0.1, 0.1, "style.sun.bias");
	bounded(style.sun.normalBias, 0, 1, "style.sun.normalBias");
	if (!Array.isArray(style.ground.enabledFor)
		|| new Set(style.ground.enabledFor).size !== style.ground.enabledFor.length
		|| style.ground.enabledFor.some((view) => view !== "axon" && view !== "opposite-axon")) {
		invalid("style.ground.enabledFor contains an unsupported view");
	}
	bounded(style.ground.opacity, 0, 0.5, "style.ground.opacity");
	bounded(style.ground.padding, 0, 1, "style.ground.padding");
	bounded(style.materialResponse.concrete.maxRoughnessDelta, -1, 1, "style.materialResponse.concrete.maxRoughnessDelta");
	style.materialResponse.concrete.tintMultiplier = color(style.materialResponse.concrete.tintMultiplier, "style.materialResponse.concrete.tintMultiplier");
	bounded(style.materialResponse.glass.maxEnvIntensity, 0, 5, "style.materialResponse.glass.maxEnvIntensity");
	if (typeof style.materialResponse.glass.preserveTransparency !== "boolean") invalid("style.materialResponse.glass.preserveTransparency must be boolean");
	style.materialResponse.glass.tintMultiplier = color(style.materialResponse.glass.tintMultiplier, "style.materialResponse.glass.tintMultiplier");
	bounded(style.materialResponse.bronze.maxMetalnessDelta, -1, 1, "style.materialResponse.bronze.maxMetalnessDelta");
	style.materialResponse.bronze.tintMultiplier = color(style.materialResponse.bronze.tintMultiplier, "style.materialResponse.bronze.tintMultiplier");
	bounded(style.materialResponse.opaque.maxRoughnessDelta, -1, 1, "style.materialResponse.opaque.maxRoughnessDelta");
	style.materialResponse.opaque.tintMultiplier = color(style.materialResponse.opaque.tintMultiplier, "style.materialResponse.opaque.tintMultiplier");
	return style;
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

export function resolvePbrRenderStyle(overrides = {}) {
	return deepFreeze(validate(mergeKnown(PRESET, overrides)));
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value) {
	const rightRotate = (word, amount) => (word >>> amount) | (word << (32 - amount));
	const words = [];
	const bytes = new TextEncoder().encode(value);
	const bitLength = bytes.length * 8;
	for (const byte of bytes) words.push(byte);
	words.push(0x80);
	while (words.length % 64 !== 56) words.push(0);
	for (let shift = 56; shift >= 0; shift -= 8) words.push(Math.floor(bitLength / (2 ** shift)) & 0xff);
	const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const constants = Array.from({ length: 64 }, (_, index) => {
		let candidate = 2;
		let found = -1;
		while (found < index) {
			let prime = true;
			for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) if (candidate % divisor === 0) prime = false;
			if (prime) found += 1;
			if (found < index) candidate += 1;
		}
		return (Math.cbrt(candidate) % 1) * 0x100000000 | 0;
	});
	for (let offset = 0; offset < words.length; offset += 64) {
		const schedule = new Array(64);
		for (let index = 0; index < 16; index += 1) {
			const start = offset + index * 4;
			schedule[index] = (words[start] << 24) | (words[start + 1] << 16) | (words[start + 2] << 8) | words[start + 3];
		}
		for (let index = 16; index < 64; index += 1) {
			const first = rightRotate(schedule[index - 15], 7) ^ rightRotate(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
			const second = rightRotate(schedule[index - 2], 17) ^ rightRotate(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
			schedule[index] = (schedule[index - 16] + first + schedule[index - 7] + second) | 0;
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index += 1) {
			const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
			const choose = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choose + constants[index] + schedule[index]) | 0;
			const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) | 0;
			h = g; g = f; f = e; e = (d + temporary1) | 0; d = c; c = b; b = a; a = (temporary1 + temporary2) | 0;
		}
		for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) hash[index] = (hash[index] + word) | 0;
	}
	return hash.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

export function renderStyleHash(style) {
	return sha256(canonicalJson(resolvePbrRenderStyle(style)));
}

const VIEW_POLICIES = Object.freeze({
	front: false,
	back: false,
	left: false,
	right: false,
	plan: false,
	top: false,
	axon: true,
	"opposite-axon": true,
});

export function viewPresentationPolicy(viewName, style) {
	if (!Object.hasOwn(VIEW_POLICIES, viewName)) invalid(`unsupported presentation view: ${viewName}`);
	const resolved = resolvePbrRenderStyle(style);
	const ground = VIEW_POLICIES[viewName] && resolved.ground.enabledFor.includes(viewName);
	return deepFreeze({ ground, contactShadow: ground });
}
