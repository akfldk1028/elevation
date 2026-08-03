const PAGE_CLEARANCE = 48;
const NOTE = "ALL DIMENSIONS IN MILLIMETRES";

function escapeXml(value) {
	return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function intersects(left, right) {
	return left.min_x < right.max_x && left.max_x > right.min_x && left.min_y < right.max_y && left.max_y > right.min_y;
}

function textBox(id, x, y, width, height, anchor = "middle") {
	const minX = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
	return { id, min_x: minX, min_y: y - height * 0.72, max_x: minX + width, max_y: y + height * 0.28 };
}

function line(x1, y1, x2, y2, className = "dimension") {
	return `<line class="${className}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
}

function text(value, x, y, attributes = "") {
	return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${attributes}>${escapeXml(value)}</text>`;
}

export function buildElevationAnnotations({ dimensions, camera, contentBounds, canvas = [2400, 2400], candidateId = "unknown" }) {
	const [width, height] = canvas;
	if (width !== 2400 || height !== 2400 || camera?.type !== "orthographic") throw new Error("annotation layout unavailable: invalid canvas or camera");
	if (contentBounds.min_x < 192 || contentBounds.max_x > width - 192 || contentBounds.min_y < PAGE_CLEARANCE || contentBounds.max_y > height - 520) {
		throw new Error("annotation layout unavailable: content consumes reserved lane");
	}
	const scaleX = camera.px_per_m_x;
	const scaleY = camera.px_per_m_y;
	if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX / scaleY - 1) > 0.0025) throw new Error("annotation layout unavailable: unequal orthographic scale");
	const point = ([horizontal, vertical]) => [width / 2 + (horizontal - camera.center_m[0]) * scaleX, height / 2 - (vertical - camera.center_m[1]) * scaleY];
	const exactMin = point(dimensions.projected_bounds_m.min);
	const exactMax = point(dimensions.projected_bounds_m.max);
	const left = Math.min(exactMin[0], exactMax[0]);
	const right = Math.max(exactMin[0], exactMax[0]);
	const top = Math.min(exactMin[1], exactMax[1]);
	const bottom = Math.max(exactMin[1], exactMax[1]);
	const heightX = 84.5;
	const intervalX = 144.5;
	const levelLeaderStartX = contentBounds.max_x + 36.5;
	const levelLeaderEndX = 2232.5;
	const levelLabelX = 2352;
	const groundY = contentBounds.max_y + 30.5;
	const widthY = contentBounds.max_y + 84.5;
	const facadeY = widthY + 60;
	const boxes = [];
	const labels = [];
	const displayed = [];
	const levelLines = [];
	for (const level of dimensions.levels) {
		const y = point(level.projected_endpoints_m[0])[1];
		boxes.push(textBox(level.id, levelLabelX, y + 7, 120, 22, "end"));
		labels.push(level.label);
		displayed.push({ id: level.id, label: level.label, display_mm: level.display_mm, source: level.source });
		levelLines.push(`${line(levelLeaderStartX, y, levelLeaderEndX, y, "level")}${text(level.label, levelLabelX, y + 7, `class="level-label" text-anchor="end" data-source-id="${escapeXml(level.id)}" data-display-mm="${level.display_mm}"`)}`);
	}
	const intervalParts = dimensions.floor_intervals.map((interval) => {
		const y1 = point(interval.projected_endpoints_m[0])[1];
		const y2 = point(interval.projected_endpoints_m[1])[1];
		const centre = (y1 + y2) / 2;
		boxes.push({ id: interval.id, min_x: 120, min_y: centre - 30, max_x: 143, max_y: centre + 30 });
		labels.push(String(interval.display_mm));
		displayed.push({ id: interval.id, label: String(interval.display_mm), display_mm: interval.display_mm, source: interval.source });
		return `${line(intervalX, y1, intervalX, y2)}${line(intervalX - 9, y1, intervalX + 9, y1)}${line(intervalX - 9, y2, intervalX + 9, y2)}${text(interval.display_mm, intervalX - 8, centre, `class="dimension-label halo" text-anchor="middle" transform="rotate(-90 ${intervalX - 8} ${centre})" data-source-id="${escapeXml(interval.id)}" data-display-mm="${interval.display_mm}"`)}`;
	});
	const overallMidY = (top + bottom) / 2;
	boxes.push({ id: "overall-height", min_x: 60, min_y: overallMidY - 34, max_x: 83, max_y: overallMidY + 34 });
	labels.push(String(dimensions.overall_height.display_mm));
	displayed.push({ id: "overall-height", label: String(dimensions.overall_height.display_mm), display_mm: dimensions.overall_height.display_mm, source: dimensions.overall_height.source });
	const overallHeight = `${line(heightX, top, heightX, bottom, "overall")}${line(heightX - 11, top, heightX + 11, top, "overall")}${line(heightX - 11, bottom, heightX + 11, bottom, "overall")}${text(dimensions.overall_height.display_mm, heightX - 8, overallMidY, `class="dimension-label halo" text-anchor="middle" transform="rotate(-90 ${heightX - 8} ${overallMidY})" data-source-id="overall-height" data-display-mm="${dimensions.overall_height.display_mm}"`)}`;
	const widthCentre = (left + right) / 2;
	boxes.push(textBox("facade-width", widthCentre, facadeY - 8, 72, 22));
	boxes.push(textBox("facade-height", right, facadeY + 32, 54, 22, "end"));
	boxes.push(textBox("overall-width", widthCentre, widthY - 8, 72, 22));
	labels.push(String(dimensions.facade_extent.width.display_mm), String(dimensions.overall_width.display_mm));
	displayed.push(
		{ id: "facade-width", label: String(dimensions.facade_extent.width.display_mm), display_mm: dimensions.facade_extent.width.display_mm, source: dimensions.facade_extent.width.source },
		{ id: "facade-height", label: String(dimensions.facade_extent.height.display_mm), display_mm: dimensions.facade_extent.height.display_mm, source: dimensions.facade_extent.height.source },
		{ id: "overall-width", label: String(dimensions.overall_width.display_mm), display_mm: dimensions.overall_width.display_mm, source: dimensions.overall_width.source },
	);
	const horizontalDimension = (id, y, value, className) => `${line(left, bottom + 12, left, y)}${line(right, bottom + 12, right, y)}${line(left, y, right, y, className)}${line(left, y - 9, left, y + 9, className)}${line(right, y - 9, right, y + 9, className)}${text(value, widthCentre, y - 8, `class="dimension-label halo" text-anchor="middle" data-source-id="${id}" data-display-mm="${value}"`)}`;
	const scaleBarPx = dimensions.scale_bar.value_m * scaleX;
	const scaleX0 = 215, scaleBarY = 1900.5;
	displayed.push({ id: "scale-bar", label: `${dimensions.scale_bar.value_m} m`, display_mm: dimensions.scale_bar.display_mm, source: dimensions.scale_bar.source });
	boxes.push(textBox("scale-bar-label", scaleX0 + scaleBarPx / 2, scaleBarY - 14, 82, 20));
	boxes.push(textBox("title", 120, 120, 520, 34, "start"));
	boxes.push(textBox("candidate", 120, 164, 420, 20, "start"));
	boxes.push(textBox("note", 215, 2240, 340, 20, "start"));
	const contentBox = { min_x: contentBounds.min_x, min_y: contentBounds.min_y, max_x: contentBounds.max_x + 1, max_y: contentBounds.max_y + 1 };
	const overlapsContent = boxes.some((box) => intersects(box, contentBox));
	const overlapsAnnotations = boxes.some((box, index) => boxes.slice(index + 1).some((other) => intersects(box, other)));
	const outsidePage = boxes.some((box) => box.min_x < PAGE_CLEARANCE || box.min_y < PAGE_CLEARANCE || box.max_x > width - PAGE_CLEARANCE || box.max_y > height - PAGE_CLEARANCE);
	if (overlapsContent || overlapsAnnotations || outsidePage) throw new Error("annotation layout unavailable: collision or page clearance");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>.dimension,.overall,.level{fill:none;stroke:#2c3032;stroke-width:1.4}.overall{stroke-width:2}.level{stroke:#596166;stroke-width:1}.dimension-label,.level-label,.note,.subtitle{font-family:Arial,sans-serif;fill:#25292b;font-size:20px}.title{font-family:Arial,sans-serif;fill:#202426;font-size:34px;font-weight:600;letter-spacing:4px}.subtitle,.note{font-size:18px;letter-spacing:1px}.halo{paint-order:stroke;stroke:#fafaf7;stroke-width:7px;stroke-linejoin:round}.ground{stroke:#1f2325;stroke-width:2.4}</style>
<g id="title">${text("FRONT ELEVATION", 120, 120, `class="title" text-anchor="start"`)}${text(`CANDIDATE ${String(candidateId).toUpperCase()} · COMPETITION WARM`, 120, 164, `class="subtitle" text-anchor="start"`)}</g>
<g id="ground-datum">${line(contentBounds.min_x - 36, groundY, contentBounds.max_x + 36, groundY, "ground")}</g>
<g id="levels">${levelLines.join("")}</g>
<g id="floor-intervals">${intervalParts.join("")}</g>
<g id="overall-height">${overallHeight}</g>
<g id="facade-extent">${horizontalDimension("facade-width", facadeY, dimensions.facade_extent.width.display_mm, "dimension")}${text("FACADE H", right - 72, facadeY + 32, `class="note" text-anchor="end"`)}${text(dimensions.facade_extent.height.display_mm, right, facadeY + 32, `class="dimension-label" text-anchor="end" data-source-id="facade-height" data-display-mm="${dimensions.facade_extent.height.display_mm}"`)}</g>
<g id="overall-width">${horizontalDimension("overall-width", widthY, dimensions.overall_width.display_mm, "overall")}</g>
<g id="scale-bar">${line(scaleX0, scaleBarY, scaleX0 + scaleBarPx, scaleBarY, "overall")}${line(scaleX0, scaleBarY - 9, scaleX0, scaleBarY + 9, "overall")}${line(scaleX0 + scaleBarPx, scaleBarY - 9, scaleX0 + scaleBarPx, scaleBarY + 9, "overall")}${text(`${dimensions.scale_bar.value_m} m`, scaleX0 + scaleBarPx / 2, scaleBarY - 14, `class="dimension-label" text-anchor="middle" data-source-id="scale-bar" data-display-mm="${dimensions.scale_bar.display_mm}"`)}</g>
<g id="notes">${text(NOTE, 215, 2240, `class="note" text-anchor="start"`)}</g>
</svg>`;
	return {
		schema_version: "arr.elevation3d.elevation-annotations.v1",
		svg,
		labels,
		level_labels: dimensions.levels.map((level) => level.label),
		note: NOTE,
		overlaps_content: overlapsContent,
		overlaps_annotations: overlapsAnnotations,
		min_page_clearance_px: PAGE_CLEARANCE,
		annotation_boxes: boxes,
		displayed_dimensions: displayed,
	};
}
