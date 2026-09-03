/**
 * A material an author DECLARES, and the numbers derived from it.
 *
 * The material list used to be four words - brick, precast, glass, window-frame - and an
 * author could only choose among them. A transcribing author copying a bronze rainscreen
 * had no word for it, wrote `brick` to borrow its hue, and said so: "that is a lie on a
 * construction document, and the drawing's blindness to material is the only reason it has
 * not cost me anything." Widening the enum would only postpone the same complaint; the
 * client's objection was to the shape, not to the size: "재료를 고르는 것도 이상해, LLM이
 * 판단하고 생성하는 건데."
 *
 * So a material is now something an author WRITES, in the terms an architect specifies one:
 * what substance it is, how light it is, how warm, how it takes light, and what module it
 * comes in. Every number the pipeline needs - the elevation fill, the PBR tint, roughness,
 * metalness, the gate role, the joint pitch - is DERIVED here from those words. The author
 * never writes a hex code or a unit float, and the engine never has to guess what a name
 * means.
 *
 * The axes are closed because they are the axes a specification actually has; the material
 * NAMES are open, because that is what was being enumerated. Add an axis when a declaration
 * cannot say something an author needs; do not add a material.
 */

/** How light the surface is. The scale is a facade's, not a paint chart's. */
const LIGHTNESS = Object.freeze({ dark: 0.16, "mid-dark": 0.34, mid: 0.55, pale: 0.78, white: 0.9 });
/** Where the colour sits, as an architect names it rather than as a hue angle. */
const HUE = Object.freeze({
	warm: { h: 22, s: 0.34 }, "warm-neutral": { h: 34, s: 0.12 }, neutral: { h: 40, s: 0.04 },
	"cool-neutral": { h: 205, s: 0.06 }, cool: { h: 205, s: 0.18 }, green: { h: 96, s: 0.16 },
});
/** How it takes light. Roughness first, then how much of the tint survives in the render. */
const FINISH = Object.freeze({
	matte: { roughness: 0.88, texture: 0.2, normal: 0.15 },
	honed: { roughness: 0.68, texture: 0.14, normal: 0.1 },
	satin: { roughness: 0.42, texture: 0.09, normal: 0.07 },
	polished: { roughness: 0.18, texture: 0.04, normal: 0.03 },
});
/**
 * What it IS. This is the only axis a gate reads: the presentation counts four semantic
 * roles and every declared material must land on one, so the substance carries that mapping
 * and nothing else in the declaration can move it.
 */
const SUBSTANCE = Object.freeze({
	masonry: { role: "opaque", metalness: 0, opacity: 1, joint_family: "coursed" },
	cast: { role: "concrete", metalness: 0, opacity: 1, joint_family: "unit-cast" },
	stone: { role: "concrete", metalness: 0, opacity: 1, joint_family: "coursed" },
	sheet: { role: "opaque", metalness: 0.55, opacity: 1, joint_family: "panelised" },
	extrusion: { role: "bronze", metalness: 0.72, opacity: 1, joint_family: "running" },
	metal: { role: "bronze", metalness: 0.72, opacity: 1, joint_family: "panelised" },
	timber: { role: "opaque", metalness: 0, opacity: 1, joint_family: "boarded" },
	glazing: { role: "glass", metalness: 0, opacity: 0.42, joint_family: "per-opening" },
});

export const DECLARED_MATERIAL_AXES = Object.freeze({
	substance: Object.freeze(Object.keys(SUBSTANCE)),
	lightness: Object.freeze(Object.keys(LIGHTNESS)),
	hue: Object.freeze(Object.keys(HUE)),
	finish: Object.freeze(Object.keys(FINISH)),
});

const ID = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The same rule as a JSON Schema string, because the emitted schema has to state it and a
 * second copy of a regex is how the schema drifts from the parser. The legacy words match
 * it too, so one pattern admits both a declared id and `precast`.
 */
export const DECLARED_MATERIAL_ID_PATTERN = ID.source;

