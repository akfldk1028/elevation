/** Sample the FIRST mass surface hit by an elevation ray, then ask whether a
 * placeable facet rectangle contains it. This checks the omitted-patch hypothesis
 * without modifying the mass, the facade, any camera, or a validation gate. */
import * as THREE from 'three';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFacadeContext } from './prepare.mjs';
import { WALL_TILT_NZ_LIMIT } from '../../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs';

const candidateId=process.argv[2], view=process.argv[3] ?? 'front';
if (!candidateId) throw new Error('usage: measure-visible-coverage.mjs <candidate> [view]');
const {candidate,context,runDir}=await prepareFacadeContext({candidateId});
const axes=candidate.cameras.views[view].projection_axes;
const h=new THREE.Vector3(...axes.horizontal).normalize();
const v=new THREE.Vector3(...axes.vertical).normalize();
const depth=new THREE.Vector3(...axes.depth).normalize();
const points=candidate.mesh.vertices.map(p=>new THREE.Vector3(...p));
const ranges=[h,v,depth].map(axis=>{const values=points.map(p=>p.dot(axis));return [Math.min(...values),Math.max(...values)];});
const geometry=new THREE.BufferGeometry();
geometry.setAttribute('position',new THREE.Float32BufferAttribute(candidate.mesh.vertices.flat(),3));
geometry.setIndex(candidate.mesh.triangles.flat());
const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
mesh.updateMatrixWorld();
const ray=new THREE.Raycaster(), grid=128;
let wall=0,covered=0,other=0;
const omitted=[];
const facets=context.facade_segments.map(s=>({s,o:new THREE.Vector3(...s.origin_m),
  n:new THREE.Vector3(...s.outward_normal),
  t:new THREE.Vector3(-s.outward_normal[1],s.outward_normal[0],0).normalize()}));
for(let j=0;j<grid;j++)for(let i=0;i<grid;i++){
  const x=ranges[0][0]+(i+.5)/grid*(ranges[0][1]-ranges[0][0]);
  const y=ranges[1][0]+(j+.5)/grid*(ranges[1][1]-ranges[1][0]);
  const origin=h.clone().multiplyScalar(x).addScaledVector(v,y).addScaledVector(depth,ranges[2][0]-1);
  ray.set(origin,depth);
  const hit=ray.intersectObject(mesh,false)[0];
  if(!hit)continue;
  if(Math.abs(hit.face.normal.z)>WALL_TILT_NZ_LIMIT){other++;continue;}
  wall++;
  // Micrometre geometric tolerance plus float32 ray-intersection roundoff. This
  // is a diagnostic sample, never the compiler's exact backing check.
  const inside=facets.some(({s,o,n,t})=>{
    const delta=hit.point.clone().sub(o), u=delta.dot(t);
    return Math.abs(delta.dot(n))<1e-5 && u>=-1e-5 && u<=s.length_m+1e-5
      && hit.point.z>=s.local_z[0]-1e-5 && hit.point.z<=s.local_z[1]+1e-5;
  });
  if(inside)covered++;else if(omitted.length<16)omitted.push(hit.point.toArray());
}
const report={candidate:candidateId,view,grid,wall_samples:wall,covered_samples:covered,
  uncovered_fraction:wall ? (wall-covered)/wall : null,other_surface_samples:other,omitted_sample_points:omitted};
await writeFile(join(runDir,`visible-coverage-${view}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
