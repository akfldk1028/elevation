import assert from "node:assert/strict";
import test from "node:test";

import {
	BOLDNESS_MARGIN,
	BOLDNESS_RATIO,
	boldestSurface,
	compareToSource,
	lateralSpread,
	subjectColour,
} from "../plugins/elevation-3d/lib/source-fidelity.mjs";

/**
 * The one check that reads the photograph.
 *
 * `source_photograph` had eleven uses in this engine and every one spent it turning a gate
 * OFF; nothing opened the file. Eight gates checked a drawing against itself and accepted one
 * that was brown where its photograph was grey and one flat note where its photograph ran
 * from shut to open.
 */
const W = 60, H = 40;

/** A picture: a background, and a subject painted by a function of x. */
function picture(background: number[], subject: (x: number) => number[] | null) {
	const rgb = Buffer.alloc(W * H * 3);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const inside = y >= 6 && y < H - 6 && x >= 4 && x < W - 4;
		const colour = (inside ? subject(x) : null) ?? background;
		rgb.set(colour, (y * W + x) * 3);
	}
	return { rgb, width: W, height: H };
}

const paper = [250, 250, 247];
const grey = () => [96, 96, 96];

test("the subject is read from the body of the picture, not the whole frame", () => {
	// A mean over everything cannot tell a grey building on warm sand from a brown building on
	// white paper: the ground pulls the photograph's average to exactly where the drawing's
	// material sits. Reading the darker half - which is where a building is - separates them.
	const onSand = picture([214, 190, 160], grey);
	const measured = subjectColour(onSand.rgb);
	assert.ok(measured.chroma < 6, `a neutral subject must read neutral, got ${measured.chroma}`);
	assert.ok(measured.lightness < 140, "the body is the darker half");
});

test("the boldest surface is the one that covers a real share, not a fringe", () => {
	// A salmon pier across a facade is a surface; two antialiased pixels are not.
	const withPier = picture(paper, (x) => (x % 6 === 0 ? [216, 160, 112] : [96, 96, 96]));
	const bold = boldestSurface(withPier.rgb);
	assert.ok(bold, "a subject has a boldest surface");
	assert.ok(bold!.chroma > 80, `the pier is the boldest, got ${bold!.chroma}`);
	assert.ok(bold!.share >= 0.02);

	const speck = picture(paper, (x) => (x === 30 ? [255, 0, 0] : [96, 96, 96]));
	assert.ok((boldestSurface(speck.rgb)?.chroma ?? 0) < 20, "one bright column is a fringe, not a material");
});

test("a colour the drawing has and the photograph does not is reported", () => {
	const photograph = picture(paper, grey);
	const drawing = picture(paper, (x) => (x % 6 === 0 ? [216, 160, 112] : [104, 84, 72]));
	const { codes, measurements } = compareToSource({ photograph, drawing });

	assert.ok(codes.includes("SOURCE_COLOUR_INVENTED"), codes.join(","));
	// Against a perfectly neutral photograph the RATIO is undefined - which is the very case
	// this exists for - so the margin is what carries it.
	assert.equal(measurements.boldness_ratio, null);
	assert.ok((measurements.boldness_margin ?? 0) >= BOLDNESS_MARGIN);
	// And where the photograph does have colour, the ratio is formed and the check uses it.
	const warmPhotograph = picture(paper, () => [120, 104, 96]);
	const warmer = compareToSource({ photograph: warmPhotograph, drawing });
	assert.ok((warmer.measurements.boldness_ratio ?? 0) >= BOLDNESS_RATIO, String(warmer.measurements.boldness_ratio));
	// And the same building drawn in the same neutral does not trip it.
	assert.ok(!compareToSource({ photograph, drawing: picture(paper, () => [104, 104, 104]) })
		.codes.includes("SOURCE_COLOUR_INVENTED"));
	assert.ok(BOLDNESS_MARGIN > 0);
});

test("a photograph that changes along its length, drawn as one note, is reported", () => {
	// The parametric failure: the photograph runs from near-shut to open across its width and
	// the drawing repeats one slot the whole way. Eight views accepted it.
	const photograph = picture(paper, (x) => { const t = (x - 4) / (W - 8); const v = Math.round(40 + t * 150); return [v, v, v]; });
	const flat = picture(paper, () => [110, 110, 110]);
	const { codes, measurements } = compareToSource({ photograph, drawing: flat });
	assert.ok(codes.includes("SOURCE_VARIATION_LOST"), codes.join(","));
	assert.ok((measurements.lateral_spread_ratio ?? 1) < 0.2);

	// A drawing that carries the change is not reported, so the check cannot simply always fire.
	const carried = picture(paper, (x) => { const t = (x - 4) / (W - 8); const v = Math.round(50 + t * 130); return [v, v, v]; });
	assert.deepEqual(compareToSource({ photograph, drawing: carried }).codes, []);
});

test("a photograph with nothing to vary is not held to a variation it never had", () => {
	// A flat grey photograph and a flat grey drawing agree. The check only speaks when the
	// SOURCE has a spread worth losing.
	const flat = picture(paper, grey);
	assert.deepEqual(compareToSource({ photograph: flat, drawing: picture(paper, () => [100, 100, 100]) }).codes, []);
	const spread = lateralSpread(flat.rgb, W, H);
	assert.ok(spread.spread < 12, `a flat subject has no lateral spread, got ${spread.spread}`);
});

test("the comparison needs both pictures and says so rather than guessing", () => {
	assert.throws(() => compareToSource({ photograph: picture(paper, grey) } as any), TypeError);
	const blank = { rgb: Buffer.alloc(W * H * 3, 255), width: W, height: H };
	assert.deepEqual(compareToSource({ photograph: blank, drawing: blank }).codes, ["SOURCE_COMPARISON_EMPTY"]);
});
