/** Measured image geometry for the transcriber, not just a model name in a receipt. */
export function summarizeVisionEvidence(document) {
  const units=document.primitives ?? [];
  const {width,height}=document.image_metadata;
  if (!(width>0 && height>0)) throw new Error('invalid observation image dimensions');
  const representatives=new Map();
  for(const unit of units) {
    const [x,y,w,h]=unit.bbox_px;
    const bin=`${Math.min(3,Math.floor((x+w/2)/width*4))}:${Math.min(2,Math.floor((y+h/2)/height*3))}`;
    const bucket=representatives.get(bin) ?? [];
    bucket.push(unit);
    representatives.set(bin,bucket);
  }
  const chosen=[...representatives.values()].flatMap(bucket=>{
    const sorted=[...bucket].sort((a,b)=>a.area_px-b.area_px);
    return [sorted[Math.floor(sorted.length/3)], sorted[Math.floor(sorted.length*2/3)]];
  });
  return {
    coordinate_system:'perspective image pixels; not rectified facade metres',
    count:units.length,
    observed_positions:units.map(u=>({id:u.id,bbox_px:u.bbox_px,centroid_px:u.centroid_px})),
    measured_unit_shapes:[...new Map(chosen.map(u=>[u.id,u])).values()].map(u=>({id:u.id,bbox_px:u.bbox_px,
      outline_uv:u.polygon_normalized,holes:(u.hole_polylines_px ?? []).length,confidence:u.confidence,
      note:u.polygon_normalized?.length?'observed contour approximation':'needs native curve document; no polygon substitution'})),
  };
}
