import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticRasterPng } from '../plugins/elevation-3d/web/diagnostic-raster.mjs';

test('diagnostics read exact single-sample RGBA and flip WebGL rows only',()=>{
 const target={width:2,height:2,samples:0};const previous={};let current=previous;let encoded;
 const raw=new Uint8Array([119,175,49,255,0,0,0,255,119,175,80,255,255,255,255,255]);
 const renderer={getRenderTarget:()=>current,setRenderTarget:t=>{current=t;},
  clear:()=>{},render:()=>{assert.equal(current,target);},
  readRenderTargetPixels:(t,x,y,w,h,bytes)=>{assert.equal(t,target);assert.deepEqual([x,y,w,h],[0,0,2,2]);bytes.set(raw);}};
 const canvas={width:0,height:0,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{encoded=image.data;}}),toDataURL:type=>type};
 assert.equal(diagnosticRasterPng({renderer,target,scene:{},camera:{},createCanvas:()=>canvas}),'image/png');
 assert.deepEqual([...encoded],[119,175,80,255,255,255,255,255,119,175,49,255,0,0,0,255]);
 assert.deepEqual([canvas.width,canvas.height],[2,2]);assert.equal(current,previous);
 assert.throws(()=>diagnosticRasterPng({renderer,target:{...target,samples:4},scene:{},camera:{}}),/single-sample/);
});

test('MSAA resolving packed RGB depth creates fictitious jumps on real smooth depth',()=>{
 // Two adjacent 24-bit encodings straddling a red-byte carry differ by only
 // one quantization unit. Averaging their channels then rounding destroys it.
 const a=[119,254,254],b=[120,0,0];
 const decode=p=>(p[0]/255+p[1]/255**2+p[2]/255**3)*237.6;
 const resolved=a.map((v,i)=>Math.round((v+b[i])/2));
 const trueMean=(decode(a)+decode(b))/2;
 assert.ok(Math.abs(decode(a)-decode(b))<.00002);
 assert.ok(Math.abs(decode(resolved)-trueMean)>.4);
});
