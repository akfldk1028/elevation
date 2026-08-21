/**
 * Standalone showcase renderer: one presentation-quality 1920x1080 perspective
 * render of an already-compiled facade GLB. Expressive layer only - lives
 * OUTSIDE the validation chain, imports from plugins/ but never modifies them,
 * and shares no output with any gate.
 *
 * Usage: node cli.mjs <glb-path> <out-png-path>
 *          [--style brick|stone|sheer]
 *          [--wall brick|limestone|precast|darkpanel|zinc|wood]
 *          [--glass deep|clear|mirror]
 *          [--frame bronze|iron|white]
 *          [--mood golden|morning|overcast]
 *          [--face front|back|left|right|auto]
 *
 * Materials are independent decisions, so the look is four orthogonal axes:
 * --wall (procedural material of the mass/wall field), --glass (deep-set dark,
 * clear-in-frame, or mirror skin), --frame (metal finish), --mood (sun
 * azimuth/altitude/warmth, sky, exposure, camera height). --style is kept as
 * shorthand that sets the four axes to the historical pairings; explicit axis
 * flags override it. --face picks which side of the model the three-quarter
 * camera shows (default auto: the entrance face). No flags at all keeps the
 * original behavior byte-for-byte.
 */
import { AXIS_VALUES, validateAxisFlags, validateFace, validateStyle, mergeAxes } from "./axes.mjs";

// Pure parse: no process access, no side effects, throws on bad input.
export function parseShowcaseArgs(argv) {
	let styleName = "";
	let face = "auto";
	const axisFlags = { wall: "", glass: "", frame: "", mood: "" };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--style") styleName = argv[++i] ?? "";
		else if (argv[i] === "--wall") axisFlags.wall = argv[++i] ?? "";
		else if (argv[i] === "--glass") axisFlags.glass = argv[++i] ?? "";
		else if (argv[i] === "--frame") axisFlags.frame = argv[++i] ?? "";
		else if (argv[i] === "--mood") axisFlags.mood = argv[++i] ?? "";
		else if (argv[i] === "--face") face = argv[++i] ?? "";
		else positional.push(argv[i]);
	}
	const [glbPath, outPngPath] = positional;
	if (!glbPath || !outPngPath) {
		throw new Error(
			"usage: node cli.mjs <glb-path> <out-png-path> [--style brick|stone|sheer]"
			+ ` [--wall ${AXIS_VALUES.wall.join("|")}] [--glass ${AXIS_VALUES.glass.join("|")}]`
			+ ` [--frame ${AXIS_VALUES.frame.join("|")}] [--mood ${AXIS_VALUES.mood.join("|")}]`
			+ " [--face front|back|left|right|auto]",
		);
	}
	validateStyle(styleName);
	validateAxisFlags(axisFlags);
	validateFace(face);
	return { glbPath, outPngPath, axes: mergeAxes(styleName, axisFlags), face };
}

export async function runCli(argv) {
	const parsed = parseShowcaseArgs(argv);
	const { runShowcase } = await import("./host.mjs");
	await runShowcase(parsed);
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	await runCli(process.argv.slice(2));
}
