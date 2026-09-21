import { WALL_TILT_NZ_LIMIT } from '../../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs';

/** Measure what the placeable rectangles omit; the source mesh is read, never changed.
 * The same wall/roof discriminator as the authority keeps numerator and denominator
 * comparable. This is surface area, not visibility or a photographic-fidelity score. */
export function measureFacadeCoverage(mesh, facets) {
  let wallArea = 0;
  for (const triangle of mesh.triangles) {
    const [a,b,c] = triangle.map(i => mesh.vertices[i]);
    const u=b.map((x,i)=>x-a[i]), v=c.map((x,i)=>x-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...n);
    if (length && Math.abs(n[2])/length <= WALL_TILT_NZ_LIMIT) wallArea += length/2;
  }
  const rectangleArea=facets.reduce((sum,s)=>sum+s.length_m*(s.local_z[1]-s.local_z[0])/
    Math.hypot(s.outward_normal[0],s.outward_normal[1]),0);
  return { wall_area_m2:wallArea, placeable_rectangle_area_m2:rectangleArea,
    covered_fraction:wallArea ? rectangleArea/wallArea : null,
    missing_area_m2:Math.max(0,wallArea-rectangleArea),
    meaning:'Placeable rectangles versus all eligible wall triangles; excludes roof, does not measure occlusion.' };
}
