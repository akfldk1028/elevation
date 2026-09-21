import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runDirFor} from '../tools/facade-pipeline/config.mjs';
import {registerWallCharts} from '../tools/facade-pipeline/wall-chart.mjs';

function triangle(id,points) {
 const o=points[0],v=points[1].map((p,i)=>p-o[i]),w=points[2].map((p,i)=>p-o[i]);
 let normal=[v[1]*w[2]-v[2]*w[1],v[2]*w[0]-v[0]*w[2],v[0]*w[1]-v[1]*w[0]];
 const length=Math.hypot(...normal);normal=normal.map(x=>x/length);if(normal[1]>0)normal=normal.map(x=>-x);
 const h=Math.hypot(normal[0],normal[1]),t=[-normal[1]/h,normal[0]/h];
 return {segment_id:id,face_view:'front',origin_m:o,outward_normal:normal,
  wall_patch:{rings:[points.map(p=>[(p[0]-o[0])*t[0]+(p[1]-o[1])*t[1],p[2]])]}};
}
function mapped(segment,mapping,p) {
 const n=segment.outward_normal,o=segment.origin_m,h=Math.hypot(n[0],n[1]);
 const u=-(p[0]-o[0])*n[1]/h+(p[1]-o[1])*n[0]/h;
 const [a,b,c]=mapping.affine;return a*u+b*p[2]+c;
}

test('affine charts exactly register staggered battered courses without changing source patches',()=>{
 const a=[0,0,0],b=[3,0,0],c=[1,.35,3],d=[4,.15,3],e=[2,0,6];
 const s=[triangle('a',[a,b,c]),triangle('b',[b,d,c]),triangle('c',[c,d,e])];
 const before=JSON.stringify(s),r=registerWallCharts(s);
 assert.equal(JSON.stringify(s),before);
 for(const [i,j,p] of [[0,1,b],[0,1,c],[1,2,c],[1,2,d]])assert.ok(Math.abs(mapped(s[i],r.segments[i],p)-mapped(s[j],r.segments[j],p))<1e-8);
 assert.ok(r.segments.every(m=>m.affine[0]>.98 && m.affine[0]<1.02));
 assert.equal(r.charts.length,1);assert.ok(r.width_m>0);
});

test('004 chart registration closes shared course endpoints and reports remaining cuts',async()=>{
 const context=JSON.parse(await readFile(join(runDirFor('creative-004'),'context-summary.json'),'utf8'));
 const before=JSON.stringify(context.facade_segments),r=registerWallCharts(context.facade_segments);
 assert.equal(JSON.stringify(context.facade_segments),before);
 assert.ok(r.diagnostics.max_shared_seam_error_m<1e-7);
 assert.ok(r.diagnostics.horizontal_scale_range[0]>.99);
 assert.ok(r.diagnostics.horizontal_scale_range[1]<1.01);
 assert.ok(r.diagnostics.max_abs_shear<.01);
 assert.ok(r.diagnostics.chart_cuts.length>0);
 assert.ok(r.diagnostics.chart_cuts.every(c=>Math.max(...c.vertices.map(p=>p[2]))-Math.min(...c.vertices.map(p=>p[2]))>1e-5),'all horizontal course edges remain continuous');
 assert.equal(r.diagnostics.period_m,null);
 assert.ok(r.diagnostics.remaining_chart_cut_count<r.diagnostics.initial_chart_cut_count);
 assert.ok(r.diagnostics.max_metric_distortion<=r.diagnostics.initial_max_metric_distortion+r.diagnostics.numeric_metric_tolerance);
 assert.ok(r.diagnostics.stitched_edges.every(e=>e.max_endpoint_gap_m<1e-7));
 for(let i=1;i<r.charts.length;i++)assert.equal(r.charts[i].u_min_m,r.charts[i-1].u_max_m);
});

function boxWalls() {
 return [
  [[0,0,0],[0,-1,0],'front'],[[2,0,0],[1,0,0],'right'],
  [[2,2,0],[0,1,0],'back'],[[0,2,0],[-1,0,0],'left'],
 ].map(([origin_m,outward_normal,face_view],i)=>({segment_id:`wall-${i}`,face_view,origin_m,outward_normal,
  wall_patch:{rings:[[[0,0],[2,0],[2,2],[0,2]]]}}));
}

test('dimensioning labels do not force a seam between compatible adjacent walls',()=>{
 const s=boxWalls().slice(0,2),r=registerWallCharts(s);
 assert.equal(r.diagnostics.initial_chart_cut_count,1);
 assert.equal(r.diagnostics.remaining_chart_cut_count,0);
 assert.equal(r.charts.length,1);
 // Affine endpoint agreement implies agreement everywhere on a straight edge;
 // sample its interior explicitly as a guard against incorrect chart packing.
 for(const z of [0,.25,.8,1.5,2])assert.ok(Math.abs(mapped(s[0],r.segments[0],[2,0,z])-mapped(s[1],r.segments[1],[2,0,z]))<1e-10);
 assert.ok(r.segments.every(m=>Math.abs(m.affine[0]-1)<1e-10&&Math.abs(m.affine[1])<1e-10));
});

test('closed wall cycle retains an explicit cut inside the stitched chart instead of collapsing U',()=>{
 const s=boxWalls(),before=JSON.stringify(s),r=registerWallCharts(s);
 assert.equal(JSON.stringify(s),before);
 assert.equal(r.diagnostics.initial_chart_cut_count,4);
 assert.equal(r.diagnostics.stitched_edges.length,3);
 assert.equal(r.diagnostics.remaining_chart_cut_count,1);
 assert.equal(r.charts.length,1,'connected charts can still contain an intentional cut boundary');
 assert.ok(r.segments.every(m=>Math.abs(m.affine[0]-1)<1e-10&&Math.abs(m.affine[1])<1e-10));
 assert.ok(r.diagnostics.stitched_edges.every(e=>e.max_endpoint_gap_m<1e-10));
 assert.ok(Math.abs(r.diagnostics.chart_cuts[0].max_endpoint_gap_m-8)<1e-10);
});
