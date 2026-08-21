import * as THREE from "three";

// ---------------- camera ----------------

// The GLB is authored z-up and the app wraps it in a group rotated x by -PI/2.
// Under that wrap, model -y (the "front" before the wrap) faces world +z, and
// the world camera azimuth convention is: position = target + (sin(az), _,
// cos(az)) * distance, so azimuth 0 views the world +z-facing side. Hence:
//   front = model -y face -> world +z -> azimuth 0
//   back  = model +y face -> world -z -> azimuth PI
//   right = model +x face -> world +x -> azimuth PI/2
//   left  = model -x face -> world -x -> azimuth -PI/2
const FACE_AZIMUTHS = {
	front: 0,
	back: Math.PI,
	right: Math.PI / 2,
	left: -Math.PI / 2,
};

// Base azimuth of the showcase side. An explicit face wins; otherwise the
// entrance picks it: the door is a thin slab, its thin horizontal axis is the
// facade normal, and the sign comes from which side of the plan center it
// sits on. The 52-degree three-quarter offset is applied by the caller.
export function deriveBaseAzimuth(wrap, center, face) {
	if (face && face !== "auto" && FACE_AZIMUTHS[face] !== undefined) {
		return FACE_AZIMUTHS[face];
	}
	let doorBox = null;
	wrap.traverse(function (o) {
		if (o.isMesh && o.geometry && o.geometry.userData && o.geometry.userData.kind === "door") {
			doorBox = new THREE.Box3().setFromObject(o);
		}
	});
	let baseAz = Math.PI; // fallback: look at -z face
	if (doorBox) {
		const dSize = doorBox.getSize(new THREE.Vector3());
		const dCenter = doorBox.getCenter(new THREE.Vector3());
		if (dSize.x < dSize.z) baseAz = dCenter.x >= center.x ? Math.PI / 2 : -Math.PI / 2;
		else baseAz = dCenter.z >= center.z ? 0 : Math.PI;
	}
	return baseAz;
}

// Three-quarter perspective, building ~70% of frame height. `bounds` is the
// one value-object { box, center, sizes } shared with ground/shadow/fill.
export function setupCamera(width, height, bounds, camAz, camHeight) {
	const box = bounds.box, center = bounds.center, sizes = bounds.sizes;
	const camera = new THREE.PerspectiveCamera(35, width / height, 0.5, 3000);
	const target = center.clone();
	target.y = sizes.y * 0.46;

	function place(distance) {
		camera.position.set(
			target.x + Math.sin(camAz) * distance,
			camHeight,
			target.z + Math.cos(camAz) * distance,
		);
		camera.lookAt(target);
		camera.updateMatrixWorld(true);
		camera.updateProjectionMatrix();
	}

	function frame() {
		const pts = [];
		for (let i = 0; i < 8; i++) {
			pts.push(new THREE.Vector3(
				i & 1 ? box.max.x : box.min.x,
				i & 2 ? box.max.y : box.min.y,
				i & 4 ? box.max.z : box.min.z,
			).project(camera));
		}
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const p of pts) {
			minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
		}
		return { hFrac: (maxY - minY) / 2, wFrac: (maxX - minX) / 2, midY: (minY + maxY) / 2 };
	}

	let distance = 30;
	for (let i = 0; i < 14; i++) {
		place(distance);
		const f = frame();
		let scale = f.hFrac / 0.74;
		if (f.wFrac / 0.97 > scale) scale = f.wFrac / 0.97;
		distance *= scale;
		if (Math.abs(scale - 1) < 0.002) break;
	}
	// vertical composition: nudge the look-target so the building sits slightly
	// above the lower third, leaving ground and shadow in the foreground
	place(distance);
	for (let i = 0; i < 6; i++) {
		const f = frame();
		const err = f.midY - 0.10;
		if (Math.abs(err) < 0.005) break;
		target.y += err * distance * Math.tan(THREE.MathUtils.degToRad(35) / 2);
		place(distance);
	}
	return camera;
}
