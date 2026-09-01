/**
 * The facade terminal vocabulary, declared once.
 *
 * A terminal has to agree in five places: the word the model may write, the primitive
 * kind the derivation emits, the material the renderer draws it in, the kind the
 * presentation validator accepts, and the palette role the presentation paints it in.
 * Those lists were kept by hand and had already drifted - lintel, sill and cornice were
 * plumbed all the way through the renderer and the validator while the grammar had no
 * word for them, so the model could not put a top on the building even though the
 * pipeline was waiting to receive one. Everything downstream now reads this table, and a
 * drift test holds the five in agreement. The palette role is the one that cannot be
 * derived from here, because it is a decision about what the drawing should look like
 * rather than a name: a kind with no role falls silently through to `concrete`, which has
 * cost this codebase two debugging sessions, so the drift test insists on an entry.
 *
 * This module is a leaf on purpose. Both the low-level geometry builder and the
 * high-level grammar depend on it, so it must not depend on either.
 */

/**
 * `word` is what the grammar may write, `kind` is the primitive it becomes, `material`
 * is the role it renders in, `projection_m` is how far out of the wall it may stand, and
 * `purpose` is what the model is told it is for. A `kind` of null means the terminal
 * emits no geometry.
 *
 * `projection_m` used to be one number - `max_projection_m: 0.5` in the design context,
 * written as a literal and identical for a three-storey prism and anything else. Measuring
 * what fifty-three authored grammars actually wrote showed a single constant failing in
 * both directions at once. A transom never exceeded 0.12 m and a spandrel 0.24 m, so the
 * bound permitted a half-metre transom, which is not a transom. A cornice reached 0.48 m
 * and a pilaster 0.5 m, pressing the ceiling: at 0.5 m a pier is a rib and a cornice does
 * not overhang, so the two elements whose whole job is to project were the two the bound
 * forbade. One number cannot be right for a glazing bead and for the course that
 * terminates a building.
 *
 * The numbers below are construction depths, not observations - each is at or above what
 * the corpus used, and set by what the element is. They are a calibration and can be
 * argued with, which is the point: a single 0.5 could only be argued with as a whole,
 * where a cornice at 1.2 is a claim about cornices that someone can take issue with on
 * its own. Openings carry their depth from the reveal around them and several accepted
 * grammars leave them at zero, so `glass` and `door` bound the recess rather than a
 * projection.
 */
export const TERMINAL_VOCABULARY = Object.freeze([
	// `wall` emits no geometry, so its depth cannot project anything and the bound is only
	// here to keep the table total. Setting it to 0 rejected three accepted grammars over a
	// number with no effect, which is a restriction this change had no business adding.
	Object.freeze({ word: "wall", kind: null, material: null, projection_m: 0.5, purpose: "leave the wall bare; emits nothing" }),
	Object.freeze({ word: "glass", kind: "window", material: "glass", projection_m: 0.5, purpose: "a glazed opening" }),
	Object.freeze({ word: "door", kind: "door", material: "glass", projection_m: 0.5, purpose: "the one primary entrance" }),
	Object.freeze({ word: "reveal", kind: "reveal", material: "window-frame", projection_m: 0.6, purpose: "a jamb or head returning into an opening" }),
	Object.freeze({ word: "lintel", kind: "lintel", material: "precast", projection_m: 0.5, purpose: "the head that carries over an opening" }),
	Object.freeze({ word: "sill", kind: "sill", material: "precast", projection_m: 0.5, purpose: "the shelf an opening sits on" }),
	Object.freeze({ word: "band", kind: "band", material: "precast", projection_m: 0.5, purpose: "a string course running across the wall" }),
	// The one element whose job is to overhang. A cornice that projects no further than the
	// string course below it is not terminating anything.
	Object.freeze({ word: "cornice", kind: "cornice", material: "precast", projection_m: 1.2, purpose: "the projecting course that terminates the building at the top" }),
	Object.freeze({ word: "pilaster", kind: "pilaster", material: "brick", projection_m: 1, purpose: "a vertical pier standing proud of the wall" }),
	// Everything above is punched masonry: a hole cut in a wall, with a head, a shelf and
	// jamb returns. None of it can say a curtain wall - a continuous glazed skin hung in
	// front of the structure - so nine schemes came out in one architectural language
	// because that was the only language available. Three words are the minimum for the
	// other one: the two directions of the framing grid, and the panel that closes the
	// slab zone between one pane and the pane above.
	//
	// Deliberately not added. `curtainwall` as a single word: an assembly is what the
	// split rules already are, and a terminal that expanded into a grid would be the one
	// terminal that is not a rectangle. Louvre, balcony, canopy and projecting bay:
	// every primitive here is a box no deeper than BOUNDS.maxDepthM, which is 0.5 m, so a
	// balcony or a canopy cannot project far enough to be one and would be drawn as a
	// thick band. Those want geometry, not vocabulary. The arch wanted the same and got
	// it: `archGeometry` in punched-facade.mjs draws the word below as a curved band, so
	// it graduated from this list.
	// A fin mullion stands well proud of its glass; a transom is a profile between two panes
	// and a deep one would be a shelf; a spandrel closes the slab zone flush with the skin.
	Object.freeze({ word: "mullion", kind: "mullion", material: "window-frame", projection_m: 0.5, purpose: "a vertical framing member of a glazed skin, running past the floors" }),
	Object.freeze({ word: "transom", kind: "transom", material: "window-frame", projection_m: 0.25, purpose: "a horizontal framing member of a glazed skin, dividing one pane from the next" }),
	Object.freeze({ word: "spandrel", kind: "spandrel", material: "precast", projection_m: 0.35, purpose: "the opaque panel of a glazed skin that closes the slab zone between a window head and the sill above" }),
	// The one terminal that is not a box. Its rectangle is the arch's bounding frame: the
	// springing line is the rectangle's bottom edge, the crown touches the top, and the
	// geometry inside is a curved band - see archGeometry, which is what let this word in.
	Object.freeze({ word: "arch", kind: "arch", material: "precast", projection_m: 0.5, purpose: "a curved head spanning an opening: the rectangle you give it is the arch's bounding frame, springing at its bottom edge, crown at its top" }),
	// The screen layer. Unlike every terminal above, a louvre is ALLOWED to stand in front
	// of glass: it is not in the validator's collidable set, so a repeat of louvres over a
	// window is a layered screen, not a collision - the construction Kuma-style facades are
	// made of and the one the single-layer vocabulary could not say.
	Object.freeze({ word: "louvre", kind: "louvre", material: "window-frame", projection_m: 0.8, purpose: "a thin repeated screen member standing proud of the wall, allowed to pass in front of glass; a run of them is a layered screen" }),
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

/** Grammar word to how far it may stand out of the wall, in metres. */
export const TERMINAL_PROJECTION = Object.freeze(Object.fromEntries(
	TERMINAL_VOCABULARY.map((terminal) => [terminal.word, terminal.projection_m]),
));

/** Primitive kind to the same bound, which is what the validator keys off. */
export const KIND_PROJECTION = Object.freeze(Object.fromEntries(
	TERMINAL_VOCABULARY.filter((terminal) => terminal.kind).map((terminal) => [terminal.kind, terminal.projection_m]),
));

/**
 * The deepest anything may stand out of the wall. The design context reports this as
 * `max_projection_m`, where it used to be a literal; deriving it keeps that field true
 * without letting it be the bound that decides a cornice.
 */
export const MAX_TERMINAL_PROJECTION = Math.max(...TERMINAL_VOCABULARY.map((terminal) => terminal.projection_m));
