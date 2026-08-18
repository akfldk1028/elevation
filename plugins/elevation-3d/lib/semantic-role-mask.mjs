/**
 * The four palette roles, the ID colours the material pass paints them with, and the one
 * reader that turns those pixels back into role counts.
 *
 * This is a leaf module for the same reason `facade-vocabulary.mjs` is one. The table lived
 * in four places - the PBR presentation, the competition elevation, the presentation
 * validator and the render-style evidence - and two of them drifted apart. `61d457f` is what
 * that cost: the competition views had kept their own lookup, it matched on the glTF material
 * name instead of the primitive kind, brick came out near-black and every band was painted
 * wall-tone and vanished. Nothing failed loudly; the drawings were simply wrong.
 *
 * The thresholds are deliberately wide. The mask is rendered with flat unlit colour, so a
 * pixel is either a role or it is background, and the slack absorbs edge antialiasing without
 * ever letting two roles overlap: each channel test excludes the other three primaries.
 */
export const SEMANTIC_ROLE_IDS = Object.freeze({
	concrete: Object.freeze([255, 0, 0]),
	glass: Object.freeze([0, 255, 0]),
	bronze: Object.freeze([0, 0, 255]),
	opaque: Object.freeze([255, 255, 0]),
});

export const SEMANTIC_ROLES = Object.freeze(Object.keys(SEMANTIC_ROLE_IDS));

/** The same colours as 0xRRGGBB, for three.js material construction. */
export const SEMANTIC_ROLE_COLORS = Object.freeze(Object.fromEntries(
	Object.entries(SEMANTIC_ROLE_IDS).map(([role, [r, g, b]]) => [role, (r << 16) | (g << 8) | b]),
));

/** Every role at zero. A caller that builds this literal by hand is how the fifth role gets missed. */
export function emptyRoleCounts() {
	return Object.fromEntries(SEMANTIC_ROLES.map((role) => [role, 0]));
}

/** The role a single mask pixel carries, or null for background. */
export function classifyRolePixel(red, green, blue) {
	if (red > 200 && green < 80 && blue < 80) return "concrete";
	if (green > 200 && red < 80 && blue < 80) return "glass";
	if (blue > 200 && red < 80 && green < 80) return "bronze";
	if (red > 180 && green > 180 && blue < 80) return "opaque";
	return null;
}

/**
 * Count the roles in an RGB buffer. `pixels` bounds the read for callers that pass a buffer
 * larger than the image; omitting it reads the whole thing.
 */
export function countRolePixels(raw, pixels = null) {
	const counts = emptyRoleCounts();
	const end = pixels === null ? raw.length : pixels * 3;
	for (let offset = 0; offset < end; offset += 3) {
		const role = classifyRolePixel(raw[offset], raw[offset + 1], raw[offset + 2]);
		if (role) counts[role] += 1;
	}
	return counts;
}
