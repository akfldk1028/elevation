import { access, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import { redactSecrets, sha256, stableJson } from "../core.mjs";
import {
	FACADE_AGENT_PROVIDERS,
	FACADE_AGENT_STAGES,
	FacadeAgentContractError,
	normalizeFacadeAgentConfig,
} from "./contract.mjs";
import { readFacadeAgentStatus, runFacadeAgent, runFacadeStage } from "./harness.mjs";
import { createProductionFacadeAgentDependencies } from "./production-dependencies.mjs";

const CONFIG_FILE = "facade-agent-config.json";
const TOOL_FIELDS = new Set(["candidate_id", "dataset_root", "output_root", "run_id", "providers", "brief_id", "dry_run", "confirm_live", "image_budget_usd", "grammar_budget_usd"]);
const BUDGET_FIELDS = new Set(FACADE_AGENT_PROVIDERS);
const factoryCapabilities = new WeakSet();

function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

export function createFacadeAgentDependencyFactory(factory) {
	if (typeof factory !== "function") throw new TypeError("Facade agent dependency factory must be a function");
	factoryCapabilities.add(factory);
	return factory;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function parseNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) throw new FacadeAgentContractError("BUDGET_INVALID", `${label} must be a finite nonnegative number`);
	return number;
}

function parseOptions(argv) {
	const command = argv[0];
	if (![...FACADE_AGENT_STAGES, "run", "status", "resume"].includes(command)) {
		throw new FacadeAgentContractError("COMMAND_INVALID", "A supported facade agent subcommand is required");
	}
	const values = {};
	const flags = new Set();
	for (let index = 1; index < argv.length; index += 1) {
		const name = argv[index];
		if (["--dry-run", "--confirm-live"].includes(name)) {
			if (flags.has(name)) throw new FacadeAgentContractError("ARGUMENT_DUPLICATE", `Duplicate argument: ${name}`);
			flags.add(name);
			continue;
		}
		if (!name.startsWith("--") || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
			throw new FacadeAgentContractError("ARGUMENT_INVALID", `Invalid argument: ${name}`);
		}
		if (Object.hasOwn(values, name)) throw new FacadeAgentContractError("ARGUMENT_DUPLICATE", `Duplicate argument: ${name}`);
		values[name] = argv[index + 1];
		index += 1;
	}
	const allowed = command === "status" || command === "resume"
		? new Set(["--run-dir"])
		: new Set(["--candidate", "--brief", "--dataset-root", "--output-root", "--run-id", "--providers", "--image-budget-gpt-image-2", "--image-budget-nano-banana-pro", "--grammar-budget", "--confirm-cost-usd"]);
	for (const key of Object.keys(values)) if (!allowed.has(key)) throw new FacadeAgentContractError("ARGUMENT_INVALID", `Unsupported argument: ${key}`);
	if ((command === "status" || command === "resume") && flags.size > 0) throw new FacadeAgentContractError("ARGUMENT_INVALID", `${command} accepts only --run-dir`);
	if (command === "status" || command === "resume") {
		if (!values["--run-dir"]) throw new FacadeAgentContractError("ROOT_INVALID", "runDir is required");
		return { command, runDir: resolve(values["--run-dir"]) };
	}
	for (const required of ["--candidate", "--brief", "--dataset-root", "--output-root", "--run-id", "--image-budget-gpt-image-2", "--image-budget-nano-banana-pro", "--grammar-budget"]) {
		if (values[required] === undefined) throw new FacadeAgentContractError("ARGUMENT_REQUIRED", `${required} is required`);
	}
	const dryRun = flags.has("--dry-run");
	const confirmLive = flags.has("--confirm-live");
	if (dryRun && confirmLive) throw new FacadeAgentContractError("LIVE_CONFIRMATION_INVALID", "Dry-run cannot confirm live execution");
	const imageBudgetUsd = {
		"gpt-image-2": parseNumber(values["--image-budget-gpt-image-2"], "imageBudgetUsd.gpt-image-2"),
		"nano-banana-pro": parseNumber(values["--image-budget-nano-banana-pro"], "imageBudgetUsd.nano-banana-pro"),
	};
	const grammarBudgetUsd = parseNumber(values["--grammar-budget"], "grammarBudgetUsd");
	if (confirmLive) {
		const expected = imageBudgetUsd["gpt-image-2"] + imageBudgetUsd["nano-banana-pro"] + grammarBudgetUsd;
		const confirmed = parseNumber(values["--confirm-cost-usd"], "confirmCostUsd");
		if (confirmed !== expected) throw new FacadeAgentContractError("LIVE_COST_CONFIRMATION_INVALID", "Live cost confirmation must exactly equal all provider ceilings");
	} else if (values["--confirm-cost-usd"] !== undefined) {
		throw new FacadeAgentContractError("LIVE_COST_CONFIRMATION_INVALID", "Cost confirmation requires --confirm-live");
	}
	const providers = values["--providers"]?.split(",").filter(Boolean) ?? [...FACADE_AGENT_PROVIDERS];
	return {
		command,
		dryRun,
		config: normalizeFacadeAgentConfig({
			candidateId: values["--candidate"], briefId: values["--brief"], runId: values["--run-id"],
			datasetRoot: values["--dataset-root"], outputRoot: values["--output-root"], providers,
			imageBudgetUsd, grammarBudgetUsd, grammarModel: "gpt-5.6", maxLocalAttempts: 2,
			confirmLive,
		}),
	};
}

