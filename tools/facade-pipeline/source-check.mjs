/**
 * Read the photograph a grammar says it transcribes, and say how far the drawing is from it.
 *
 * These two coarse statistics are a necessary gate, not proof of geometric fidelity.
 * Missing source evidence and failed comparisons reject a claimed transcription.
 * A transcription's whole claim is the photograph, and until now the pipeline never
 * opened the file. Both measurements below were checked against three runs a person had
 * already judged - the one they called the same building comes back clean, the one they called
 * not the same trips both, and the one they called roughly trips one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compareToSource } from "../../plugins/elevation-3d/lib/source-fidelity.mjs";

/** What each code means to an author, in the words the fault should be repaired in. */
const EXPLANATIONS = Object.freeze({
	SOURCE_COLOUR_INVENTED: "the drawing's boldest surface is far more saturated than anything in the photograph - a material was declared a hue the photograph does not have",
	SOURCE_VARIATION_LOST: "the photograph changes markedly along its length and the drawing does not - whatever varies across that facade did not survive into the geometry",
	SOURCE_COMPARISON_EMPTY: "one of the two pictures had no subject to measure",
});

export async function compareDrawingToSource({ runDir, grammar, heroPath } = {}) {
	const named = grammar?.source_photograph;
	if (!named || !heroPath) return {};
	try {
		const sharp = (await import("sharp")).default;
		const load = async (path) => {
			const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
			return { rgb: data, width: info.width, height: info.height };
		};
		await readFile(join(runDir, named));
		const compared = compareToSource({
			photograph: await load(join(runDir, named)),
			drawing: await load(heroPath),
		});
		return {
			source_fidelity: {
				accepted: compared.codes.length === 0,
				checked: true,
				photograph: named,
				codes: compared.codes,
				says: compared.codes.map((code) => EXPLANATIONS[code] ?? code),
				boldness_ratio: compared.measurements.boldness_ratio,
				lateral_spread_ratio: compared.measurements.lateral_spread_ratio,
			},
		};
	} catch (error) {
		// Rendering may have succeeded, but a claimed transcription cannot pass
		// without readable source evidence.
		return { source_fidelity: { accepted: false, checked: false, codes: ["SOURCE_IMAGE_UNREADABLE"], photograph: named, unread: String(error?.message ?? error).slice(0, 160) } };
	}
}
