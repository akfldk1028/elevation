import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runDirFor} from '../tools/facade-pipeline/config.mjs';
import {buildWallMiter} from '../plugins/elevation-3d/lib/facade-agent/wall-miter.mjs';
const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
const close=(a,b)=>assert.ok(Math.hypot(...a.map((x,i)=>x-b[i]))<1e-10,`${a} != ${b}`);
function patch(id,triangle){return {segment_id:id,triangles:[triangle]};}

test('two folded walls have one identical front edge at exactly the specified normal depths',()=>{
 const planes=[{segment_id:'a',origin:[0,0,0],normal:[0,-1,0]},{segment_id:'b',origin:[0,0,0],normal:[1,0,0]}];
 const patches=planes.map(p=>patch(p.segment_id,[[0,0],[2,0],[0,4]]));
 const before=JSON.stringify({planes,patches}),m=buildWallMiter({planes,patches,depth_m:.45});
 for(const z of [0,.7,2,4]){
  const a=m.displacement('a',[0,z]),b=m.displacement('b',[0,z]);close(a,b);close(a,[1,-1,0]);
  for(const plane of planes)assert.ok(Math.abs(dot(plane.normal,a)-1)<1e-12);
 }
 assert.equal(JSON.stringify({planes,patches}),before);
 assert.ok(Math.abs(m.diagnostics.max_vector_norm-Math.sqrt(2))<1e-12);
});

test('battered adjacent courses share their front edge and source height boundaries remain fixed',()=>{
 const h=Math.sqrt(1.01),planes=[{segment_id:'low',origin:[0,0,0],normal:[0,-1/h,.1/h]},
  {segment_id:'high',origin:[0,.2,2],normal:[0,-1/h,-.1/h]}];
 const patches=[patch('low',[[0,0],[2,2],[0,2]]),patch('high',[[0,2],[2,2],[0,4]])];
 const m=buildWallMiter({planes,patches,depth_m:.45});
 for(const u of [0,.5,2]){const a=m.displacement('low',[u,2]),b=m.displacement('high',[u,2]);close(a,b);for(const p of planes)assert.ok(Math.abs(dot(p.normal,a)-1)<1e-12);}
 assert.equal(m.displacement('low',[0,0])[2],0);assert.equal(m.displacement('high',[0,4])[2],0);
});

test('flat vertical wall offset is exactly its normal and out-of-patch points are refused',()=>{
 const normal=[.6,-.8,0],m=buildWallMiter({planes:[{segment_id:'flat',origin:[0,0,0],normal}],patches:[patch('flat',[[0,0],[2,0],[0,4]])]});
 close(m.displacement('flat',[.5,1]),normal);assert.throws(()=>m.displacement('flat',[3,3]),/outside source/);
});

test('004 extreme miters and incompatible multiway depths are reported, and inverted offsets refused',async()=>{
 const context=JSON.parse(await readFile(join(runDirFor('creative-004'),'context-summary.json'),'utf8'));
 const planes=context.facade_segments,before=JSON.stringify(planes),m=buildWallMiter({planes,patches:planes.map(s=>s.wall_patch)});
 assert.equal(JSON.stringify(planes),before);
 assert.ok(m.diagnostics.max_vector_norm>20);
 assert.ok(m.diagnostics.max_normal_depth_relative_error>.04);
 assert.equal(m.diagnostics.boundary_vertical_displacement,0);
 assert.throws(()=>m.assertDepth(.45),/inverts source triangle/);
 const bounded=buildWallMiter({planes,patches:planes.map(s=>s.wall_patch),depth_m:.45,max_projection_m:.8});
 assert.ok(bounded.diagnostics.max_vector_norm*.45<=.8+1e-12);
 assert.equal(bounded.diagnostics.surface_fan_count,bounded.diagnostics.source_vertex_count,'acute miters are connected source fans, not point-only contacts');
 assert.ok(bounded.diagnostics.tapered_vertex_count>0&&bounded.diagnostics.tapered_vertex_count<bounded.diagnostics.source_vertex_count);
 assert.ok(bounded.diagnostics.normal_depth_factor_range[0]>0);
 assert.equal(bounded.assertDepth(.45),true);
 assert.equal(JSON.stringify(planes),before);
});

test('walls touching at a point retain separate topological offset fans',()=>{
 const planes=[{segment_id:'a',origin:[0,0,0],normal:[0,-1,0]},{segment_id:'b',origin:[0,0,0],normal:[0,1,0]}];
 const patches=[patch('a',[[0,0],[2,0],[0,2]]),patch('b',[[0,0],[2,0],[1,2]])];
 const m=buildWallMiter({planes,patches});
 assert.equal(m.diagnostics.surface_fan_count,m.diagnostics.source_vertex_count+1);
 close(m.displacement('a',[0,0]),[0,-1,0]);close(m.displacement('b',[0,0]),[0,1,0]);
});

test('projection taper is common to both sides of a fold',()=>{
 const planes=[{segment_id:'a',origin:[0,0,0],normal:[0,-1,0]},{segment_id:'b',origin:[0,0,0],normal:[1,0,0]}];
 const patches=planes.map(p=>patch(p.segment_id,[[0,0],[2,0],[0,4]]));
 const m=buildWallMiter({planes,patches,depth_m:.45,max_projection_m:.5});
 for(const z of [0,.5,2,4]){const a=m.displacement('a',[0,z]),b=m.displacement('b',[0,z]);close(a,b);assert.ok(Math.hypot(...a)*.45<=.5+1e-12);}
 assert.ok(m.diagnostics.tapered_vertex_count>0);
});
