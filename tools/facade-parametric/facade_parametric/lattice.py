"""Where the cells go: p(i,j) = origin + i*a + j*b + stagger(j). Basis vectors are free vectors in
host metres, so a diagonal honeycomb is one lattice, not rows with hand-written half cells."""


def cell_centres(lattice):
    ox, oy = lattice["origin_uv_m"]
    ax, ay = lattice["basis_a_uv_m"]
    bx, by = lattice["basis_b_uv_m"]
    stagger = lattice["stagger_a_fraction"]
    cells = []
    indices=lattice.get('active_indices')
    if indices is None:
        indices=((i,j) for j in range(lattice['rows']) for i in range(lattice['columns']))
    for i,j in indices:
        shift = stagger if j % 2 else 0.0
        u = ox + (i + shift) * ax + j * bx
        v = oy + (i + shift) * ay + j * by
        cells.append((i, j, u, v))
    return cells


def inside_rect(points, width, height, margin=0.0):
    return all(margin <= x <= width - margin and margin <= y <= height - margin for x, y in points)


def _intersect(a, b, axis, value):
    other = 1 - axis
    t = (value - a[axis]) / (b[axis] - a[axis])
    point = [0.0, 0.0]
    point[axis] = value
    point[other] = a[other] + t * (b[other] - a[other])
    return point


def clip_polygon(points, width, height):
    """Sutherland-Hodgman against the host rectangle. Returns a closed polygon (first==last) or []."""
    ring = points[:-1] if len(points) > 1 and points[0] == points[-1] else list(points)
    edges = [
        (lambda p: p[0] >= 0, lambda a, b: _intersect(a, b, 0, 0)),
        (lambda p: p[0] <= width, lambda a, b: _intersect(a, b, 0, width)),
        (lambda p: p[1] >= 0, lambda a, b: _intersect(a, b, 1, 0)),
        (lambda p: p[1] <= height, lambda a, b: _intersect(a, b, 1, height)),
    ]
    for keep, cut in edges:
        if not ring:
            return []
        out = []
        prev = ring[-1]
        for point in ring:
            if keep(point):
                if not keep(prev):
                    out.append(cut(prev, point))
                out.append(point)
            elif keep(prev):
                out.append(cut(prev, point))
            prev = point
        ring = out
    return ring + [ring[0]] if ring else []


def inside_void(point, void):
    """Is a cell centre inside a design void (ellipse or polygon, host metres)?"""
    x, y = point
    if void["kind"] == "ellipse":
        cx, cy = void["center_uv_m"]; rx, ry = void["radii_m"]
        return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0
    hit = False
    poly = void["polygon_uv_m"]
    for i in range(len(poly)):
        ax, ay = poly[i]; bx, by = poly[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            hit = not hit
    return hit
