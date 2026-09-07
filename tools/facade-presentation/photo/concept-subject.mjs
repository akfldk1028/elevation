/**
 * The subject line a concept commission hands the image model, built from the mass.
 *
 * The standard lane is MASS -> PERSPECTIVE -> DRAWING, and the perspective is only usable
 * if the image model obeys the mass: a five-storey prism that comes back as a twenty-storey
 * tower cannot be transcribed by any five-storey drawing. The facts that hold it - storey
 * count, height, facet count, whether it touches the ground - were typed by hand into every
 * commission so far, and one of them was typed wrong. They are all in the prepared context,
 * so they are read from it here, once, and the commissioner supplies only the idea.
 *
 * The idea is passed through verbatim. It is the open brief - the constraint and the
 * question - and this module must not add a style, a palette or a material to it.
 */

/**
 * @param {{storeys: Array<{z_min:number, z_max:number}>, facade_segments: Array<{ground_access?: boolean}>}} context
 * @returns {{storeys: number, height_m: number, storey_height_m: number, facets: number, facets_on_ground: number}}
 */
export function massFacts(context) {
	const storeys = context?.storeys ?? [];
	const segments = context?.facade_segments ?? [];
	if (storeys.length === 0 || segments.length === 0) {
		throw new Error("massFacts needs a prepared context with storeys and facade_segments");
	}
	const height = Math.max(...storeys.map((storey) => storey.z_max));
	const storeyHeight = (storeys[0].z_max - storeys[0].z_min);
	return {
		storeys: storeys.length,
		height_m: Number(height.toFixed(2)),
		storey_height_m: Number(storeyHeight.toFixed(2)),
		facets: segments.length,
		facets_on_ground: segments.filter((segment) => segment.ground_access !== false).length,
	};
}

/**
 * @param {{context: object, idea: string}} input
 * @returns {string} one subject sentence group: the mass as facts, then the idea verbatim
 */
export function buildConceptSubject({ context, idea }) {
	if (typeof idea !== "string" || idea.trim() === "") {
		throw new Error("a concept needs an idea - the open brief for the facade, in the commissioner's words");
	}
	const facts = massFacts(context);
	const ground = facts.facets_on_ground === facts.facets
		? "standing on the ground along its whole perimeter"
		: `touching the ground on only ${facts.facets_on_ground} of its ${facts.facets} facets, the rest of its underside above grade`;
	return [
		"An architectural photograph of EXACTLY this building:",
		`a ${facts.facets}-facet faceted mass EXACTLY ${facts.height_m} METRES TALL and EXACTLY ${facts.storeys} STOREYS`,
		`of ${facts.storey_height_m} m each, ${ground}.`,
		"Its silhouette, storey count and facets are fixed and must not change.",
		`The facade: ${idea.trim()}`,
	].join(" ");
}
