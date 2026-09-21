/** Data rasters are not presentation images. Resolving multisampled packed RGB
 * depth averages bytes independently, then quantizes the red byte to steps of
 * (far-near)/255 metres. Export the unfiltered single-sample bytes directly.
 * Canvas ImageData preserves the byte values; only WebGL's bottom-up row order
 * changes. All passes use this path so material/normal/depth coverage agrees.
 */
export function diagnosticRasterPng({renderer,target,scene,camera,
 createCanvas=()=>document.createElement('canvas')}) {
 if(target.samples!==0)throw new Error('diagnostic raster requires a single-sample target');
 const {width,height}=target,previous=renderer.getRenderTarget();
 const raw=new Uint8Array(width*height*4);
 try {
  renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
  renderer.readRenderTargetPixels(target,0,0,width,height,raw);
 } finally {renderer.setRenderTarget(previous);}
 const canvas=createCanvas();canvas.width=width;canvas.height=height;
 const context=canvas.getContext('2d'),image=context.createImageData(width,height);
 for(let row=0;row<height;row++)image.data.set(raw.subarray(row*width*4,(row+1)*width*4),(height-1-row)*width*4);
 context.putImageData(image,0,0);
 return canvas.toDataURL('image/png');
}
