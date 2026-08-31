/**
 * Build the facade catalogue from a manifest, regenerating the whole page every time.
 *
 * The sheet this replaces grew by appending: every new scheme was another heredoc bolted
 * onto the end of an HTML file nobody could rebuild, so a scheme that changed left its old
 * section behind and the numbers beside it were whatever had been true the day they were
 * pasted. Here the page is a function of the manifest and of the grammars themselves - the
 * metrics are recomputed by the same gate the director applies, so a card cannot claim an
 * opening ratio its grammar does not have.
 *
 * Usage: node build-sheet.mjs [manifest.json] [out.html]
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkAuthoredGrammar } from "../../../plugins/elevation-3d/lib/facade-agent/design/authoring-kit.mjs";
import { resolveRoots } from "../../facade-pipeline/config.mjs";
import { prepareFacadeContext } from "../../facade-pipeline/prepare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Tracked code reached into an untracked scratch script for its context, and typed the
// output root in beside it. Both now come from the pipeline module, so the sheet builds
// wherever the agent's data is pointed.
const VERIFICATION_ROOT = resolveRoots().outputRoot;
const VIEWS = [["front", "front"], ["back", "back"], ["left", "left"], ["right", "right"]];

const exists = async (path) => access(path).then(() => true, () => false);

const escape = (value) => String(value ?? "")
	.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Elevation PNG for one view of a scheme, as a path relative to the sheet. */
function elevationPath(runRoot, renderDir, view) {
	return `${runRoot}/${renderDir}/technical-render/views/${view}/competition-elevation/${view}/${view}.png`;
}

function heroPath(runRoot, renderDir) {
	return `${runRoot}/${renderDir}/pbr-render/perspective-hero.png`;
}

/**
 * The numbers a reader chooses on. Recomputed from the grammar, never copied from a log.
 * A scheme whose grammar no longer passes says so on its own card rather than going quiet.
 */
function metricsOf(check) {
	if (!check?.metrics) return { rejected: check?.stage ?? "unknown" };
	const metrics = check.metrics;
	const skin = Object.values(metrics.skin_transparency_by_view ?? {});
	const constructions = Object.values(metrics.construction_by_view ?? {});
	const skinFaces = constructions.filter((value) => value === "skin").length;
	return {
		worstOpening: metrics.worst_opening_ratio,
		skin: skin.length ? `${Math.min(...skin).toFixed(2)}–${Math.max(...skin).toFixed(2)}` : null,
		construction: skinFaces === 0 ? "punched ×4" : skinFaces === constructions.length ? "skin ×4" : `skin ×${skinFaces} / punched ×${constructions.length - skinFaces}`,
		scale: metrics.scale_ratio,
		span: metrics.max_storey_span,
		openings: metrics.opening_count,
		primitives: check.primitives,
		kinds: check.kinds,
	};
}

function metricRow(metrics) {
	if (metrics.rejected) return `<p class="metrics rejected">grammar no longer clears the gates — stopped at ${escape(metrics.rejected)}</p>`;
	const cells = [
		["worst opening", `${(metrics.worstOpening * 100).toFixed(1)}%`],
		["construction", metrics.construction],
		metrics.skin ? ["skin transparency", metrics.skin] : null,
		["scale ratio", metrics.scale?.toFixed(2)],
		["storey span", metrics.span],
		["openings", metrics.openings],
		["primitives", metrics.primitives],
	].filter(Boolean);
	return `<dl class="metrics">${cells.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>`;
}

const STYLE = `
:root{--ink:#222;--muted:#666;--line:#ddd;--paper:#f4f2ec;--card:#fff}
*{box-sizing:border-box}
body{font-family:system-ui,'Malgun Gothic',sans-serif;background:var(--paper);color:var(--ink);margin:0;padding:28px}
h1{font-size:24px;margin:0 0 6px}
p.sub{color:var(--muted);font-size:13.5px;margin:0 0 26px;max-width:70ch;line-height:1.55}
h2{font-size:17px;margin:0 0 3px}
section.group{margin:0 0 34px}
p.note{color:var(--muted);font-size:12.5px;margin:0 0 14px;max-width:80ch}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
article h3{font-size:15.5px;margin:0 0 2px}
article p.intent{color:var(--muted);font-size:12.5px;margin:0 0 12px}
.grid{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}
figure{margin:0;width:240px}
figure.wide{width:376px}
img{width:100%;border:1px solid var(--line);border-radius:5px;background:#fff;display:block}
figcaption{font-size:11.5px;color:var(--muted);text-align:center;margin-top:3px}
dl.metrics{display:flex;flex-wrap:wrap;gap:0 22px;margin:12px 0 0;font-size:12px}
dl.metrics div{display:flex;gap:6px}
dl.metrics dt{color:var(--muted)}
dl.metrics dd{margin:0;font-variant-numeric:tabular-nums}
p.metrics.rejected{color:#a33;font-size:12.5px;margin:12px 0 0}
.axes{font-size:11.5px;color:var(--muted);margin-top:8px}
`;

