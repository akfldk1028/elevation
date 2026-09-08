/**
 * The one check that reads the photograph.
 *
 * `source_photograph` had eleven uses in this engine and every one of them either parsed the
 * name or spent it turning a gate OFF. Nothing opened the file. So the project's own top rule
 * - a run is finished when a person shown the photograph and the drawing agrees they are the
 * same building - was enforced by nobody except a human, while 854 tests and eight gates
 * checked the drawing against itself. Naming the photograph made the pipeline LESS strict.
 *
 * This measures the two pictures on the same axes and reports the difference. It cannot say
 * "same building"; that judgement stays a person's. It says the narrow, checkable things that
 * have actually gone wrong here, each of which passed every existing gate:
 *
 * - COLOUR. A transcription of a neutral grey building declared a warm wall and drew it
 *   brown. Measured: the photograph's wall at chroma 0 and R-B 0, the drawing's at chroma 32
 *   with piers at 96. Nothing objected, because no gate had the photograph to object with.
 * - CONTRAST. The same run drew narrow slots at one contrast the whole way along a facade
 *   whose photograph runs from near-solid to fully glazed.
 *
 * Both are read from the pixels of the two images rather than from anything the author says
 * about them, because what the author says about them is the thing that was wrong.
 */

/** Below this a pixel is the drawing's paper or the photograph's sky; above it, a highlight. */
const BACKGROUND_LUMINANCE = 232;
const SHADOW_LUMINANCE = 14;
/**
 * How much more saturated the drawing's boldest surface may be than the photograph's.
 *
 * A MEAN was tried first and does not work, which is worth recording because it looks like it
 * should. Averaged over the subject, a neutral grey building on warm sand paving and a brown
 * building on white paper land within 4 of each other: the photograph's ground pulls its mean
 * up to exactly where the drawing's material sits, and a person looking at the two pictures
 * can see they are different colours while the statistic says they are not.
 *
 * What does separate them is the boldest surface that covers a real share of the subject. On
 * the pair that prompted this the photograph's is chroma 48 and the drawing's is 96 - the
 * drawing has a salmon pier with no counterpart anywhere in the photograph. So the question
 * this asks is not "is the average colour right" but "did the drawing invent a colour the
 * photograph does not have", which is the failure that actually happens: an author reads a
 * neutral wall, declares it warm, and every gate passes.
 */
export const BOLDNESS_RATIO = 1.6;
/** And a floor, so two nearly-grey pictures cannot trip it on a few counts of noise. */
export const BOLDNESS_MARGIN = 24;
/** A colour has to cover this much of the subject to count as a surface rather than a fringe. */
export const SURFACE_SHARE = 0.02;

/**
 * The subject's own colour, ignoring what is behind it and what is blown out.
 *
 * @param {Uint8Array|Buffer} rgb raw RGB, three bytes a pixel
 * @returns {{pixels: number, lightness: number, chroma: number, warmth: number}}
 */
export function subjectColour(rgb) {
	// The BODY of the subject, not the picture. A first version averaged every pixel that was
	// neither paper nor shadow and could not tell a neutral grey building on warm sand from a
	// brown building on white: the photograph's paving pulled its chroma from 0 to 20 and the
	// two pictures landed within 5 of each other while a person could see they were different
	// colours. A building sits in the darker half of its own picture - below sky, below
	// paving, below every highlight - so the colour is read there.
	const kept = [];
	for (let offset = 0; offset < rgb.length; offset += 3) {
		const luminance = 0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2];
		if (luminance >= BACKGROUND_LUMINANCE || luminance <= SHADOW_LUMINANCE) continue;
		kept.push(offset);
	}
	if (!kept.length) return { pixels: 0, lightness: 0, chroma: 0, warmth: 0 };
	const luminanceAt = (offset) => 0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2];
	const median = kept.map(luminanceAt).sort((left, right) => left - right)[Math.floor(kept.length / 2)];
	const body = kept.filter((offset) => luminanceAt(offset) <= median);
	let lightness = 0, chroma = 0, warmth = 0;
	for (const offset of body) {
		const r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2];
		lightness += luminanceAt(offset);
		chroma += Math.max(r, g, b) - Math.min(r, g, b);
		warmth += r - b;
	}
	return {
		pixels: body.length,
		lightness: Number((lightness / body.length).toFixed(2)),
		chroma: Number((chroma / body.length).toFixed(2)),
		warmth: Number((warmth / body.length).toFixed(2)),
	};
}

/**
 * The most saturated surface that covers a real share of the subject.
 *
 * Colours are bucketed coarsely so one shaded wall reads as one surface rather than as a
 * hundred near-neighbours, and anything under `SURFACE_SHARE` is a fringe, a highlight or an
 * antialiased edge rather than something a person would call a material.
 *
 * @returns {{chroma: number, warmth: number, share: number, rgb: number[]}|null}
 */
