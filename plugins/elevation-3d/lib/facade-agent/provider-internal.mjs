const remoteIds = new WeakMap();

function validRemoteId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
}

export function storeFacadeProviderRemoteId(error, remoteId) {
	if (error && typeof error === "object" && validRemoteId(remoteId)) remoteIds.set(error, remoteId);
}

export function transferFacadeProviderRemoteId(source, target) {
	const remoteId = source && typeof source === "object" ? remoteIds.get(source) : null;
	if (source && typeof source === "object") remoteIds.delete(source);
	if (remoteId && target && typeof target === "object") remoteIds.set(target, remoteId);
}

export function takeFacadeProviderRemoteIdForLedger(error) {
	const remoteId = error && typeof error === "object" ? remoteIds.get(error) ?? null : null;
	if (error && typeof error === "object") remoteIds.delete(error);
	return remoteId;
}
