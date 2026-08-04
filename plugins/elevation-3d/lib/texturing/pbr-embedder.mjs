import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Logger, NodeIO, PropertyType } from "@gltf-transform/core";
import { copyToDocument, createDefaultPropertyResolver, prune } from "@gltf-transform/functions";
import { TexturingError } from "./contract.mjs";
import { validateGeometryLock } from "./geometry-validator.mjs";
import { extractPbrEvidence } from "./pbr-extractor.mjs";
import { isProtectedGlassMaterial, validateMaterialEvidence } from "./material-validator.mjs";
import { chooseTextureCompression } from "./texture-compression.mjs";
import { transferNormalizedProviderPbr } from "./normalized-pbr-transfer.mjs";

function providerMaterialFor(original, providerMaterials, primitiveIndex) {
	const sameName = providerMaterials.find((material) => material.getName() === original?.getName());
	if (sameName) return sameName;
	if (providerMaterials.length === 1) return providerMaterials[0];
	return providerMaterials[primitiveIndex] ?? null;
}

function addProviderExtensions(target, source) {
	const targetNames = new Set(target.getRoot().listExtensionsUsed().map((extension) => extension.extensionName));
	for (const extension of source.getRoot().listExtensionsUsed()) {
		if (targetNames.has(extension.extensionName)) continue;
		const copied = target.createExtension(extension.constructor);
		if (extension.isRequired()) copied.setRequired(true);
		targetNames.add(extension.extensionName);
	}
}

export async function rebuildTexturedGlb({ authoritativeGlb, preparedUvGlb, providerGlb, outputGlb, signal }) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	const io = new NodeIO();
	const authoritative = await io.read(resolve(authoritativeGlb));
	const prepared = await io.read(resolve(preparedUvGlb));
	const provider = await io.read(resolve(providerGlb));
	prepared.setLogger(new Logger(Logger.Verbosity.SILENT));
	const preparedGeometry = validateGeometryLock(authoritative, prepared);
	if (!preparedGeometry.accepted) throw new TexturingError("PREPARED_GEOMETRY_MISMATCH", "Locally prepared UV GLB changed authoritative geometry", preparedGeometry);
	const providerGeometry = validateGeometryLock(authoritative, provider);
	const providerEvidence = await extractPbrEvidence(providerGlb);
	const supportsNormalizedTransfer = [prepared, provider].every((document) => {
		const names = new Set(document.getRoot().listMeshes().map((mesh) => mesh.getName()));
		return names.has("exact-mass") && names.has("facade-details");
	});
	if (!providerGeometry.accepted && !supportsNormalizedTransfer) {
		throw new TexturingError("PROVIDER_GEOMETRY_MISMATCH", "Provider GLB changed authoritative geometry", providerGeometry);
	}
	const normalizedTransfer = !providerGeometry.accepted;
	const providerMaterial = validateMaterialEvidence(providerEvidence, normalizedTransfer ? {
		minimumTextureSize: 0,
		requiredMaterialNames: ["facade-details_material"],
		requiredPbrSlots: ["baseColor", "metallicRoughness", "normal"],
		warnMissingSlots: ["occlusion"],
	} : undefined);
	if (!providerMaterial.accepted) throw new TexturingError("PROVIDER_MATERIAL_INVALID", "Provider PBR evidence failed validation", providerMaterial);

	let transfer = { status: "accepted", mode: "direct", matchedPrimitives: null };
	if (normalizedTransfer) {
		transfer = { ...await transferNormalizedProviderPbr({ prepared, provider }), mode: "normalized-safe-primitives" };
	} else {
		addProviderExtensions(prepared, provider);
		const providerMaterials = provider.getRoot().listMaterials();
		const resolver = createDefaultPropertyResolver(prepared, provider);
		const copiedProperties = copyToDocument(prepared, provider, providerMaterials, resolver);
		let primitiveIndex = 0;
		for (const mesh of prepared.getRoot().listMeshes()) {
			for (const primitive of mesh.listPrimitives()) {
				const original = primitive.getMaterial();
				if (original && isProtectedGlassMaterial(original)) {
					primitiveIndex += 1;
					continue;
				}
				const sourceMaterial = providerMaterialFor(original, providerMaterials, primitiveIndex);
				const copiedMaterial = sourceMaterial ? copiedProperties.get(sourceMaterial) : null;
				if (!copiedMaterial) throw new TexturingError("PBR_MATERIAL_MAPPING_FAILED", `No provider material maps to primitive ${primitiveIndex}`);
				primitive.setMaterial(copiedMaterial);
				primitiveIndex += 1;
			}
		}
	}
	await prepared.transform(prune({
		propertyTypes: [PropertyType.MATERIAL, PropertyType.TEXTURE],
		keepAttributes: true,
		keepExtras: true,
		keepLeaves: true,
		keepSolidTextures: true,
	}));

	const outputPath = resolve(outputGlb);
	await mkdir(dirname(outputPath), { recursive: true });
	const temporaryPath = `${outputPath}.tmp-${process.pid}.glb`;
	try {
		await io.write(temporaryPath, prepared);
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		await rename(temporaryPath, outputPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
	const finalDocument = await io.read(outputPath);
	const finalGeometry = validateGeometryLock(authoritative, finalDocument);
	if (!finalGeometry.accepted) throw new TexturingError("FINAL_GEOMETRY_MISMATCH", "Rebuilt GLB changed authoritative geometry", finalGeometry);
	const finalEvidence = await extractPbrEvidence(outputPath);
	const finalMaterial = validateMaterialEvidence(finalEvidence, normalizedTransfer ? {
		minimumTextureSize: 2048,
		minimumUvCoverage: 0,
		requiredMaterialNames: ["facade-details_material"],
		requiredPbrSlots: ["baseColor", "metallicRoughness", "normal"],
		warnMissingSlots: ["occlusion"],
	} : undefined);
	if (!finalMaterial.accepted) throw new TexturingError("FINAL_MATERIAL_INVALID", "Rebuilt GLB failed PBR validation", finalMaterial);
	const bytes = await readFile(outputPath);
	return {
		outputGlb: outputPath,
		outputSha256: createHash("sha256").update(bytes).digest("hex"),
		outputBytes: bytes.length,
		geometry: finalGeometry,
		material: finalMaterial,
		transfer,
		compression: chooseTextureCompression({ ktx2Encoder: null }).mode,
	};
}
