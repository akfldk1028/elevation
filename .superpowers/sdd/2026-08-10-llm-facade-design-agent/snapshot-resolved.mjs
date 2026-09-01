// Hash the resolved primitives of every retained grammar, so an engine change can be
// measured against all of them at once. One line per grammar: name, sha, codes, count.
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sha256, stableJson } from "../../../plugins/elevation-3d/lib/core.mjs";
import { parseFacadeDesign } from "../../../plugins/elevation-3d/lib/facade-agent/design/contract.mjs";
import { resolveFacadeProgram } from "../../../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import { validateResolvedFacadeProgram } from "../../../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "../../../plugins/elevation-3d/lib/facade-agent/design/context.mjs";
import { prepareFacadeContext } from "../../../tools/facade-pipeline/prepare.mjs";
import { runDirFor } from "../../../tools/facade-pipeline/config.mjs";

for (const candidateId of ["creative-013", "creative-004"]) {
	const dir = runDirFor(candidateId);
	const { context } = await prepareFacadeContext({ candidateId });
	const authority = readVerifiedFacadeDesignContextAuthority(context);
	const names = (await readdir(dir)).filter((f) => /^grammar-.*\.json$/.test(f)).sort();
	for (const name of names) {
		let line;
		try {
			const program = parseFacadeDesign(JSON.parse(await readFile(join(dir, name), "utf8")), { sourceAuthority: authority });
			const resolved = resolveFacadeProgram(program, context);
			const validation = validateResolvedFacadeProgram({ program, context, resolved });
			line = `${sha256(stableJson(resolved.primitives)).slice(0, 16)} codes=[${validation.codes.join(",")}] n=${resolved.primitives.length}`;
		} catch (error) {
			line = `THROWS ${String(error?.message ?? error).slice(0, 90)}`;
		}
		process.stdout.write(`${candidateId} ${basename(name).padEnd(38)} ${line}\n`);
	}
}
