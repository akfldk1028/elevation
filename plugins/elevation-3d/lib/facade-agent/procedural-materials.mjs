import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { validatePunchedFacadeGrammar } from "../facade-grammar.mjs";
import { PUNCHED_FACADE_BUDGETS } from "./punched-facade.mjs";

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
	if (!Number.isSafeInteger(resolution) || resolution < 1) {
		throw new TypeError("procedural facade texture resolution must be a positive integer");
	}
	const resolutionBigInt = BigInt(resolution);
	const projectedTextureBytes = resolutionBigInt * (resolutionBigInt * 4n + 1n) * 6n;
	if (projectedTextureBytes > BigInt(PUNCHED_FACADE_BUDGETS.maxTextureBytes)) throw new RangeError("texture byte budget exceeded");
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

/**
 * Maps for a material an author DECLARED.
 *
 * The generator above knows two substances by name because they were the only two the
 * vocabulary had. A declared material has no name the code knows - that is the point of
 * declaring it - so its surface is derived from the same words the rest of its numbers come
 * from: the finish gives the grain, and `joint_m` draws the module it comes in. The colour
 * itself stays on the material's baseColorFactor, never in the map - see the note below.
 *
 * Two things depended on this. A facade of only declared materials carried no maps at all,
 * so the PBR pass rendered identically with them switched off and PBR_EVIDENCE_MISSING fired
 * on a design that was not at fault. And the joint an author declares was, until now, a
 * number nothing drew - the very distinction one of them argued carries a building in
 * greyscale: "the difference between sheet metal and cast concrete in a drawing has never
 * been hue, it is joint frequency."
 */
export function createDeclaredMaterialMaps({ material, resolution = 512, metresAcross = 6 }) {
	if (!Number.isSafeInteger(resolution) || resolution < 8) throw new TypeError("declared material texture resolution invalid");
	const hash = sha256(JSON.stringify(material));
	// The joint in pixels, and how wide its shadow is. A monolithic material draws none.
	const pitch = material.joint?.pitch_m ? Math.max(8, Math.round((material.joint.pitch_m / metresAcross) * resolution)) : 0;
	const jointWidth = pitch ? Math.max(1, Math.round(resolution / 512)) : 0;
	const onJoint = (x, y) => pitch > 0 && (x % pitch < jointWidth || y % pitch < jointWidth);
	// Deterministic grain: the same declaration always produces the same surface, which is
	// what lets a render be compared with its own baseline.
	const grain = (x, y) => {
		const value = Math.sin((x * 12.9898 + y * 78.233) * 0.017) * 43758.5453;
		return value - Math.floor(value);
	};
	const amplitude = material.texture_intensity;
	// The base map carries the MODULATION ONLY, around white - never the tint. glTF multiplies
	// baseColorFactor by baseColorTexture, and the factor already carries the declared colour,
	// so a tinted map applies it twice. Measured when it did: a mid-dark glass squared itself
	// to near-black, and at its 0.42 opacity over a pale wall the composite was 58% wall -
	// a flat neutral grey. Every declared glazing in the corpus rendered at chroma 1-5 while
	// legacy glass rendered at 16-19, so no declared window read as a window in any render
	// while the drawing painted it as one. A reader spotted it by holding the two side by side.
	const base = encodePng(resolution, resolution, (x, y) => {
		if (onJoint(x, y)) return [140, 140, 140, 255];
		const mix = 1 + (grain(x, y) - 0.5) * amplitude * 2;
		const level = Math.max(0, Math.min(255, Math.round(255 * mix)));
		return [level, level, level, 255];
	});
	const relief = material.normal_intensity;
	const normal = encodePng(resolution, resolution, (x, y) => {
		if (onJoint(x, y)) return [128, Math.round(128 - 90 * relief * 4), 255, 255];
		const slope = (grain(x, y) - 0.5) * relief * 2;
		return [Math.round(128 + slope * 60), Math.round(128 - slope * 60), 255, 255];
	});
	const metallicRoughness = encodePng(resolution, resolution, (x, y) => [
		0,
		Math.round(255 * Math.max(0, Math.min(1, material.roughness + (onJoint(x, y) ? 0.1 : (grain(x, y) - 0.5) * amplitude)))),
		Math.round(255 * material.metalness),
		255,
	]);
	return {
		baseColor: mapRecord(`${material.id}-base-color`, resolution, hash, base),
		normal: mapRecord(`${material.id}-normal`, resolution, hash, normal),
		metallicRoughness: mapRecord(`${material.id}-metallic-roughness`, resolution, hash, metallicRoughness),
	};
}
