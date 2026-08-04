const REQUIRED_PBR_SLOTS = ["baseColor", "metallicRoughness", "normal", "occlusion"];

function isProtectedGlass(material) {
	return material.alphaMode === "BLEND" || /glass|glaz/i.test(material.name);
}

export function validateMaterialEvidence(evidence, {
	minimumTextureSize = 2048,
	minimumUvCoverage = 0.98,
	requiredMaterialNames = null,
	requiredPbrSlots = REQUIRED_PBR_SLOTS,
	warnMissingSlots = [],
} = {}) {
	const reasons = [];
	const warnings = [];
	if (!evidence || !Array.isArray(evidence.materials) || evidence.materials.length === 0) reasons.push("PBR_MATERIALS_MISSING");
	const materials = (evidence?.materials ?? []).filter((material) => !requiredMaterialNames || requiredMaterialNames.includes(material.name));
	for (const name of requiredMaterialNames ?? []) {
		if (!materials.some((material) => material.name === name)) reasons.push("REQUIRED_PBR_MATERIAL_MISSING");
	}
	for (const material of materials) {
		if (isProtectedGlass(material)) continue;
		if (requiredPbrSlots.some((slot) => !material.slots.includes(slot))) reasons.push("REQUIRED_PBR_CHANNEL_MISSING");
		if (warnMissingSlots.some((slot) => !material.slots.includes(slot))) warnings.push("OPTIONAL_PBR_CHANNEL_MISSING");
	}
	for (const texture of evidence?.textures ?? []) {
		if (/^https?:/i.test(texture.uri) || !texture.embedded) reasons.push("EXTERNAL_TEXTURE_URI");
		if (Math.max(texture.width, texture.height) < minimumTextureSize) reasons.push("TEXTURE_RESOLUTION_TOO_LOW");
		if (new Set(texture.colorSpaces).size > 1) reasons.push("TEXTURE_COLOR_SPACE_CONFLICT");
		if (!["image/png", "image/webp", "image/jpeg"].includes(texture.mimeType)) reasons.push("TEXTURE_MIME_TYPE_UNSUPPORTED");
	}
	if (!Number.isFinite(evidence?.uvCoverage) || evidence.uvCoverage < minimumUvCoverage) reasons.push("UV_COVERAGE_TOO_LOW");
	const uniqueReasons = [...new Set(reasons)];
	const uniqueWarnings = [...new Set(warnings)];
	return {
		accepted: uniqueReasons.length === 0,
		status: uniqueReasons.length > 0 ? "rejected" : uniqueWarnings.length > 0 ? "review" : "accepted",
		reasons: uniqueReasons,
		...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
	};
}

export function isProtectedGlassMaterial(material) {
	return material.getAlphaMode() === "BLEND" || /glass|glaz/i.test(material.getName());
}
