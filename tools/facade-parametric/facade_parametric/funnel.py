"""The cell as a MODULE, not a hole.

The Broad's veil is not a wall with lens-shaped holes in it: every cell is a funnel whose MOUTH
is the lattice's own tile (the rhombus the cell owns, less half a web on every side), whose
surface flows inward to a THROAT (the family curve, the lens) at depth, and whose crests - where
neighbouring funnels meet - are the diagonal webs the photograph shows. The parapet's sawtooth
silhouette is those funnels cut by the roof line. Read as holes, the drawing showed the throats
and nothing else (the user: "입면이 3차원이잖아").

So a family may declare a `mouth`: the Wigner-Seitz tile of its lattice, inset by half the web,
clipped to the host. The evaluator then emits two loops per cell with the SAME number of points
in the same angular order about the centre - the mouth and the throat - which is the form the 3D
engine's tapered prism already reads (`outline` / `outline_far`, vertex i travels to vertex i).
"""
import math

from shapely.geometry import Point, Polygon, box as shapely_box


def _clip_halfplane(ring, centre, neighbour):
    """Keep the side of the perpendicular bisector between centre and neighbour that holds centre."""
    cx, cy = centre
    nx, ny = neighbour[0] - cx, neighbour[1] - cy
    limit = (nx * nx + ny * ny) / 2.0
    inside = lambda p: (p[0] - cx) * nx + (p[1] - cy) * ny <= limit + 1e-12
    out = []
    prev = ring[-1]
    for point in ring:
        if inside(point):
            if not inside(prev):
                out.append(_cross(prev, point, centre, nx, ny, limit))
            out.append(point)
        elif inside(prev):
            out.append(_cross(prev, point, centre, nx, ny, limit))
        prev = point
    return out


def _cross(a, b, centre, nx, ny, limit):
    fa = (a[0] - centre[0]) * nx + (a[1] - centre[1]) * ny - limit
    fb = (b[0] - centre[0]) * nx + (b[1] - centre[1]) * ny - limit
    t = fa / (fa - fb)
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]


def wigner_seitz(centre, neighbours, radius):
    """The tile of `centre` against `neighbours` (absolute positions): the intersection of the
    half-planes nearer to it than to each neighbour, started from a square of `radius`."""
    cx, cy = centre
    ring = [[cx - radius, cy - radius], [cx + radius, cy - radius], [cx + radius, cy + radius], [cx - radius, cy + radius]]
    for neighbour in neighbours:
        if not ring:
            break
        ring = _clip_halfplane(ring, centre, neighbour)
    return ring


def angle_set(rings, centre, count, min_gap_deg=2.0):
    """The angles a funnel's rings are sampled at, shared so vertex i partners vertex i: every
    vertex of the first ring (the mouth - a parallelogram's acute corners would otherwise be cut
    off by uniform rays and leave glass triangles between neighbouring modules), the farthest
    vertex of each other ring (a lens's tips), then uniform fill up to `count`."""
    cx, cy = centre
    angles = []
    def add(angle):
        angle %= 2 * math.pi
        if all(min(abs(angle - a), 2 * math.pi - abs(angle - a)) >= math.radians(min_gap_deg) for a in angles):
            angles.append(angle)
    first = rings[0]
    for x, y in (first[:-1] if len(first) > 1 and first[0] == first[-1] else first):
        add(math.atan2(y - cy, x - cx))
    for ring in rings[1:]:
        pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
        for x, y in sorted(pts, key=lambda p: -((p[0] - cx) ** 2 + (p[1] - cy) ** 2))[:2]:
            add(math.atan2(y - cy, x - cx))
    angles = angles[:count]
    k = 0
    while len(angles) < count and k < 4 * count:
        add(2 * math.pi * k / count)
        k += 1
    return sorted(angles)


def resample_at(polygon, centre, angles):
    """Points where rays from `centre` at `angles` leave the polygon (its farthest crossing)."""
    cx, cy = centre
    ring = polygon[:-1] if len(polygon) > 1 and polygon[0] == polygon[-1] else list(polygon)
    out = []
    for angle in angles:
        dx, dy = math.cos(angle), math.sin(angle)
        best = None
        for i in range(len(ring)):
            ax, ay = ring[i]
            bx, by = ring[(i + 1) % len(ring)]
            ex, ey = bx - ax, by - ay
            denominator = dx * ey - dy * ex
            if abs(denominator) < 1e-12:
                continue
            t = ((ax - cx) * ey - (ay - cy) * ex) / denominator
            s = ((ax - cx) * dy - (ay - cy) * dx) / denominator
            if t > 0 and -1e-9 <= s <= 1 + 1e-9:
                best = t if best is None else max(best, t)
        if best is None:
            raise ValueError("the outline does not surround its centre; a funnel needs a star-shaped mouth and throat")
        out.append([round(cx + dx * best, 6), round(cy + dy * best, 6)])
    return out


def resample_by_angle(polygon, centre, count, start_deg=0.0):
    """`count` points at equal angles (kept for callers that have one ring to sample)."""
    return resample_at(polygon, centre, [math.radians(start_deg) + 2 * math.pi * k / count for k in range(count)])


def funnel_loops(centre, tile, throat, host_width, host_height, web_m, count, clip_host=True):
    """(mouth, throat, shrink, tile) as closed loops with `count` corresponding points, or None
    when the cell's mouth has nothing left inside the host (or the throat could not fit in it).
    The TILE is the cell's whole footprint - the module's outer boundary when the cell is built
    as a solid; the mouth is the tile less half a web."""
    footprint = Polygon(tile)
    if clip_host:
        footprint = footprint.intersection(shapely_box(0, 0, host_width, host_height))
    if footprint.is_empty or footprint.geom_type != "Polygon":
        return None
    mouth = footprint
    if web_m > 0:
        mouth = mouth.buffer(-web_m / 2, join_style=2)
        if mouth.is_empty or mouth.geom_type != "Polygon":
            return None
    if not mouth.contains(Point(centre)):
        return None
    throat_polygon = Polygon(throat)
    # The throat sits inside the mouth. A throat wider than the tile (a field pushed it) is
    # brought in about the centre in steps, and the step is what the report will say.
    shrink = 1.0
    while not mouth.contains(throat_polygon) and shrink > 0.3:
        shrink *= 0.92
        throat_polygon = Polygon([[centre[0] + (x - centre[0]) * shrink, centre[1] + (y - centre[1]) * shrink] for x, y in throat[:-1]])
    if not mouth.contains(throat_polygon):
        return None
    mouth_ring = [[x, y] for x, y in mouth.exterior.coords]
    throat_ring = [[x, y] for x, y in throat_polygon.exterior.coords]
    tile_ring = [[x, y] for x, y in footprint.exterior.coords]
    angles = angle_set([mouth_ring, throat_ring, tile_ring], centre, count)
    mouth_points = resample_at(mouth_ring, centre, angles)
    throat_points = resample_at(throat_ring, centre, angles)
    tile_points = resample_at(tile_ring, centre, angles)
    return mouth_points + [mouth_points[0]], throat_points + [throat_points[0]], shrink, tile_points + [tile_points[0]]