export function boldestSurface(rgb) {
	const counts = new Map();
	let subject = 0;
	for (let offset = 0; offset < rgb.length; offset += 3) {
		const r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2];
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		if (luminance >= BACKGROUND_LUMINANCE || luminance <= SHADOW_LUMINANCE) continue;
		subject += 1;
		const key = `${Math.round(r / 24) * 24},${Math.round(g / 24) * 24},${Math.round(b / 24) * 24}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (!subject) return null;
	let boldest = null;
	for (const [key, count] of counts) {
		const share = count / subject;
		if (share < SURFACE_SHARE) continue;
		const [r, g, b] = key.split(",").map(Number);
		const chroma = Math.max(r, g, b) - Math.min(r, g, b);
		if (!boldest || chroma > boldest.chroma) boldest = { chroma, warmth: r - b, share: Number(share.toFixed(4)), rgb: [r, g, b] };
	}
	return boldest;
}

/**
 * How much the subject's tone VARIES across the picture, left to right.
 *
 * A facade whose whole idea is that one end is shut and the other open reads as a large
 * difference between its ends; one drawn with a parameter too small to see does not. The
 * measure is deliberately coarse - the mean lightness of the subject in each of five vertical
 * bands, and the spread between the extreme bands - because it has to survive a photograph's
 * lighting and a drawing's flat fill on the same scale.
 *
 * @returns {{bands: number[], spread: number}}
 */
export function lateralSpread(rgb, width, height, bandCount = 5) {
	const sums = new Array(bandCount).fill(0), counts = new Array(bandCount).fill(0);
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		const offset = (y * width + x) * 3;
		const luminance = 0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2];
		if (luminance >= BACKGROUND_LUMINANCE || luminance <= SHADOW_LUMINANCE) continue;
		const band = Math.min(bandCount - 1, Math.floor((x / width) * bandCount));
		sums[band] += luminance; counts[band] += 1;
	}
	const bands = sums.map((sum, index) => (counts[index] ? Number((sum / counts[index]).toFixed(2)) : 0));
	const seen = bands.filter((_, index) => counts[index] > 0);
	return { bands, spread: seen.length > 1 ? Number((Math.max(...seen) - Math.min(...seen)).toFixed(2)) : 0 };
}

/**
 * Compare a concept photograph with the drawing made from it.
 *
 * @param {{photograph: {rgb, width, height}, drawing: {rgb, width, height}}} input
 * @returns {{codes: string[], measurements: object}}
 */
export function compareToSource({ photograph, drawing } = {}) {
	if (!photograph?.rgb || !drawing?.rgb) throw new TypeError("both the photograph and the drawing are required");
	const source = subjectColour(photograph.rgb);
	const drawn = subjectColour(drawing.rgb);
	const sourceSpread = lateralSpread(photograph.rgb, photograph.width, photograph.height);
	const drawnSpread = lateralSpread(drawing.rgb, drawing.width, drawing.height);
	const sourceBold = boldestSurface(photograph.rgb);
	const drawnBold = boldestSurface(drawing.rgb);
	const codes = [];
	const measurements = {
		photograph: { ...source, lateral_spread: sourceSpread.spread, bands: sourceSpread.bands, boldest: sourceBold },
		drawing: { ...drawn, lateral_spread: drawnSpread.spread, bands: drawnSpread.bands, boldest: drawnBold },
		// The ratio is undefined against a perfectly neutral photograph - which is exactly the
		// case this check exists for - so the MARGIN is always reported and is what the fault
		// is decided on when the ratio cannot be formed.
		boldness_ratio: sourceBold && drawnBold && sourceBold.chroma > 0
			? Number((drawnBold.chroma / sourceBold.chroma).toFixed(3))
			: null,
		boldness_margin: sourceBold && drawnBold ? drawnBold.chroma - sourceBold.chroma : null,
		lateral_spread_ratio: sourceSpread.spread > 0
			? Number((drawnSpread.spread / sourceSpread.spread).toFixed(3))
			: null,
	};
	if (!source.pixels || !drawn.pixels) return { codes: ["SOURCE_COMPARISON_EMPTY"], measurements };
	// A colour the drawing has and the photograph does not. Fired on a run whose photograph's
	// boldest surface is chroma 48 and whose drawing put a salmon pier at 96 across the whole
	// facade, on a grammar every one of whose eight views was accepted.
	if (sourceBold && drawnBold
		&& drawnBold.chroma - sourceBold.chroma >= BOLDNESS_MARGIN
		// A neutral photograph makes the ratio undefined and the margin decisive: any bold
		// surface at all is a colour the photograph does not have.
		&& (sourceBold.chroma === 0 || drawnBold.chroma >= sourceBold.chroma * BOLDNESS_RATIO)) {
		codes.push("SOURCE_COLOUR_INVENTED");
	}
	// A facade whose photograph changes markedly along its length, drawn as one note. A fifth
	// of the photograph's own spread is the point at which a reader stops seeing the idea.
	if (measurements.lateral_spread_ratio !== null && sourceSpread.spread >= 12
		&& measurements.lateral_spread_ratio < 0.2) {
		codes.push("SOURCE_VARIATION_LOST");
	}
	return { codes, measurements };
}
