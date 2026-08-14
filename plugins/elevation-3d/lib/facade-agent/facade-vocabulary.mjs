/**
 * The facade terminal vocabulary, declared once.
 *
 * A terminal has to agree in four places: the word the model may write, the primitive
 * kind the derivation emits, the material the renderer draws it in, and the kind the
 * presentation validator accepts. Those four lists were kept by hand and had already
 * drifted - lintel, sill and cornice were plumbed all the way through the renderer and
 * the validator while the grammar had no word for them, so the model could not put a
 * top on the building even though the pipeline was waiting to receive one. Everything
 * downstream now reads this table, and a drift test holds the four in agreement.
 *
 * This module is a leaf on purpose. Both the low-level geometry builder and the
 * high-level grammar depend on it, so it must not depend on either.
 */

/**
 * `word` is what the grammar may write, `kind` is the primitive it becomes, `material`
 * is the role it renders in, and `purpose` is what the model is told it is for.
 * A `kind` of null means the terminal emits no geometry.
 */
export const TERMINAL_VOCABULARY = Object.freeze([
	Object.freeze({ word: "wall", kind: null, material: null, purpose: "leave the wall bare; emits nothing" }),
	Object.freeze({ word: "glass", kind: "window", material: "glass", purpose: "a glazed opening" }),
	Object.freeze({ word: "door", kind: "door", material: "glass", purpose: "the one primary entrance" }),
	Object.freeze({ word: "reveal", kind: "reveal", material: "window-frame", purpose: "a jamb or head returning into an opening" }),
	Object.freeze({ word: "lintel", kind: "lintel", material: "precast", purpose: "the head that carries over an opening" }),
	Object.freeze({ word: "sill", kind: "sill", material: "precast", purpose: "the shelf an opening sits on" }),
	Object.freeze({ word: "band", kind: "band", material: "precast", purpose: "a string course running across the wall" }),
	Object.freeze({ word: "cornice", kind: "cornice", material: "precast", purpose: "the projecting course that terminates the building at the top" }),
	Object.freeze({ word: "pilaster", kind: "pilaster", material: "brick", purpose: "a vertical pier standing proud of the wall" }),
]);

/** Every word the grammar may write, `wall` included. */
export const TERMINAL_WORDS = Object.freeze(TERMINAL_VOCABULARY.map((terminal) => terminal.word));

/** Grammar word to primitive kind, for the terminals that emit geometry. */
export const TERMINAL_KINDS = Object.freeze(Object.fromEntries(
	TERMINAL_VOCABULARY.filter((terminal) => terminal.kind).map((terminal) => [terminal.word, terminal.kind]),
));

/** Primitive kind to material role, which is what the renderer keys off. */
export const TERMINAL_MATERIALS = Object.freeze(Object.fromEntries(
	TERMINAL_VOCABULARY.filter((terminal) => terminal.kind).map((terminal) => [terminal.kind, terminal.material]),
));

/** Every primitive kind a derived grammar can produce. */
export const TERMINAL_PRIMITIVE_KINDS = Object.freeze(Object.values(TERMINAL_KINDS));
