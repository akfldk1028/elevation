import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

function pathError(message) {
	const error = new Error(message);
	error.code = "FACADE_AGENT_PATH_UNSAFE";
	return error;
}

export function containedPath(root, path, label = "path") {
	const absoluteRoot = resolve(root);
	const absolute = resolve(path);
	const child = relative(absoluteRoot, absolute);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw pathError(`${label} must remain beneath the run directory`);
	}
	return absolute;
}

export async function assertNoReparsePoints(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (let index = 0; index < parts.length; index += 1) {
		current = resolve(current, parts[index]);
		let stats;
		try { stats = await lstat(current); }
		catch (error) { if (error?.code === "ENOENT") return; throw error; }
		if (stats.isSymbolicLink()) throw pathError("Facade agent paths must not contain symlinks or junctions");
		if (index < parts.length - 1 && !stats.isDirectory()) throw pathError("Facade agent path parent must be a directory");
	}
}

export async function assertNoReparseTree(path) {
	const root = resolve(path);
	await assertNoReparsePoints(root);
	let entries;
	try { entries = await readdir(root, { withFileTypes: true }); }
	catch (error) { if (error?.code === "ENOENT") return; throw error; }
	for (const entry of entries) {
		const child = resolve(root, entry.name);
		const stats = await lstat(child);
		if (stats.isSymbolicLink()) throw pathError("Facade agent artifact trees must not contain symlinks or junctions");
		if (stats.isDirectory()) await assertNoReparseTree(child);
	}
}

export async function prepareSafeDirectory(approvedRoot, path, label = "output directory") {
	const absolute = resolve(path) === resolve(approvedRoot) ? resolve(path) : containedPath(approvedRoot, path, label);
	await assertNoReparsePoints(approvedRoot);
	await assertNoReparsePoints(absolute);
	await mkdir(absolute, { recursive: true });
	await assertNoReparsePoints(absolute);
	return absolute;
}

async function syncDirectory(path) {
	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
	} finally { await handle?.close(); }
}

export async function atomicWrite(path, bytes, approvedRoot) {
	containedPath(approvedRoot, path, "atomic output");
	await assertNoReparsePoints(approvedRoot);
	await assertNoReparsePoints(path);
	await prepareSafeDirectory(approvedRoot, dirname(path), "atomic output parent");
	await assertNoReparsePoints(path);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = null;
		await assertNoReparsePoints(temporary);
		await assertNoReparsePoints(path);
		await rename(temporary, path);
		await syncDirectory(dirname(path));
		await assertNoReparsePoints(path);
	} finally {
		await handle?.close();
		await rm(temporary, { force: true });
	}
}

export async function atomicCopy(source, destination, approvedRoot) {
	await assertNoReparsePoints(source);
	const bytes = await readFile(source);
	await assertNoReparsePoints(source);
	await atomicWrite(destination, bytes, approvedRoot);
	return bytes;
}

export async function safeRead(root, path, label = "artifact") {
	const absolute = containedPath(root, path, label);
	await assertNoReparsePoints(absolute);
	const bytes = await readFile(absolute);
	await assertNoReparsePoints(absolute);
	return bytes;
}
