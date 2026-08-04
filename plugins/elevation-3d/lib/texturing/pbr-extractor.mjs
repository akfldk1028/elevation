import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { measureUvCoverage } from "./uv-preparation.mjs";

const SLOT_DEFINITIONS = [
	["baseColor", "getBaseColorTexture", "srgb"],
	["emissive", "getEmissiveTexture", "srgb"],
	["metallicRoughness", "getMetallicRoughnessTexture", "linear"],
	["normal", "getNormalTexture", "linear"],
	["occlusion", "getOcclusionTexture", "linear"],
];

export async function extractPbrEvidence(providerGlb) {
	const path = resolve(providerGlb);
	const document = await new NodeIO().read(path);
	const usedMaterials = new Set();
	for (const mesh of document.getRoot().listMeshes()) {
		for (const primitive of mesh.listPrimitives()) if (primitive.getMaterial()) usedMaterials.add(primitive.getMaterial());
	}
	const textureRecords = new Map();
	const materials = [];
	for (const material of document.getRoot().listMaterials().filter((candidate) => usedMaterials.has(candidate))) {
		const slots = [];
		for (const [slot, getter, colorSpace] of SLOT_DEFINITIONS) {
			const texture = material[getter]();
			if (!texture) continue;
			slots.push(slot);
			let record = textureRecords.get(texture);
			if (!record) {
				const image = texture.getImage();
				const size = texture.getSize();
				record = {
					name: texture.getName(),
					uri: texture.getURI(),
					mimeType: texture.getMimeType(),
					width: size?.[0] ?? 0,
					height: size?.[1] ?? 0,
					embedded: image !== null && texture.getURI() === "",
					sha256: image ? createHash("sha256").update(image).digest("hex") : null,
					colorSpaces: [],
				};
				textureRecords.set(texture, record);
			}
			if (!record.colorSpaces.includes(colorSpace)) record.colorSpaces.push(colorSpace);
		}
		materials.push({
			name: material.getName(),
			slots,
			alphaMode: material.getAlphaMode(),
			doubleSided: material.getDoubleSided(),
		});
	}
	return {
		providerGlb: path,
		materials,
		textures: [...textureRecords.values()],
		uvCoverage: measureUvCoverage(document),
	};
}
