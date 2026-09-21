import test from 'node:test';
import assert from 'node:assert/strict';
import { facadeDepthBias } from '../plugins/elevation-3d/web/facade-depth-bias.mjs';

test('closed projecting modules use physical depth for every material pass', () => {
 const primitiveExtras={module_cell:true,kind:'louvre',local_bounds:{n0:0,n1:.45}};
 for(const detailFactor of [-4,8]) assert.deepEqual(facadeDepthBias({facadeDetail:true,primitiveExtras,detailFactor}),
  {polygonOffset:false,polygonOffsetFactor:0,polygonOffsetUnits:0});
 // A side triangle receding 0.4 m per pixel receives a fictitious -1.6 m
 // depth shift with the old factor. Zero bias keeps an occluded side behind.
 const bias=facadeDepthBias({facadeDetail:true,primitiveExtras});
 assert.ok(.3+bias.polygonOffsetFactor*.4>0);
});

test('mass, flush details, and recessed openings retain existing bias',()=>{
 assert.equal(facadeDepthBias({facadeDetail:false}).polygonOffsetFactor,4);
 for(const primitiveExtras of [null,{module_cell:true,kind:'louvre',local_bounds:{n0:0,n1:0}},
  {module_cell:true,kind:'louvre',local_bounds:{n0:-.1,n1:.4}},
  {kind:'window',local_bounds:{n0:-.1,n1:0}}]) {
  assert.deepEqual(facadeDepthBias({facadeDetail:true,primitiveExtras}),
   {polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4});
 }
});
