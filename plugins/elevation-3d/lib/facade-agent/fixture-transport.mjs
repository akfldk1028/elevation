const fixtureTransports = new WeakSet();

export function createFacadeFixtureTransport(transport) {
	if ((typeof transport !== "function" && (typeof transport !== "object" || transport === null))) {
		throw new TypeError("A fixture transport function or object is required");
	}
	const descriptor = Object.getOwnPropertyDescriptor(transport, "transport");
	if (descriptor && descriptor.configurable === false && descriptor.value !== "fixture") {
		throw new TypeError("A fixture transport cannot retain a non-fixture transport label");
	}
	Object.defineProperty(transport, "transport", {
		value: "fixture", enumerable: true, configurable: false, writable: false,
	});
	fixtureTransports.add(transport);
	return transport;
}

export function isFacadeFixtureTransport(transport) {
	return (typeof transport === "function" || (typeof transport === "object" && transport !== null))
		&& fixtureTransports.has(transport);
}
