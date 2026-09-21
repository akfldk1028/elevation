import { isSimplePolygon, shoelace } from './polygon-prism.mjs';

const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
function inside(p,loop) {
  let hit=false;
  for(let i=0,j=loop.length-1;i<loop.length;j=i++) {
    const a=loop[i],b=loop[j];
    if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) hit=!hit;
  }
  return hit;
}

/** Inward mitres in physical metres. Refuse a collapsed or self-crossing frame. */
function inset(loop,width) {
  const edges=loop.map((a,i)=>{
    const d=sub(loop[(i+1)%loop.length],a),length=Math.hypot(...d);
    return {d,p:[a[0]-d[1]/length*width,a[1]+d[0]/length*width]};
  });
  const result=edges.map((edge,i)=>{
    const prev=edges[(i+edges.length-1)%edges.length],den=cross(prev.d,edge.d);
    if(Math.abs(den)<1e-10) return edge.p;
    const t=cross(sub(edge.p,prev.p),edge.d)/den;
    return [prev.p[0]+prev.d[0]*t,prev.p[1]+prev.d[1]*t];
  });
  if(!isSimplePolygon(result)||shoelace(result)<=0||!result.every(p=>inside(p,loop))) throw new Error('OUTLINE_FRAME_COLLAPSED: opening cannot contain the requested frame width');
  // Each connecting strip must remain a simple positively wound quadrilateral.
  for(let i=0;i<loop.length;i++) {
    const j=(i+1)%loop.length,quad=[loop[i],loop[j],result[j],result[i]];
    if(!isSimplePolygon(quad)||shoelace(quad)<=0) throw new Error('OUTLINE_FRAME_COLLAPSED: inset folds across the opening');
  }
  return result;
}

/**
 * An edge shorter than the ring is wide cannot carry a strip: its two mitres cross and the
 * strip folds. Such an edge is a flattening artefact (a lens tip, a clip corner), not a shape,
 * so the vertex that ends it is merged away before the inset. Measured on a lattice cell
 * clipped at a facet edge: a 10 mm edge beside a 20 mm jamb ring collapsed the whole compile.
 */
function mergeShortEdges(loop,width) {
  let out=[...loop];
  for(let guard=0;guard<loop.length&&out.length>3;guard++) {
    let shortest=-1,length=Infinity;
    for(let i=0;i<out.length;i++) {
      const d=Math.hypot(...sub(out[(i+1)%out.length],out[i]));
      if(d<length) { length=d; shortest=i; }
    }
    if(length>=width) break;
    out.splice((shortest+1)%out.length,1);
  }
  return out;
}

/** One watertight ring mesh; the glazing aperture is never capped. */
export function outlineFrameGeometry(plane,tangent,grammar,bounds,outline,width,localPoint) {
  const ordered=shoelace(outline)>0?outline:[...outline].reverse();
  const outer=mergeShortEdges(ordered.map(([u,v])=>[bounds.u0+u*(bounds.u1-bounds.u0),bounds.v0+v*(bounds.v1-bounds.v0)]),width);
  const inner=inset(outer,width),n=outer.length;
  const low=Math.min(bounds.n0,bounds.n1),high=Math.max(bounds.n0,bounds.n1);
  const coords=[...outer,...inner].flatMap(p=>[p]);
  const positions=[...coords.map(([u,v])=>localPoint(plane,tangent,u,v,low)),...coords.map(([u,v])=>localPoint(plane,tangent,u,v,high))];
  const indices=[];
  const quad=(a,b,c,d)=>indices.push([a,b,c],[a,c,d]);
  for(let i=0;i<n;i++) {
    const j=(i+1)%n;
    quad(i,n+i,n+j,j); // near ring, -n
    quad(2*n+i,2*n+j,3*n+j,3*n+i); // far ring, +n
    quad(i,j,2*n+j,2*n+i); // outer wall
    quad(n+j,n+i,3*n+i,3*n+j); // aperture wall
  }
  const uv=coords.map(([u,v])=>[u/grammar.brick_module_m[0],(plane.origin[2]+v)/grammar.brick_module_m[1]]);
  return {positions,indices,uvs:[...uv,...uv]};
}
