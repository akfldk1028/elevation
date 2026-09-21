/** Shared source-vertex offsets for wall-patch modules. A single displacement
 * field on the unchanged authority triangulation closes outward fold edges.
 * At nondevelopable vertices, >3 plane offsets may be incompatible: the common
 * least-squares displacement is retained and its depth error is reported.
 */
const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

function displacementFor(normals) {
 const a=Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>normals.reduce((v,n)=>v+n[i]*n[j],0)));
 const rhs=[0,1,2].map(i=>normals.reduce((v,n)=>v+n[i],0));
 const vectors=[[1,0,0],[0,1,0],[0,0,1]];
 // Jacobi eigendecomposition of the symmetric 3x3 normal equation; the
 // pseudoinverse gives minimum norm for one plane or a two-plane crease.
 for(let iteration=0;iteration<40;iteration++) {
  let p=0,q=1;for(const [i,j] of [[0,2],[1,2]])if(Math.abs(a[i][j])>Math.abs(a[p][q])){p=i;q=j;}
  if(Math.abs(a[p][q])<Number.EPSILON*Math.max(1,...a.map((r,i)=>Math.abs(r[i]))))break;
  const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle);
  const ap=a[p][p],aq=a[q][q],off=a[p][q];
  a[p][p]=c*c*ap-2*s*c*off+s*s*aq;a[q][q]=s*s*ap+2*s*c*off+c*c*aq;a[p][q]=a[q][p]=0;
  for(let k=0;k<3;k++)if(k!==p&&k!==q){const x=a[k][p],y=a[k][q];a[k][p]=a[p][k]=c*x-s*y;a[k][q]=a[q][k]=s*x+c*y;}
  for(let k=0;k<3;k++){const x=vectors[k][p],y=vectors[k][q];vectors[k][p]=c*x-s*y;vectors[k][q]=s*x+c*y;}
 }
 const largest=Math.max(...a.map((r,i)=>r[i])),out=[0,0,0];
 for(let j=0;j<3;j++)if(a[j][j]>largest*Number.EPSILON*64){const v=vectors.map(r=>r[j]),scale=dot(v,rhs)/a[j][j];out.forEach((_,i)=>out[i]+=v[i]*scale);}
 if(!out.every(Number.isFinite)||Math.hypot(...out)>1/Math.sqrt(Number.EPSILON)||normals.some(n=>dot(n,out)<=0))throw new Error('unstable or inward wall miter');
 return out;
}
function sourcePoint(plane,[u,z]) {
 const o=plane.origin??plane.origin_m,n=plane.normal??plane.outward_normal,h=Math.hypot(n[0],n[1]);
 return [o[0]-n[1]/h*u-n[0]*n[2]/(h*h)*(z-o[2]),o[1]+n[0]/h*u-n[1]*n[2]/(h*h)*(z-o[2]),z];
}
function barycentric(p,t) {
 const a=t[0],v=sub(t[1],a),w=sub(t[2],a),q=sub(p,a),den=v[0]*w[1]-v[1]*w[0];
 if(Math.abs(den)<1e-14)throw new Error('degenerate source wall triangle');
 const b=(q[0]*w[1]-q[1]*w[0])/den,c=(v[0]*q[1]-v[1]*q[0])/den;return [1-b-c,b,c];
}

