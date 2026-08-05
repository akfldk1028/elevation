import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { validatePunchedFacadeGrammar } from "../facade-grammar.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PALETTE = Object.freeze({
	brick: [132, 57, 38],
	brickDark: [104, 42, 31],
	mortar: [181, 174, 158],
	precast: [174, 169, 158],
});

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.allocUnsafe(data.length + 12);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
	return chunk;
}

function encodePng(width, height, pixel) {
	const stride = width * 4;
	const raw = Buffer.allocUnsafe((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const rgba = pixel(x, y);
			const offset = row + 1 + x * 4;
			raw[offset] = rgba[0];
			raw[offset + 1] = rgba[1];
			raw[offset + 2] = rgba[2];
			raw[offset + 3] = rgba[3];
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function integerNoise(x, y) {
	let value = Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263);
	value = Math.imul(value ^ (value >>> 13), 1274126177);
	return (value ^ (value >>> 16)) >>> 0;
}

function brickSample(x, y, resolution, moduleRatio) {
	const course = Math.max(4, Math.round(resolution / 32));
	const brickWidth = Math.max(course * 2, Math.round(course * moduleRatio));
	const mortar = Math.max(1, Math.round(course * 0.1));
	const courseIndex = Math.floor(y / course);
	const offset = courseIndex % 2 ? Math.floor(brickWidth / 2) : 0;
	const localX = ((x + offset) % brickWidth + brickWidth) % brickWidth;
	const localY = y % course;
	return {
		mortar: localX < mortar || localY < mortar,
		edgeX: localX < mortar + 2 || localX >= brickWidth - 2,
		edgeY: localY < mortar + 2 || localY >= course - 2,
		variation: integerNoise(Math.floor((x + offset) / brickWidth), courseIndex) % 19,
	};
}

function mapRecord(name, resolution, grammarHash, data) {
	return {
		name,
		data,
		mimeType: "image/png",
		width: resolution,
		height: resolution,
		sha256: sha256(data),
		grammar_sha256: grammarHash,
		generator: "elevation-3d-procedural-pbr-v1",
	};
}

export function createFacadePbrMaps({ grammar, resolution }) {
	const canonical = validatePunchedFacadeGrammar(grammar, { allowDerived: true });
	if (!Number.isInteger(resolution) || resolution < 1 || resolution > 2048) {
		throw new TypeError("procedural facade texture resolution must be an integer from 1 to 2048");
	}
	const grammarHash = sha256(JSON.stringify(canonical));
	const ratio = canonical.brick_module_m[0] / canonical.brick_module_m[1];
	const brickBase = encodePng(resolution, resolution, (x, y) => {
		const sample = brickSample(x, y, resolution, ratio);
		if (sample.mortar) return [...PALETTE.mortar, 255];
		const mix = sample.variation / 18;
		return [0, 1, 2].map((channel) => Math.round(PALETTE.brick[channel] * (1 - mix * 0.18) + PALETTE.brickDark[channel] * mix * 0.18)).concat(255);
	});
	const brickNormal = encodePng(resolution, resolution, (x, y) => {
		const sample = brickSample(x, y, resolution, ratio);
		if (sample.mortar) return [128, 128, 244, 255];
		return [sample.edgeX ? 116 : 128, sample.edgeY ? 116 : 128, 255, 255];
	});
	const brickMetallicRoughness = encodePng(resolution, resolution, (x, y) => {
		const sample = brickSample(x, y, resolution, ratio);
		return [255, sample.mortar ? 236 : 205 + (sample.variation % 12), 0, 255];
	});
	const precastBase = encodePng(resolution, resolution, (x, y) => {
		const variation = integerNoise(x >> 3, y >> 3) % 13 - 6;
		return [...PALETTE.precast.map((value) => value + variation), 255];
	});
	const precastNormal = encodePng(resolution, resolution, (x, y) => {
		const variation = integerNoise(x >> 4, y >> 4);
		return [125 + (variation % 7), 125 + ((variation >>> 4) % 7), 255, 255];
	});
	const precastMetallicRoughness = encodePng(resolution, resolution, (x, y) => {
		const variation = integerNoise(x >> 4, y >> 4) % 12;
		return [255, 194 + variation, 0, 255];
	});
	return {
		brick: {
			baseColor: mapRecord("brick-base-color", resolution, grammarHash, brickBase),
			normal: mapRecord("brick-normal", resolution, grammarHash, brickNormal),
			metallicRoughness: mapRecord("brick-metallic-roughness", resolution, grammarHash, brickMetallicRoughness),
		},
		precast: {
			baseColor: mapRecord("precast-base-color", resolution, grammarHash, precastBase),
			normal: mapRecord("precast-normal", resolution, grammarHash, precastNormal),
			metallicRoughness: mapRecord("precast-metallic-roughness", resolution, grammarHash, precastMetallicRoughness),
		},
	};
}