function configPath(config) {
	return join(config.outputRoot, config.candidateId, config.runId, CONFIG_FILE);
}

function persistedConfig(config) {
	return {
		candidateId: config.candidateId, briefId: config.briefId, runId: config.runId,
		datasetRoot: config.datasetRoot, outputRoot: config.outputRoot, providers: config.providers,
		imageBudgetUsd: config.imageBudgetUsd, grammarBudgetUsd: config.grammarBudgetUsd,
		grammarModel: config.grammarModel, maxLocalAttempts: config.maxLocalAttempts,
		confirmLive: config.confirmLive,
	};
}

async function fileExists(path) {
	try { await access(path); return true; }
	catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function containedPath(root, path) {
	const absoluteRoot = resolve(root);
	const absolute = resolve(path);
	const child = relative(absoluteRoot, absolute);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw codedError("FACADE_AGENT_PATH_UNSAFE", "Facade agent configuration path is unsafe");
	return absolute;
}

async function assertNoReparsePoints(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (const part of parts) {
		current = resolve(current, part);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink()) throw codedError("FACADE_AGENT_PATH_UNSAFE", "Facade agent configuration path must not contain links or junctions");
		} catch (error) { if (error?.code === "ENOENT") return; throw error; }
	}
}

async function syncDirectory(path) {
	let handle;
	try { handle = await open(path, "r"); await handle.sync(); }
	catch (error) { if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error; }
	finally { await handle?.close(); }
}

function configEnvelope(config) {
	const value = persistedConfig(config);
	return { schema_version: "arr.elevation3d.facade-agent-config.v1", config: value, config_sha256: sha256(stableJson(value)) };
}

function verifyConfigEnvelope(value) {
	if (value?.schema_version !== "arr.elevation3d.facade-agent-config.v1" || !value.config
		|| value.config_sha256 !== sha256(stableJson(value.config))) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted facade agent configuration hash is invalid");
	}
	return value.config;
}

async function persistConfig(config) {
	const runDir = resolve(config.outputRoot, config.candidateId, config.runId);
	const path = containedPath(runDir, configPath(config));
	const value = configEnvelope(config);
	await assertNoReparsePoints(config.outputRoot);
	await assertNoReparsePoints(runDir);
	await mkdir(runDir, { recursive: true });
	await assertNoReparsePoints(runDir);
	if (await fileExists(path)) {
		await assertNoReparsePoints(path);
		const existing = JSON.parse(await readFile(path, "utf8"));
		verifyConfigEnvelope(existing);
		if (stableJson(existing) !== stableJson(value)) throw codedError("FACADE_AGENT_RESUME_MISMATCH", "Persisted facade agent configuration does not match");
		return;
	}
	const temporary = `${path}.tmp-${process.pid}`;
	let handle;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync(); await handle.close(); handle = null;
		await assertNoReparsePoints(runDir); await assertNoReparsePoints(temporary);
		await rename(temporary, path); await syncDirectory(dirname(path));
	} finally { await handle?.close(); await rm(temporary, { force: true }); }
}

async function loadPersistedConfig(runDir) {
	let input;
	try {
		const path = containedPath(runDir, join(runDir, CONFIG_FILE));
		await assertNoReparsePoints(runDir); await assertNoReparsePoints(path);
		if (!(await lstat(path)).isFile()) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted facade agent configuration is not a regular file");
		input = verifyConfigEnvelope(JSON.parse(await readFile(path, "utf8")));
	}
	catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted facade agent configuration is unavailable", error); }
	const config = normalizeFacadeAgentConfig(input);
	if (resolve(config.outputRoot, config.candidateId, config.runId) !== resolve(runDir)) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted facade agent configuration is bound to another run");
	}
	return config;
}

function validateDependencyAuthority(factory, fetchImpl) {
	if (factory !== null && factory !== undefined && !factoryCapabilities.has(factory)) throw codedError("FACADE_AGENT_DEPENDENCIES_UNAVAILABLE", "Facade agent dependency capability is invalid");
	if ((factory === null || factory === undefined) && typeof fetchImpl !== "function") throw new TypeError("An explicit fetch implementation is required for facade providers");
}

