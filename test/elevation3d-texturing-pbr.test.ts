import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { canonicalSurfaceSignature } from "../plugins/elevation-3d/lib/texturing/geometry-signature.mjs";
import { extractPbrEvidence } from "../plugins/elevation-3d/lib/texturing/pbr-extractor.mjs";
import { rebuildTexturedGlb } from "../plugins/elevation-3d/lib/texturing/pbr-embedder.mjs";
import { validateMaterialEvidence } from "../plugins/elevation-3d/lib/texturing/material-validator.mjs";
import { analyzeNormalizedPbrTransfer } from "../plugins/elevation-3d/lib/texturing/normalized-pbr-transfer.mjs";
import { chooseTextureCompression } from "../plugins/elevation-3d/lib/texturing/texture-compression.mjs";
import { discoverElevation3dAssetRoot } from "./helpers/elevation3d-assets.ts";

async function textureBytes(size: number, color: { r: number; g: number; b: number; alpha?: number }) {
	return sharp({ create: { width: size, height: size, channels: 4, background: { ...color, alpha: color.alpha ?? 1 } } })
		.png()
		.toBuffer();
}

async function writeArchitecturalGlb(path: string, options: { pbr?: boolean; moved?: boolean; textureSize?: number } = {}) {
	const document = new Document();
	const buffer = document.createBuffer("geometry");
	const positions = [
		[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0],
		[0, 0, 1], [1, 0, 1], [0, 1, 1],
	];
	if (options.moved) positions[2][0] += 0.01;
	const concretePosition = document.createAccessor("concrete-position", buffer).setType("VEC3")
		.setArray(new Float32Array(positions.slice(0, 4).flat()));
	const concreteIndex = document.createAccessor("concrete-index", buffer).setType("SCALAR")
		.setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
	const concreteUv = document.createAccessor("concrete-uv", buffer).setType("VEC2")
		.setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
	const glassPosition = document.createAccessor("glass-position", buffer).setType("VEC3")
		.setArray(new Float32Array(positions.slice(4).flat()));
	const glassIndex = document.createAccessor("glass-index", buffer).setType("SCALAR")
		.setArray(new Uint16Array([0, 1, 2]));
	const glassUv = document.createAccessor("glass-uv", buffer).setType("VEC2")
		.setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
	const concrete = document.createMaterial("concrete").setBaseColorFactor([0.7, 0.7, 0.7, 1]);
	const glass = document.createMaterial("glass").setBaseColorFactor([0.3, 0.5, 0.7, 0.3]).setAlphaMode("BLEND").setDoubleSided(true);
	if (options.pbr) {
		const size = options.textureSize ?? 2048;
		for (const material of [concrete, glass]) {
			const prefix = material.getName();
			const base = document.createTexture(`${prefix}-base`).setMimeType("image/png").setImage(await textureBytes(size, { r: 180, g: 170, b: 155 }));
			const normal = document.createTexture(`${prefix}-normal`).setMimeType("image/png").setImage(await textureBytes(size, { r: 128, g: 128, b: 255 }));
			const metalRough = document.createTexture(`${prefix}-metal-rough-ao`).setMimeType("image/png").setImage(await textureBytes(size, { r: 255, g: 180, b: 10 }));
			const emissive = document.createTexture(`${prefix}-emissive`).setMimeType("image/png").setImage(await textureBytes(size, { r: 2, g: 2, b: 2 }));
			material.setBaseColorTexture(base).setNormalTexture(normal).setMetallicRoughnessTexture(metalRough)
				.setOcclusionTexture(metalRough).setEmissiveTexture(emissive).setMetallicFactor(0.1).setRoughnessFactor(0.7);
		}
		glass.setAlphaMode("OPAQUE").setBaseColorFactor([1, 1, 1, 1]).setDoubleSided(false);
	}
	const mesh = document.createMesh("architectural-mesh")
		.addPrimitive(document.createPrimitive().setAttribute("POSITION", concretePosition).setAttribute("TEXCOORD_0", concreteUv).setIndices(concreteIndex).setMaterial(concrete))
		.addPrimitive(document.createPrimitive().setAttribute("POSITION", glassPosition).setAttribute("TEXCOORD_0", glassUv).setIndices(glassIndex).setMaterial(glass));
	const scene = document.createScene("scene").addChild(document.createNode("building").setMesh(mesh));
	document.getRoot().setDefaultScene(scene);
	await new NodeIO().write(path, document);
}

async function surfaceFromGlb(path: string) {
	const document = await new NodeIO().read(path);
	const vertices: number[][] = [];
	const triangles: number[][] = [];
	for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
		const position = primitive.getAttribute("POSITION")!;
		const offset = vertices.length;
		for (let index = 0; index < position.getCount(); index += 1) vertices.push(position.getElement(index, [0, 0, 0]));
		const indices = primitive.getIndices()!;
		for (let index = 0; index < indices.getCount(); index += 3) triangles.push([
			indices.getScalar(index) + offset, indices.getScalar(index + 1) + offset, indices.getScalar(index + 2) + offset,
		]);
	}
	return canonicalSurfaceSignature({ vertices, triangles });
}

