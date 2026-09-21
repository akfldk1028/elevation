/** Continuous affine lattice charts on authority wall patches.
 * U = a*u + b*worldZ + c, V = worldZ. Dimensioning face labels seed the
 * registration; they do not prescribe final seams. Shared edges are stitched
 * greedily without worsening the initial worst affine deformation. Remaining
 * cuts are explicit, including cuts inside an otherwise connected chart.
 */
const dot = (a,b) => a.reduce((v,x,i)=>v+x*b[i],0);

// RREF produces an exact constraint nullspace, avoiding penalty seam errors.
function nullspace(rows,n) {
  const m=rows.map(r=>r.slice()), pivots=[];let rank=0;
  for(let col=0;col<n && rank<m.length;col++) {
    let best=rank;for(let j=rank+1;j<m.length;j++) if(Math.abs(m[j][col])>Math.abs(m[best][col])) best=j;
    if(Math.abs(m[best][col])<1e-9) continue;
    [m[rank],m[best]]=[m[best],m[rank]];
    const scale=m[rank][col];for(let k=col;k<n;k++) m[rank][k]/=scale;
    for(let j=0;j<m.length;j++) if(j!==rank) {const v=m[j][col];if(!v)continue;for(let k=col;k<n;k++)m[j][k]-=v*m[rank][k];}
    pivots.push(col);rank++;
  }
  const free=Array.from({length:n},(_,i)=>i).filter(i=>!pivots.includes(i));
  return free.map(col=>{const v=Array(n).fill(0);v[col]=1;pivots.forEach((p,j)=>v[p]=-m[j][col]);return v;});
}

// Twice-reorthogonalized QR; dependent columns are translation gauges.
function leastSquares(columns,target) {
  const q=[],r=[],retained=[];
  for(let j=0;j<columns.length;j++) {
    const v=columns[j].slice(),coeff=Array(q.length).fill(0);
    for(let pass=0;pass<2;pass++) for(let k=0;k<q.length;k++) {const c=dot(q[k],v);coeff[k]+=c;v.forEach((_,i)=>v[i]-=c*q[k][i]);}
    const norm=Math.sqrt(dot(v,v));if(norm<1e-9)continue;
    coeff.push(norm);r.push(coeff);q.push(v.map(x=>x/norm));retained.push(j);
  }
  const weights=q.map(v=>dot(v,target));
  for(let i=q.length-1;i>=0;i--) {for(let j=i+1;j<q.length;j++) weights[i]-=r[j][i]*weights[j];weights[i]/=r[i][i];}
  const out=Array(columns.length).fill(0);retained.forEach((j,i)=>out[j]=weights[i]);return out;
}

function worldVertex(segment,[u,z]) {
  const n=segment.outward_normal,o=segment.origin_m,h=Math.hypot(n[0],n[1]);
  if(!(h>0))throw new Error('wall chart requires a nonhorizontal authority plane');
  return [o[0]-n[1]/h*u-n[0]*n[2]/(h*h)*(z-o[2]),o[1]+n[0]/h*u-n[1]*n[2]/(h*h)*(z-o[2]),z];
}
const distortion = x => Math.max(...x.flatMap((v,i)=>i%3===0?[Math.abs(v-1)]:i%3===1?[Math.abs(v)]:[]));
const valueAt=(x,{i,u,z})=>x[3*i]*u+x[3*i+1]*z+x[3*i+2];

