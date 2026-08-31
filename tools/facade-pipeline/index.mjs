/**
 * The elevation agent as one callable surface.
 *
 * Four steps, in the order the agent runs them: prepare a mass into a verified design
 * context, write the brief an author answers, hold an answer to the gates, render what
 * clears them. Everything after the authoring step is deterministic local code, which is
 * why an author reached any way at all - a paid provider, a subagent, a person - is held
 * to exactly the same standard.
 *
 * Nothing here is new logic. `writeGrammarBrief`, `checkAuthoredGrammar` and
 * `renderAuthoredFacade` have lived in `design/authoring-kit.mjs` for weeks; what did not
 * exist was a tracked place that names the four together and knows where the data is. The
 * scripts that did this were untracked, one per experiment, each with the roots typed into
 * it - so the agent could not be invoked as one thing, which is what it is.
 *
 * For the mass merge: the mass side needs to bring only a mass. `prepareFacadeContext`
 * takes a candidate id out of the dataset root; the one hard gate is that
 * `deriveFacadeSegmentsFromMass` must succeed and be byte-canonical, because a hand-built
 * segment authority is refused by design.
 */
export { REPO_ROOT, resolveRoots, runDirFor } from "./config.mjs";
export { prepareFacadeContext } from "./prepare.mjs";
export {
	writeGrammarBrief as writeFacadeBrief,
	checkAuthoredGrammar as checkFacadeGrammar,
	renderAuthoredFacade as renderFacadeScheme,
	REVEAL_FACADE_PRESENTATION_STYLE,
} from "../../plugins/elevation-3d/lib/facade-agent/design/authoring-kit.mjs";