test("PBR extraction reports embedded architectural material channels and 2K maps", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pbr-extract-"));
	try {
		const provider = join(directory, "provider.glb");
		await writeArchitecturalGlb(provider, { pbr: true });
		const evidence = await extractPbrEvidence(provider);
		assert.deepEqual(evidence.materials.map((material: any) => material.name), ["concrete", "glass"]);
		assert.deepEqual(evidence.materials[0].slots, ["baseColor", "emissive", "metallicRoughness", "normal", "occlusion"]);
		assert.equal(evidence.textures.every((texture: any) => texture.embedded && texture.width === 2048 && texture.height === 2048), true);
		assert.deepEqual(validateMaterialEvidence(evidence), { accepted: true, status: "accepted", reasons: [] });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("material validation rejects external URLs, low resolution, and incompatible color-space reuse", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pbr-invalid-"));
	try {
		const provider = join(directory, "provider.glb");
		await writeArchitecturalGlb(provider, { pbr: true, textureSize: 64 });
		const lowResolution = await extractPbrEvidence(provider);
		assert.equal(validateMaterialEvidence(lowResolution).reasons.includes("TEXTURE_RESOLUTION_TOO_LOW"), true);
		const external = structuredClone(lowResolution);
		external.textures[0].uri = "https://cdn.example.test/base.png";
		external.textures[0].embedded = false;
		assert.equal(validateMaterialEvidence(external).reasons.includes("EXTERNAL_TEXTURE_URI"), true);
		const colorConflict = structuredClone(lowResolution);
		colorConflict.textures[0].colorSpaces = ["srgb", "linear"];
		assert.equal(validateMaterialEvidence(colorConflict).reasons.includes("TEXTURE_COLOR_SPACE_CONFLICT"), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("PBR rebuild keeps local geometry and glass semantics while embedding provider maps", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pbr-rebuild-"));
	try {
		const authoritative = join(directory, "authoritative.glb");
		const provider = join(directory, "provider.glb");
		const output = join(directory, "textured.glb");
		await writeArchitecturalGlb(authoritative);
		await writeArchitecturalGlb(provider, { pbr: true });
		const report = await rebuildTexturedGlb({
			authoritativeGlb: authoritative,
			preparedUvGlb: authoritative,
			providerGlb: provider,
			outputGlb: output,
		});
		assert.equal(report.geometry.accepted, true);
		assert.equal(report.material.accepted, true);
		assert.equal((await surfaceFromGlb(authoritative)).surfaceHash, (await surfaceFromGlb(output)).surfaceHash);
		const result = await new NodeIO().read(output);
		const concrete = result.getRoot().listMaterials().find((material) => material.getName() === "concrete")!;
		const glass = result.getRoot().listMaterials().find((material) => material.getName() === "glass")!;
		assert.ok(concrete.getBaseColorTexture());
		assert.ok(concrete.getNormalTexture());
		assert.equal(glass.getAlphaMode(), "BLEND");
		assert.equal(glass.getDoubleSided(), true);
		assert.equal(result.getRoot().listTextures().every((texture) => texture.getImage() !== null && !/^https?:/i.test(texture.getURI())), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("PBR rebuild rejects provider geometry displacement before writing a final asset", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pbr-geometry-reject-"));
	try {
		const authoritative = join(directory, "authoritative.glb");
		const provider = join(directory, "provider.glb");
		await writeArchitecturalGlb(authoritative);
		await writeArchitecturalGlb(provider, { pbr: true, moved: true });
		await assert.rejects(() => rebuildTexturedGlb({
			authoritativeGlb: authoritative,
			preparedUvGlb: authoritative,
			providerGlb: provider,
			outputGlb: join(directory, "must-not-exist.glb"),
		}), (error: any) => error.code === "PROVIDER_GEOMETRY_MISMATCH");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("texture compression explicitly falls back when no KTX2 encoder is configured", () => {
	assert.deepEqual(chooseTextureCompression({ ktx2Encoder: null }), {
		mode: "portable-fallback",
		mimeTypes: ["image/png", "image/webp"],
	});
});

test("normalized PBR transfer identifies fully matched non-glass primitives in the real Tripo artifact", async () => {
	const sharedRoot = discoverElevation3dAssetRoot(process.cwd());
	const authoritativeGlb = join(sharedRoot, "elevation-3d-e2e-results", "autonomous", "creative-013", "automatic-allviews-flicker-v2-20260804", "delivery", "enriched.glb");
	const providerGlb = join(sharedRoot, "elevation-3d-e2e-results", "autonomous", "creative-013", "tripo-pbr-v1-20260804", "provider", "provider-textured.glb");
	const report = await analyzeNormalizedPbrTransfer({ authoritativeGlb, providerGlb });
	assert.equal(report.normalization.accepted, true);
	assert.equal(Math.abs(report.normalization.uniformScale - 24.721488) < 0.0001, true);
	assert.equal(report.anchorSurface.accepted, true);
	assert.equal(report.transfer.totalPrimitives, 1171);
	assert.equal(report.transfer.matchedPrimitives, 1166);
	assert.equal(report.transfer.status, "review");
	assert.equal(report.transfer.areaCoverage >= 0.90, true);
	assert.equal(report.transfer.materials.concrete.areaCoverage >= 0.80, true);
	assert.equal(report.transfer.materials.bronze.areaCoverage >= 0.95, true);
	assert.equal(report.transfer.materials.opaque.areaCoverage >= 0.95, true);
});