async function dependencies(config, signal, factory, fetchImpl) {
	validateDependencyAuthority(factory, fetchImpl);
	const deps = factory
		? await factory({ ...config, signal })
		: await createProductionFacadeAgentDependencies({ ...config, signal }, { fetchImpl });
	if (!deps || typeof deps !== "object") throw codedError("FACADE_AGENT_DEPENDENCIES_UNAVAILABLE", "Facade agent dependencies are not configured");
	return { ...deps, signal };
}

function inputFailure() {
	return new FacadeAgentContractError("TOOL_INPUT_INVALID", "Facade agent tool input must contain only plain own data fields");
}

function plainDataRecord(value, allowed) {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) throw inputFailure();
	let prototype, descriptors;
	try { prototype = Object.getPrototypeOf(value); descriptors = Object.getOwnPropertyDescriptors(value); }
	catch { throw inputFailure(); }
	if (prototype !== Object.prototype && prototype !== null) throw inputFailure();
	const output = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowed.has(key) || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw inputFailure();
		output[key] = descriptor.value;
	}
	return output;
}

function plainProviderArray(value) {
	if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw inputFailure();
	let descriptors;
	try { descriptors = Object.getOwnPropertyDescriptors(value); }
	catch { throw inputFailure(); }
	const length = descriptors.length?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > FACADE_AGENT_PROVIDERS.length) throw inputFailure();
	const output = [];
	const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") throw inputFailure();
		output.push(descriptor.value);
	}
	if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowedKeys.has(key))) throw inputFailure();
	return output;
}

function safeToolInput(value) {
	const input = plainDataRecord(value, TOOL_FIELDS);
	if (Object.hasOwn(input, "providers")) input.providers = plainProviderArray(input.providers);
	if (Object.hasOwn(input, "image_budget_usd")) input.image_budget_usd = plainDataRecord(input.image_budget_usd, BUDGET_FIELDS);
	return input;
}

export function summarizeFacadeAgentResult(result, stage = null) {
	const status = result?.final?.status ?? result?.status ?? "running";
	const state = status === "winner" ? "accepted"
		: ["no-winner", "human-review", "delivery-failed", "blocked"].includes(status) ? "rejected"
			: status === "cancelled" ? "cancelled" : "running";
	return redactSecrets({
		state, status, ...(stage ? { stage } : {}),
		run_id: result?.run_id ?? null, candidate_id: result?.candidate_id ?? null, brief_id: result?.brief_id ?? null,
		...(result?.final?.selected_provider ? { selected_provider: result.final.selected_provider } : {}),
		...(result?.final?.selected_version ? { selected_version: result.final.selected_version } : {}),
		...(result?.failure?.code ? { failure: { code: result.failure.code } } : {}),
		details: {
			stages: Object.fromEntries(Object.entries(result?.stage_manifests ?? {}).map(([name, value]) => [name, value?.status ?? null])),
			providers: Object.fromEntries(Object.entries(result?.providers ?? {}).map(([name, value]) => [name, { status: value?.status ?? null, ...(value?.failure?.code ? { failure_code: value.failure.code } : {}) }])),
			image_submissions: result?.image_submissions ?? { total: 0, by_provider: {} },
		},
	});
}

function outcomeExit(summary) {
	if (summary.state === "rejected") {
		const failures = Object.values(summary.details?.providers ?? {}).map((provider) => provider?.failure_code).filter(Boolean);
		if (failures.some((code) => /PROVIDER|TRANSPORT|NETWORK|RATE_LIMIT|AUTH_FAILED/.test(code))) return 40;
		return 20;
	}
	if (summary.state === "cancelled") return 60;
	return 0;
}

function errorCategory(error) {
	if (error?.name === "AbortError" || /ABORT|CANCEL/.test(error?.code ?? "")) return { category: "cancelled", exitCode: 60 };
	const code = typeof error?.code === "string" ? error.code : "FACADE_AGENT_INTERNAL_ERROR";
	if (/PATH_UNSAFE|STATE_UNCERTAIN|HASH_MISMATCH|RECEIPT|RESUME_MISMATCH/.test(code)) return { category: "security", exitCode: 50 };
	if (/PROVIDER|TRANSPORT|NETWORK|RATE_LIMIT|AUTH_FAILED/.test(code)) return { category: "transport", exitCode: 40 };
	if (error instanceof FacadeAgentContractError || /ARGUMENT|COMMAND|BUDGET|CONFIRMATION|APPROVED|PROVIDER_SET|ROOT_INVALID|PATH_SEGMENT|RUN_EXISTS/.test(code)) return { category: "configuration", exitCode: 30 };
	return { category: "internal", exitCode: 70 };
}

