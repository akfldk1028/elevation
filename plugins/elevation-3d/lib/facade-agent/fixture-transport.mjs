const fixtureTransports = new WeakSet();

export function createFacadeFixtureTransport(transport) {
	if ((typeof transport !== "function" && (typeof transport !== "object" || transport === null))) {
		throw new TypeError("A fixture transport function or object is required");
	}
	fixtureTransports.add(transport);
	return transport;
}

export function isFacadeFixtureTransport(transport) {
	return (typeof transport === "function" || (typeof transport === "object" && transport !== null))
		&& fixtureTransports.has(transport);
}