export function buildWallMiter({patches,planes,depth_m,max_projection_m}) {
 const byPlane=new Map((planes.facade_planes??planes).map(p=>[p.segment_id,p]));
 let vertices=[];const byPatch=new Map();
 for(const patch of patches) {
  const plane=byPlane.get(patch.segment_id);if(!plane)throw new Error('wall miter lacks source plane');
  const raw=plane.normal??plane.outward_normal,length=Math.hypot(...raw),normal=raw.map(x=>x/length);
  const triangles=patch.triangles.map(t=>({local:t,vertices:t.map(p=>{
   const xyz=sourcePoint(plane,p);let vertex=vertices.find(v=>Math.hypot(...sub(v.xyz,xyz))<1e-5);
   if(!vertex){vertex={xyz,normals:new Map()};vertices.push(vertex);}
   vertex.normals.set(patch.segment_id,normal);return vertex;
  })}));
  byPatch.set(patch.segment_id,{normal,triangles});
 }
 // A coincident point is not sufficient to join separate surface fans. Connect
 // incident patches only when they also share a complete source edge.
 const sourceVertexCount=vertices.length,fanVertices=[];
 for(const vertex of vertices) {
  const incident=[];
  for(const [id,patch] of byPatch)for(const triangle of patch.triangles)if(triangle.vertices.includes(vertex))incident.push({id,triangle});
  const pending=new Set(vertex.normals.keys());
  while(pending.size) {
   const seed=pending.values().next().value,component=new Set([seed]);pending.delete(seed);
   let changed=true;while(changed){changed=false;for(const id of pending)if(incident.some(a=>a.id===id&&incident.some(b=>component.has(b.id)&&a.triangle.vertices.filter(v=>v!==vertex).some(v=>b.triangle.vertices.includes(v))))){component.add(id);pending.delete(id);changed=true;}}
   const fan={xyz:vertex.xyz,normals:new Map([...vertex.normals].filter(([id])=>component.has(id)))};
   for(const {id,triangle} of incident)if(component.has(id))triangle.vertices=triangle.vertices.map(v=>v===vertex?fan:v);
   fanVertices.push(fan);
  }
 }
 vertices=fanVertices;
 const zMin=Math.min(...vertices.map(v=>v.xyz[2])),zMax=Math.max(...vertices.map(v=>v.xyz[2]));
 for(const vertex of vertices) {
  const boundary=vertex.xyz[2]===zMin||vertex.xyz[2]===zMax;
  vertex.d=displacementFor([...vertex.normals.values()].map(n=>boundary?[n[0],n[1],0]:n));
  vertex.original_d=vertex.d.slice();vertex.taper=1;
  if(max_projection_m!==undefined) {
   if(!(max_projection_m>0&&depth_m>0))throw new Error('bounded wall miter requires positive depth and projection envelope');
   vertex.taper=Math.min(1,max_projection_m/(depth_m*Math.hypot(...vertex.d)));
   vertex.d=vertex.d.map(x=>x*vertex.taper);
  }
 }
 function displacement(segmentId,p) {
  const patch=byPatch.get(segmentId);if(!patch)throw new Error('unknown wall miter segment');
  // Float32 module vertices can lie a quantization step outside the triangle.
  const tolerance=Math.max(1,...p.map(Math.abs))*2**-21;
  let best=null,bestScore=-Infinity;
  for(const t of patch.triangles) {const weights=barycentric(p,t.local),score=Math.min(...weights);if(score>bestScore){best={t,weights};bestScore=score;}}
  if(!best||bestScore < -tolerance)throw new Error('wall miter point outside source triangulation');
  return [0,1,2].map(i=>best.weights.reduce((sum,w,k)=>sum+w*best.t.vertices[k].d[i],0));
 }
 function invertedTriangles(depth) {
  if(!Number.isFinite(depth)||depth<0)throw new Error('invalid wall miter depth');
  const inverted=[];
  for(const patch of byPatch.values())for(const t of patch.triangles) {
   const [a,b,c]=t.vertices,e=sub(b.xyz,a.xyz),f=sub(c.xyz,a.xyz),g=sub(b.d,a.d),h=sub(c.d,a.d);
   // Check both front orientation and the full volumetric Jacobian. Its
   // dependence on source barycentrics is affine, so the three vertices bound
   // the complete triangle; its depth dependence is quadratic.
   const invalid=[patch.normal,a.d,b.d,c.d].some(direction=>{
    const base=dot(cross(e,f),direction),linear=dot(cross(g,f),direction)+dot(cross(e,h),direction),quadratic=dot(cross(g,h),direction);
    const ratio=x=>(base+linear*x+quadratic*x*x)/base;
    const samples=[0,depth],turn=-linear/(2*quadratic);if(turn>0&&turn<depth)samples.push(turn);
    return samples.some(x=>ratio(x)<=Number.EPSILON*64);
   });
   if(invalid)inverted.push(t);
  }
  return inverted;
 }
 function assertDepth(depth) {
  if(invertedTriangles(depth).length)throw new Error('wall miter depth inverts source triangle');
  return true;
 }
 let taperIterations=0;
 if(max_projection_m!==undefined) {
  // Backtrack only vertices of locally inverted triangles. Every incident wall
  // uses the SAME changed vertex vector, retaining all shared-edge positions.
  // 52 halvings reach double-precision scale; failure still refuses the result.
  for(;taperIterations<52;taperIterations++) {
   const bad=invertedTriangles(depth_m);if(!bad.length)break;
   for(const vertex of new Set(bad.flatMap(t=>t.vertices))){vertex.taper*=.5;vertex.d=vertex.d.map(x=>x*.5);}
  }
 }
 if(depth_m!==undefined)assertDepth(depth_m);
 const factors=vertices.flatMap(v=>[...v.normals.values()].map(n=>dot(n,v.d)));
 const diagnostics={max_vector_norm:Math.max(0,...vertices.map(v=>Math.hypot(...v.d))),
  max_normal_depth_relative_error:Math.max(0,...factors.map(x=>Math.abs(x-1))),
  source_vertex_count:sourceVertexCount,surface_fan_count:vertices.length,
  tapered_vertex_count:vertices.filter(v=>v.taper<1).length,taper_iterations:taperIterations,
  normal_depth_factor_range:[Math.min(...factors),Math.max(...factors)],
  nonexact_vertex_count:vertices.filter(v=>[...v.normals.values()].some(n=>Math.abs(dot(n,v.d)-1)>1e-7)).length,
  max_abs_vertical_displacement_per_m:Math.max(0,...vertices.map(v=>Math.abs(v.d[2]))),
  boundary_z_m:[zMin,zMax],boundary_vertical_displacement:0};
 if(depth_m!==undefined) {
  diagnostics.normal_depth_range_m=diagnostics.normal_depth_factor_range.map(x=>x*depth_m);
  diagnostics.max_normal_depth_deviation_m=diagnostics.max_normal_depth_relative_error*depth_m;
  diagnostics.max_projection_m=diagnostics.max_vector_norm*depth_m;
 }
 return {displacement,assertDepth,diagnostics};
}