export function registerWallCharts(segments) {
  if(!segments.length)throw new Error('wall chart requires segments');
  const vertices=[];
  for(const [i,s] of segments.entries()) {
    if(!s.wall_patch?.rings?.length || !s.face_view)throw new Error('wall chart requires authority patch and face_view');
    for(const ring of s.wall_patch.rings) for(const p of ring) {
      const xyz=worldVertex(s,p);
      let vertex=vertices.find(v=>Math.hypot(...v.xyz.map((x,k)=>x-xyz[k]))<1e-5);
      if(!vertex){vertex={xyz,uses:[]};vertices.push(vertex);}
      if(!vertex.uses.some(v=>v.i===i))vertex.uses.push({i,u:p[0],z:p[1]});
    }
  }
  const n=3*segments.length,initialShared=[],cutPairs=new Map();
  for(const vertex of vertices)for(let j=0;j<vertex.uses.length;j++)for(let k=j+1;k<vertex.uses.length;k++) {
    const a=vertex.uses[j],b=vertex.uses[k],constraint={a,b};
    if(segments[a.i].face_view===segments[b.i].face_view)initialShared.push(constraint);
    else {
      const ids=[segments[a.i].segment_id,segments[b.i].segment_id].sort(),key=ids.join('|');
      if(!cutPairs.has(key))cutPairs.set(key,{key,segments:ids,vertices:[],constraints:[]});
      cutPairs.get(key).vertices.push(vertex.xyz);cutPairs.get(key).constraints.push(constraint);
    }
  }
  function solve(shared) {
    const constraints=shared.map(({a,b})=>{const row=Array(n).fill(0);row.splice(a.i*3,3,a.u,a.z,1);row.splice(b.i*3,3,-b.u,-b.z,-1);return row;});
    const basis=nullspace(constraints,n),objective=basis.map(v=>v.filter((_,i)=>i%3!==2));
    const weights=leastSquares(objective,segments.flatMap(()=>[1,0]));
    const x=Array(n).fill(0);basis.forEach((v,j)=>v.forEach((t,i)=>x[i]+=t*weights[j]));
    return {x,distortion:distortion(x),error:Math.max(0,...shared.map(({a,b})=>Math.abs(valueAt(x,a)-valueAt(x,b)))),
      positive:x.every((v,i)=>Number.isFinite(v)&&(i%3!==0||v>1e-8))};
  }
  const edges=[...cutPairs.values()].filter(c=>c.vertices.length>=2).map(c=>({...c,
    length_m:Math.max(...c.vertices.flatMap(a=>c.vertices.map(b=>Math.hypot(...a.map((x,i)=>x-b[i])))))}));
  edges.sort((a,b)=>Math.abs(b.length_m-a.length_m)>1e-5?b.length_m-a.length_m:a.key.localeCompare(b.key));
  let shared=initialShared.slice(),solution=solve(shared);
  const referenceDistortion=solution.distortion;
  // Floating-point allowance scales with dense elimination operation count,
  // not with a building or a permissible architectural deformation.
  const metricTolerance=64*Number.EPSILON*n*n;
  const stitched=new Set(),attempts=[];
  let changed=true;
  while(changed) {
    changed=false;
    for(const edge of edges) {
      if(stitched.has(edge.key))continue;
      const candidateShared=[...shared,...edge.constraints],candidate=solve(candidateShared);
      const accepted=candidate.positive&&candidate.error<=1e-8&&candidate.distortion<=referenceDistortion+metricTolerance;
      attempts.push({segments:edge.segments,accepted,max_metric_distortion:candidate.distortion});
      if(accepted){shared=candidateShared;solution=candidate;stitched.add(edge.key);changed=true;}
    }
  }
  // Joining an edge unifies chart packing, but DOES NOT constrain another edge
  // merely because both its sides now belong to the same connected chart.
  const chartParents=new Map(segments.map(s=>[s.face_view,s.face_view]));
  const find=x=>chartParents.get(x)===x?x:find(chartParents.get(x));
  for(const edge of edges)if(stitched.has(edge.key)) {
    const {a,b}=edge.constraints[0],left=find(segments[a.i].face_view),right=find(segments[b.i].face_view);
    if(left!==right){const ids=[left,right].sort();chartParents.set(ids[1],ids[0]);}
  }
  const chartNames=new Map();
  for(const label of chartParents.keys()){const id=find(label);if(!chartNames.has(id))chartNames.set(id,[]);chartNames.get(id).push(label);}
  const mappings=segments.map((s,i)=>({segment_id:s.segment_id,chart_id:chartNames.get(find(s.face_view)).sort().join('+'),affine:solution.x.slice(i*3,i*3+3)}));
  const charts=[];let width=0;
  for(const chart of [...new Set(mappings.map(m=>m.chart_id))].sort()) {
    const ids=mappings.flatMap((m,i)=>m.chart_id===chart?[i]:[]);
    const values=ids.flatMap(i=>segments[i].wall_patch.rings.flat().map(([u,z])=>{const [a,b,c]=mappings[i].affine;return a*u+b*z+c;}));
    const lo=Math.min(...values),hi=Math.max(...values);
    ids.forEach(i=>mappings[i].affine[2]+=width-lo);
    charts.push({chart_id:chart,u_min_m:width,u_max_m:width+hi-lo,width_m:hi-lo});width+=hi-lo;
  }
  const at=({i,u,z})=>{const [a,b,c]=mappings[i].affine;return a*u+b*z+c;};
  const maxError=Math.max(0,...shared.map(({a,b})=>Math.abs(at(a)-at(b))));
  if(maxError>1e-6)throw new Error(`wall chart shared seam residual ${maxError}`);
  if(!solution.positive)throw new Error('wall chart mapping is inverted or degenerate');
  const describe=edge=>({segments:edge.segments,vertices:edge.vertices,length_m:edge.length_m,
    max_endpoint_gap_m:Math.max(...edge.constraints.map(({a,b})=>Math.abs(at(a)-at(b))))});
  const remaining=edges.filter(e=>!stitched.has(e.key)).map(describe);
  return {segments:mappings,charts,width_m:width,diagnostics:{max_shared_seam_error_m:maxError,
    shared_vertex_constraints:shared.length,chart_count:charts.length,
    horizontal_scale_range:[Math.min(...mappings.map(m=>m.affine[0])),Math.max(...mappings.map(m=>m.affine[0]))],
    max_abs_shear:Math.max(...mappings.map(m=>Math.abs(m.affine[1]))),
    initial_chart_cut_count:edges.length,remaining_chart_cut_count:remaining.length,
    stitched_edges:edges.filter(e=>stitched.has(e.key)).map(describe),stitch_attempts:attempts,
    metric_distortion_measure:'max(abs(a-1),abs(b))',initial_max_metric_distortion:referenceDistortion,
    max_metric_distortion:solution.distortion,numeric_metric_tolerance:metricTolerance,
    chart_cuts:remaining,period_m:null,
    closure:'explicit unstitched source edges, including cuts within connected charts; no global periodicity claimed'}};
}

