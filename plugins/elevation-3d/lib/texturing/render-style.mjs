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
	ground: { enabledFor: ["axon", "opposite-axon"], opacity: 0.12, padding: 0.16 },
	materialResponse: {
		concrete: { maxRoughnessDelta: -0.08 },
		glass: { maxEnvIntensity: 1.35, preserveTransparency: true },
		bronze: { maxMetalnessDelta: 0.08 },
		opaque: { maxRoughnessDelta: -0.04 },
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

function color(value, path) {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) invalid(`${path} must be a six-digit hex color`);
	return value.toLowerCase();
}

function validate(style) {
	if (style.id !== COMPETITION_DAYLIGHT_STYLE_ID) invalid("style.id is not supported");
	style.background = color(style.background, "style.background");
	if (style.toneMapping !== "aces-filmic") invalid("style.toneMapping is not supported");
	nonNegative(style.exposure, "style.exposure");
	if (style.environment.type !== "room-pmrem") invalid("style.environment.type is not supported");
	nonNegative(style.environment.intensity, "style.environment.intensity");
	style.hemisphere.sky = color(style.hemisphere.sky, "style.hemisphere.sky");
	style.hemisphere.ground = color(style.hemisphere.ground, "style.hemisphere.ground");
	nonNegative(style.hemisphere.intensity, "style.hemisphere.intensity");
	style.sun.color = color(style.sun.color, "style.sun.color");
	nonNegative(style.sun.intensity, "style.sun.intensity");
	if (!Array.isArray(style.sun.position) || style.sun.position.length !== 3) invalid("style.sun.position must be a three-element vector");
	style.sun.position.forEach((value, index) => finite(value, `style.sun.position[${index}]`));
	if (!Number.isInteger(style.sun.shadowMapSize) || style.sun.shadowMapSize <= 0) invalid("style.sun.shadowMapSize must be a positive integer");
	nonNegative(style.sun.radius, "style.sun.radius");
	finite(style.sun.bias, "style.sun.bias");
	nonNegative(style.sun.normalBias, "style.sun.normalBias");
	if (!Array.isArray(style.ground.enabledFor)
		|| new Set(style.ground.enabledFor).size !== style.ground.enabledFor.length
		|| style.ground.enabledFor.some((view) => view !== "axon" && view !== "opposite-axon")) {
		invalid("style.ground.enabledFor contains an unsupported view");
	}
	finite(style.ground.opacity, "style.ground.opacity");
	if (style.ground.opacity < 0 || style.ground.opacity > 1) invalid("style.ground.opacity must be between zero and one");
	nonNegative(style.ground.padding, "style.ground.padding");
	finite(style.materialResponse.concrete.maxRoughnessDelta, "style.materialResponse.concrete.maxRoughnessDelta");
	nonNegative(style.materialResponse.glass.maxEnvIntensity, "style.materialResponse.glass.maxEnvIntensity");
	if (typeof style.materialResponse.glass.preserveTransparency !== "boolean") invalid("style.materialResponse.glass.preserveTransparency must be boolean");
	finite(style.materialResponse.bronze.maxMetalnessDelta, "style.materialResponse.bronze.maxMetalnessDelta");
	finite(style.materialResponse.opaque.maxRoughnessDelta, "style.materialResponse.opaque.maxRoughnessDelta");
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
