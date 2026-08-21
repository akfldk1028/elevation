/**
 * The showcase's four orthogonal look axes plus the camera face flag:
 * value tables, style shorthand pairings, and validation.
 */
export const AXIS_VALUES = {
	wall: ["brick", "limestone", "precast", "darkpanel", "zinc", "wood"],
	glass: ["deep", "clear", "mirror"],
	frame: ["bronze", "iron", "white"],
	mood: ["golden", "morning", "overcast"],
};

export const STYLE_NAMES = ["brick", "stone", "sheer"];

// --style is shorthand for the historical pairing of the four axes;
// explicit axis flags override it.
export const STYLE_AXES = {
	brick: { wall: "brick", glass: "deep", frame: "iron", mood: "golden" },
	stone: { wall: "limestone", glass: "deep", frame: "bronze", mood: "morning" },
	sheer: { wall: "darkpanel", glass: "mirror", frame: "iron", mood: "overcast" },
};

export const FACE_VALUES = ["front", "back", "left", "right", "auto"];

export function validateStyle(styleName) {
	if (styleName && !STYLE_NAMES.includes(styleName)) {
		throw new Error(`unknown --style "${styleName}"; expected ${STYLE_NAMES.join(", ")}`);
	}
}

export function validateAxisFlags(axisFlags) {
	for (const [axis, value] of Object.entries(axisFlags)) {
		if (value && !AXIS_VALUES[axis].includes(value)) {
			throw new Error(`unknown --${axis} "${value}"; expected ${AXIS_VALUES[axis].join(", ")}`);
		}
	}
}

export function validateFace(face) {
	if (!FACE_VALUES.includes(face)) {
		throw new Error(`unknown --face "${face}"; expected ${FACE_VALUES.join(", ")}`);
	}
}

export function mergeAxes(styleName, axisFlags) {
	const axes = { wall: "", glass: "", frame: "", mood: "" };
	if (styleName) Object.assign(axes, STYLE_AXES[styleName]);
	for (const axis of Object.keys(axisFlags)) {
		if (axisFlags[axis]) axes[axis] = axisFlags[axis];
	}
	return axes;
}
