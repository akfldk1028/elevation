import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	SEMANTIC_ROLE_COLORS,
	SEMANTIC_ROLE_IDS,
	SEMANTIC_ROLES,
	classifyRolePixel,
	countRolePixels,
	emptyRoleCounts,
} from "../plugins/elevation-3d/lib/semantic-role-mask.mjs";
import { KIND_ROLES } from "../plugins/elevation-3d/web/embedded-pbr-presentation.mjs";

// This table lived in four places and two of them drifted. 61d457f is what that cost: the
// competition views had kept their own lookup, brick came out near-black and every band was
// painted wall-tone and vanished, with nothing failing loudly. The consumers all read the leaf
// module now, and these hold them to it.
const CONSUMERS = [
	"plugins/elevation-3d/lib/elevation-presentation-validation.mjs",
	"plugins/elevation-3d/lib/competition-elevation.mjs",
	"plugins/elevation-3d/lib/texturing/render-style-evidence.mjs",
	"plugins/elevation-3d/web/embedded-pbr-presentation.mjs",
];

test("no consumer keeps its own copy of the role table", async () => {
	for (const path of CONSUMERS) {
		const source = await readFile(path, "utf8");
		assert.match(source, /from "\.{1,2}\/(\.\.\/)?(lib\/)?semantic-role-mask\.mjs"/,
			`${path} does not read the shared role table`);
		// The literals that used to be the drift. Any of them reappearing is a second copy.
		assert.doesNotMatch(source, /concrete:\s*0,\s*glass:\s*0,\s*bronze:\s*0,\s*opaque:\s*0/, path);
		assert.doesNotMatch(source, /concrete:\s*\[255,\s*0,\s*0\]/, path);
		assert.doesNotMatch(source, /concrete:\s*0xff0000/, path);
	}
});

test("the ID colours and the hex colours are one table", () => {
	assert.deepEqual(SEMANTIC_ROLES, ["concrete", "glass", "bronze", "opaque"]);
	for (const role of SEMANTIC_ROLES) {
		const [red, green, blue] = SEMANTIC_ROLE_IDS[role];
		assert.equal(SEMANTIC_ROLE_COLORS[role], (red << 16) | (green << 8) | blue, role);
		// Every role's own ID colour must classify back to itself, or the mask cannot be read.
		assert.equal(classifyRolePixel(red, green, blue), role, role);
	}
});

test("a role that carries no pixels still appears in the counts", () => {
	// MATERIAL_ROLE_MISSING reads `> 0` per role, so a missing key and a zero count are not the
	// same thing: `undefined > 0` is false either way, but a missing key hides which role it was.
	assert.deepEqual(Object.keys(emptyRoleCounts()).sort(), [...SEMANTIC_ROLES].sort());
	const blank = countRolePixels(Uint8Array.from([0, 0, 0, 10, 10, 10]));
	assert.deepEqual(blank, emptyRoleCounts());
});

test("counting respects the pixel bound and ignores background", () => {
	const raw = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 9, 9, 9]);
	assert.deepEqual(countRolePixels(raw), { concrete: 1, glass: 1, bronze: 1, opaque: 1 });
	// The competition path passes a buffer longer than the image and bounds it by pixel count.
	assert.deepEqual(countRolePixels(raw, 2), { concrete: 1, glass: 1, bronze: 0, opaque: 0 });
});

test("every kind the palette maps names a role the mask can read", () => {
	for (const [kind, role] of Object.entries(KIND_ROLES)) {
		assert.ok(SEMANTIC_ROLES.includes(role), `${kind} maps to ${role}, which is not a role`);
	}
});
