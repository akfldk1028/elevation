/**
 * Build a verified design context for a candidate mass.
 *
 * This is the one step of the pipeline that had no home in the library: brief, check and
 * render all live in `design/authoring-kit.mjs`, but the thing that turns a mass in the test
 * set into a context those three can consume existed only as an untracked script. Promoting
 * it is what makes the agent runnable from inside the repository rather than from a scratch
 * directory next to it.
 *
 * The evidence pack is the reason this is not a one-liner. `buildFacadeEvidencePack` returns a
 * plain record, and only `verifyFacadeEvidencePack` registers the pack in the verified-authority
 * map the design context reads - so a freshly built pack has to round-trip through verify, and
 * an existing one is verified in place, which is what makes this callable once per check run
 * without rebuilding anything.
 */
import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

import { loadCandidatePackage, sha256 } from "../../plugins/elevation-3d/lib/core.mjs";
import { buildFacadeDesignContext } from "../../plugins/elevation-3d/lib/facade-agent/design/context.mjs";
import { buildFacadeEvidencePack, verifyFacadeEvidencePack } from "../../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { deriveFacadeSegmentsFromMass } from "../../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import { resolveRoots, runDirFor } from "./config.mjs";

// A checker re-preparing an already prepared run passes the run's own files back in; Node's
// cp throws EINVAL on src === dest before errorOnExist can turn it into a skip.
const copyOnce = async (from, to) => (resolve(from) === resolve(to) ? undefined
	: cp(from, to, { force: false, errorOnExist: true })
		.catch((error) => { if (error.code !== "ERR_FS_CP_EEXIST" && error.code !== "EEXIST") throw error; }));

/**
 * @param {{candidateId: string, selectedGlb?: string, frontPng?: string, axonPng?: string,
 *          datasetRoot?: string, outputRoot?: string}} options
 * @returns {Promise<{runDir: string, candidate: object, context: object}>}
 */
export async function prepareFacadeContext({
	candidateId, selectedGlb, frontPng, axonPng, datasetRoot, outputRoot,
} = {}) {
	if (!candidateId) throw new TypeError("a candidate id is required");
	const roots = resolveRoots({ datasetRoot, outputRoot });
	const runDir = runDirFor(candidateId, { outputRoot: roots.outputRoot });
	await mkdir(runDir, { recursive: true });

	const loaded = await loadCandidatePackage(roots.datasetRoot, candidateId);
	const candidate = { ...loaded, facade_segment_authority: deriveFacadeSegmentsFromMass({ mesh: loaded.mesh }) };

	const manifestPath = join(runDir, "evidence", "evidence-manifest.json");
	const built = await readFile(manifestPath).then(() => true, () => false);
	if (!built) await buildFacadeEvidencePack({ input: candidate, runDir });
	const evidence = await verifyFacadeEvidencePack({ manifestPath, input: candidate });

	// A run that has already been prepared carries its own seeds, so re-preparing it needs no
	// arguments at all. Only the first preparation of a candidate has to be handed them.
	await copyOnce(selectedGlb ?? join(runDir, "selected.glb"), join(runDir, "selected.glb"));
	const thumbnails = [];
	for (const [view, source] of [["front", frontPng], ["axon", axonPng]]) {
		await copyOnce(source ?? join(runDir, `${view}.png`), join(runDir, `${view}.png`));
		const bytes = await readFile(join(runDir, `${view}.png`));
		const metadata = await sharp(bytes).metadata();
		thumbnails.push({ view, path: `${view}.png`, sha256: sha256(bytes), width: metadata.width, height: metadata.height });
	}

	const selectedBytes = await readFile(join(runDir, "selected.glb"));
	const context = await buildFacadeDesignContext({
		runDir, candidate, evidence,
		selectedGlb: { path: "selected.glb", sha256: sha256(selectedBytes) },
		technicalThumbnails: thumbnails,
	});
	return { runDir, candidate, context };
}