function hex(h, s, l) {
	const f = (n) => {
		const k = (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const value = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
		return Math.round(255 * value).toString(16).padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Derive everything the pipeline needs from one declaration.
 *
 * `joint_m` is the module the material comes in, or null for a monolithic one. It is the
 * distinction the transcribing author argued carries more than colour does - "the
 * difference between sheet metal and cast concrete in a drawing has never been hue, it is
 * joint frequency" - so it is declared, not inferred from the substance.
 */
export function deriveDeclaredMaterial(declaration) {
	const fail = (message) => { throw new Error(`declared material invalid: ${message}`); };
	if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) fail("not an object");
	const { id, substance, lightness, hue, finish, joint_m = null, reads_as = null } = declaration;
	if (typeof id !== "string" || !ID.test(id)) fail("id");
	// An author may not reuse a role name as a material id: the two are printed side by side
	// in every diagnostic, and one that reads `glass/glass` explains nothing.
	for (const [axis, table] of [["substance", SUBSTANCE], ["lightness", LIGHTNESS], ["hue", HUE], ["finish", FINISH]]) {
		if (!Object.hasOwn(table, declaration[axis])) fail(`${id}.${axis} must be one of ${Object.keys(table).join(", ")}`);
	}
	// A material supplies the FAMILY of joint its substance comes in, and nothing more. The
	// module belongs to the member: the same precast is monolithic across a blade and one
	// unit per opening in a sill, and the same anodised extrusion is a mitred frame in a
	// window and a running length in a coping. An author who declared five materials warned
	// that deriving the module here "will draw sill joints across my blades and destroy the
	// one distinction that carries this building in greyscale."
	if (joint_m !== null && !(Number.isFinite(joint_m) && joint_m > 0.05 && joint_m <= 12)) fail(`${id}.joint_m`);
	// The specification prose. It was capped at 240 characters and the first author to write
	// a real one - "pressed aluminium tray, powder-coated red iron oxide, matte-satin; the
	// colour lives in the coating..." - was rejected by it. Asking for a specification and
	// then truncating it is the same closing move this field exists to undo; 1200 is a
	// paragraph, which is what a material entry in a real schedule gets.
	if (reads_as !== null && (typeof reads_as !== "string" || reads_as.length > 1200)) fail(`${id}.reads_as must be prose under 1200 characters`);
	const { role, metalness, opacity } = SUBSTANCE[substance];
	const { h, s } = HUE[hue];
	const light = LIGHTNESS[lightness];
	const surface = FINISH[finish];
	// The drawing is read in value first - it has to survive a greyscale print - so the fill
	// takes the declared lightness directly and the render tint sits a touch darker, where
	// the PBR pass adds its own light back.
	return Object.freeze({
		id, substance, lightness, hue, finish, joint_m, reads_as,
		role,
		elevation_fill: hex(h, s, light),
		axon_pbr: hex(h, s, Math.max(0.06, light - 0.06)),
		opacity, metalness,
		roughness: surface.roughness,
		texture_intensity: surface.texture,
		normal_intensity: surface.normal,
		// A jointed material draws its module; a monolithic one draws nothing. The renderer
		// reads this; the drawing gets its seams from it rather than from a hatch pattern
		// chosen for looking like a material.
		// The default a member inherits when it names no module of its own.
		joint_family: SUBSTANCE[substance].joint_family,
		joint: joint_m === null ? null : { pitch_m: joint_m },
		line_contrast: role === "glass" ? 0.58 : 0.78,
	});
}

export function deriveDeclaredMaterials(declarations) {
	if (!Array.isArray(declarations)) throw new Error("declared materials invalid: not a list");
	if (declarations.length > 8) throw new Error("declared materials invalid: a facade specifies a handful, not a catalogue");
	const derived = declarations.map(deriveDeclaredMaterial);
	const ids = new Set(derived.map((material) => material.id));
	if (ids.size !== derived.length) throw new Error("declared materials invalid: duplicate id");
	return Object.freeze(derived);
}