async function buildCard(card, candidate, context, sheetDir) {
	// A card may live under a different run root than the candidate's authoring dir - the
	// live director writes into its own run - while still being one grammar over the same
	// context. Its grammar path stays relative to the authoring root, where the file is kept.
	const runRoot = card.runRoot ?? candidate.runRoot;
	const grammarPath = join(VERIFICATION_ROOT, candidate.runRoot, card.grammar);
	let check = null;
	try {
		check = checkAuthoredGrammar({ context, grammar: JSON.parse(await readFile(grammarPath, "utf8")) });
	} catch (error) {
		check = { stage: `unreadable (${String(error?.message ?? error).slice(0, 80)})` };
	}
	const figures = [];
	for (const [view, label] of VIEWS) {
		const path = elevationPath(runRoot, card.renderDir, view);
		if (await exists(join(sheetDir, path))) {
			figures.push(`<figure><a href="${path}" target="_blank"><img src="${path}" loading="lazy"></a><figcaption>${label}</figcaption></figure>`);
		}
	}
	for (const [path, label, wide] of [
		[heroPath(runRoot, card.renderDir), "axon (PBR)", true],
		[card.showcase ? `${runRoot}/${card.showcase}` : null, "showcase", true],
		[card.photo ? `${runRoot}/${card.photo}` : null, "photoreal", true],
	]) {
		if (path && await exists(join(sheetDir, path))) {
			figures.push(`<figure class="${wide ? "wide" : ""}"><a href="${path}" target="_blank"><img src="${path}" loading="lazy"></a><figcaption>${label}</figcaption></figure>`);
		}
	}
	return `<article id="${escape(card.id)}">
<h3>${escape(card.title)}</h3>
<p class="intent">${escape(card.intent)}</p>
<div class="grid">${figures.join("")}</div>
${metricRow(metricsOf(check))}
${card.axes ? `<p class="axes">showcase axes — ${escape(card.axes)}</p>` : ""}
</article>`;
}

function imageSection(section, runRoot) {
	const figures = section.images.map((image) =>
		`<figure class="wide"><a href="${runRoot}/${image.src}" target="_blank"><img src="${runRoot}/${image.src}" loading="lazy"></a><figcaption>${escape(image.caption)}</figcaption></figure>`).join("");
	return `<section class="group" id="${escape(section.id)}"><h2>${escape(section.title)}</h2><p class="note">${escape(section.note)}</p><div class="grid">${figures}</div></section>`;
}

export async function buildSheet({ manifestPath, outPath } = {}) {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const sheetDir = dirname(resolve(outPath));
	const [candidate] = manifest.candidates;
	// One prepare per candidate: the evidence verify is the slow part, and every scheme on
	// this page is a different grammar over the same context.
	const { context } = await prepareFacadeContext({ candidateId: candidate.id });
	const parts = [];
	for (const section of manifest.sections) {
		if (section.images) { parts.push(imageSection(section, candidate.runRoot)); continue; }
		const cards = [];
		for (const card of section.cards) cards.push(await buildCard(card, candidate, context, sheetDir));
		parts.push(`<section class="group" id="${escape(section.id)}"><h2>${escape(section.title)}</h2><p class="note">${escape(section.note)}</p>${cards.join("\n")}</section>`);
	}
	const html = `<!doctype html><meta charset="utf-8">
<title>${escape(manifest.title)}</title>
<style>${STYLE}</style>
<h1>${escape(manifest.title)}</h1>
<p class="sub">${escape(manifest.subtitle)}<br>${escape(candidate.note)}</p>
${parts.join("\n")}
`;
	await writeFile(outPath, html, "utf8");
	return { outPath, sections: manifest.sections.length };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
	const [manifestArg, outArg] = process.argv.slice(2);
	const result = await buildSheet({
		manifestPath: manifestArg ? resolve(manifestArg) : join(here, "manifest.json"),
		outPath: outArg ? resolve(outArg) : join(VERIFICATION_ROOT, "catalogue.html"),
	});
	process.stdout.write(`${JSON.stringify({ stage: "done", ...result, relative: relative(process.cwd(), result.outPath) })}\n`);
}
