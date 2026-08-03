import { join, resolve } from "node:path";
import { prepareRun } from "./lib/core.mjs";
import { executeRun, resumeRun } from "./lib/orchestrator.mjs";
import { startPreview } from "./lib/preview.mjs";

const briefSchema = { type: "object", properties: { summary_ko: { type: "string" }, materials: { type: "array", items: { type: "string" } }, window_rhythm: { type: "string" }, ground_floor: { type: "string" }, roof: { type: "string" }, negative_constraints: { type: "array", items: { type: "string" } } }, required: ["summary_ko", "materials", "window_rhythm", "ground_floor", "roof", "negative_constraints"] };

export async function register(api) {
	const datasetRoot = api.config.dataset_root ?? "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730";
	const outputRoot = resolve(api.config.output_root ?? "results");
	api.addPrompt("For elevation generation, author facade_brief, call elevation_3d_prepare, show approval_id and cost, and wait for explicit approval before live generation.");
	api.registerMemoryLayer({ name: "elevation-3d-research", path: "memory/elevation-3d/README.md", description: "Geometry-locked architectural 3D research and decisions" });
	api.registerTool({ name: "elevation_3d_prepare", description: "Verify an immutable MASS candidate and prepare a two-provider generation plan without external API calls.", inputSchema: { properties: { dataset_root: { type: "string" }, candidate_id: { type: "string" }, facade_brief: briefSchema, output_root: { type: "string" } }, required: ["facade_brief"] }, handler: async (args) => { const plan = await prepareRun({ datasetRoot: args.dataset_root ?? datasetRoot, candidateId: args.candidate_id ?? "creative-004", facadeBrief: args.facade_brief, outputRoot: args.output_root ?? outputRoot }); return { text: JSON.stringify({ plan_path: join(plan.run_dir, "plan.json"), run_dir: plan.run_dir, plan_id: plan.plan_id, approval_id: plan.approval_id, estimated_cost_cny: plan.estimated_cost_cny, candidate_id: plan.candidate_id, provider_calls: 2 }, null, 2) }; } });
	api.registerTool({ name: "elevation_3d_generate", description: "After explicit approval, submit exactly one Hunyuan and one Wan job for a prepared plan.", inputSchema: { properties: { plan_path: { type: "string" }, approval_id: { type: "string" }, confirm_live: { type: "boolean" }, approved_max_cost_cny: { type: "number" } }, required: ["plan_path", "approval_id", "confirm_live", "approved_max_cost_cny"] }, handler: async (args) => ({ text: JSON.stringify(await executeRun({ planPath: args.plan_path, approvalId: args.approval_id, confirmLive: args.confirm_live, approvedMaxCostCny: args.approved_max_cost_cny }), null, 2) }) });
	api.registerTool({ name: "elevation_3d_resume", description: "Poll stored provider jobs without creating new paid jobs.", inputSchema: { properties: { run_dir: { type: "string" }, wait: { type: "boolean" } }, required: ["run_dir"] }, handler: async (args) => ({ text: JSON.stringify(await resumeRun({ runDir: args.run_dir, wait: args.wait ?? false }), null, 2) }) });
	api.registerTool({ name: "elevation_3d_preview", description: "Serve a completed or partial run as a local static web preview.", inputSchema: { properties: { run_dir: { type: "string" }, port: { type: "integer" } }, required: ["run_dir"] }, handler: async (args) => ({ text: await startPreview(args.run_dir, args.port ?? api.config.preview_port ?? 4173) }) });
}