export async function executeFacadeAgentCommand(input, { signal, dependencyFactory, fetchImpl } = {}) {
	throwIfAborted(signal);
	const parsed = Array.isArray(input) ? parseOptions(input) : input;
	if (parsed.command === "status") {
		await loadPersistedConfig(parsed.runDir);
		return { summary: summarizeFacadeAgentResult(await readFacadeAgentStatus(parsed.runDir)), exitCode: 0 };
	}
	validateDependencyAuthority(dependencyFactory, fetchImpl);
	let config = parsed.config;
	if (parsed.command === "resume") config = await loadPersistedConfig(parsed.runDir);
	const runPath = join(config.outputRoot, config.candidateId, config.runId, "run.json");
	if (parsed.command === "run" && await fileExists(runPath)) throw codedError("FACADE_AGENT_RUN_EXISTS", "Run already exists; use status or resume");
	await persistConfig(config);
	const deps = await dependencies(config, signal, dependencyFactory, fetchImpl);
	const stage = parsed.dryRun ? "preflight" : FACADE_AGENT_STAGES.includes(parsed.command) ? parsed.command : null;
	const result = stage ? await runFacadeStage(stage, config, deps) : await runFacadeAgent(config, deps);
	const summary = summarizeFacadeAgentResult(result, stage);
	return { summary, exitCode: outcomeExit(summary) };
}

export async function runFacadeAgentCli(argv, io = {}) {
	const stdout = io.stdout ?? process.stdout;
	const stderr = io.stderr ?? process.stderr;
	try {
		const command = argv[0] ?? "";
		stderr.write(`[facade-agent] ${command || "invalid"} started\n`);
		const outcome = await executeFacadeAgentCommand(argv, { signal: io.signal, dependencyFactory: io.dependencyFactory, fetchImpl: io.fetchImpl });
		stdout.write(`${JSON.stringify(outcome.summary)}\n`);
		stderr.write(`[facade-agent] ${command} finished with ${outcome.summary.state}\n`);
		return outcome.exitCode;
	} catch (error) {
		const classified = errorCategory(error);
		const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : "FACADE_AGENT_INTERNAL_ERROR";
		stdout.write(`${JSON.stringify({ state: classified.category === "cancelled" ? "cancelled" : "error", category: classified.category, code })}\n`);
		stderr.write(`[facade-agent] failed (${classified.category}:${code})\n`);
		return classified.exitCode;
	}
}

export function facadeAgentToolSchema() {
	return {
		type: "object",
		properties: {
			candidate_id: { type: "string", enum: ["creative-020"] },
			dataset_root: { type: "string" }, output_root: { type: "string" }, run_id: { type: "string" },
			providers: { type: "array", items: { type: "string", enum: [...FACADE_AGENT_PROVIDERS] }, minItems: 2, maxItems: 2 },
			brief_id: { type: "string", enum: ["brick-punched-window-v1"] }, dry_run: { type: "boolean", default: true },
			confirm_live: { type: "boolean", default: false },
			image_budget_usd: { type: "object", properties: Object.fromEntries(FACADE_AGENT_PROVIDERS.map((provider) => [provider, { type: "number", minimum: 0 }])), additionalProperties: false },
			grammar_budget_usd: { type: "number", minimum: 0 },
		},
		required: ["run_id"], additionalProperties: false,
	};
}

export async function runFacadeAgentTool(args, signal, defaults = {}, dependencyFactory, fetchImpl) {
	throwIfAborted(signal);
	const input = safeToolInput(args);
	const dryRun = input.dry_run !== false;
	if (dryRun && input.confirm_live === true) throw new FacadeAgentContractError("LIVE_CONFIRMATION_INVALID", "Dry-run cannot confirm live execution");
	if (!dryRun && input.confirm_live === true && (input.image_budget_usd === undefined || input.grammar_budget_usd === undefined)) {
		throw new FacadeAgentContractError("LIVE_COST_CONFIRMATION_INVALID", "Live execution requires explicit provider cost ceilings");
	}
	const config = normalizeFacadeAgentConfig({
		candidateId: input.candidate_id ?? "creative-020", briefId: input.brief_id ?? "brick-punched-window-v1",
		runId: input.run_id, datasetRoot: input.dataset_root ?? defaults.datasetRoot,
		outputRoot: input.output_root ?? defaults.outputRoot, providers: input.providers ?? [...FACADE_AGENT_PROVIDERS],
		imageBudgetUsd: input.image_budget_usd ?? Object.fromEntries(FACADE_AGENT_PROVIDERS.map((provider) => [provider, 0])),
		grammarBudgetUsd: input.grammar_budget_usd ?? 0, grammarModel: "gpt-5.6", maxLocalAttempts: 2,
		confirmLive: dryRun ? false : input.confirm_live === true,
	});
	const outcome = await executeFacadeAgentCommand({ command: dryRun ? "preflight" : "run", dryRun, config }, { signal, dependencyFactory, fetchImpl });
	return redactSecrets(outcome.summary);
}
