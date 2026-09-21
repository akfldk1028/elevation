/** Verification of evaluated solid modules against independently recovered MASS triangles.
 * u and z are canonical segment u and absolute height; n is fractional outward depth.
 * The rectangle authority is deliberately not enlarged. */
import {triangulate} from './polygon-prism.mjs';
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area=r=>Math.abs(r.reduce((s,a,i)=>{const b=r[(i+1)%r.length];return s+a[0]*b[1]-b[0]*a[1];},0))/2;

function intersection(subject,triangle) {
 let ring=subject;
 const sign=Math.sign(cross(...triangle));
 for(let i=0;i<3;i++) {
  const a=triangle[i],b=triangle[(i+1)%3],out=[];
  if(!ring.length) break;
  let p=ring.at(-1),dp=sign*cross(a,b,p);
  for(const q of ring) {
   const dq=sign*cross(a,b,q);
   if((dp>=0)!==(dq>=0)) {const t=dp/(dp-dq);out.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]);}
   if(dq>=0)out.push(q);
   p=q;dp=dq;
  }
  ring=out;
 }
 return ring.length>=3?area(ring):0;
}

export function validateModuleMesh(mesh) {
 if(!mesh || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.triangles)
  || mesh.vertices.length<4 || mesh.vertices.length>1024 || mesh.triangles.length<4 || mesh.triangles.length>2048)
  throw new TypeError('wall-patch module mesh exceeds bounded vertex/triangle contract');
 if(mesh.vertices.some(v=>!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite)||v[2]<-1e-6||v[2]>1+1e-6))
  throw new TypeError('wall-patch module coordinates need finite u,z and fractional depth 0..1');
 const edges=new Map();let volume=0;
 for(const f of mesh.triangles) {
  if(!Array.isArray(f)||f.length!==3||new Set(f).size!==3||f.some(i=>!Number.isInteger(i)||i<0||i>=mesh.vertices.length))
   throw new TypeError('wall-patch module has invalid triangle indices');
  for(let k=0;k<3;k++){const a=f[k],b=f[(k+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;const e=edges.get(key)??[0,0];e[0]++;e[1]+=a<b?1:-1;edges.set(key,e);}
  const [a,b,c]=f.map(i=>mesh.vertices[i]);
  volume+=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);
 }
 if([...edges.values()].some(([count,balance])=>count!==2||balance!==0)||volume<=1e-10)
  throw new TypeError('wall-patch module must be a closed outward solid');
 return mesh;
}

export function moduleFitsWallPatch(mesh,patch) {
 if(!patch?.triangles?.length)return false;
 // Manifold stores float32 positions. Its worst quantization step derives from
 // coordinate magnitude; this is an area comparison, not permission to change MASS.
 const magnitude=Math.max(1,...mesh.vertices.flatMap(v=>v.slice(0,2)).map(Math.abs));
 const tolerance=magnitude*2**-22;
 for(const face of mesh.triangles) {
  const triangle=face.map(i=>mesh.vertices[i].slice(0,2));
  const target=area(triangle);
  if(target<1e-12)continue;
  const covered=patch.triangles.reduce((sum,t)=>sum+intersection(triangle,t),0);
  const perimeter=triangle.reduce((s,a,i)=>{const b=triangle[(i+1)%3];return s+Math.hypot(a[0]-b[0],a[1]-b[1]);},0);
  if(target-covered>tolerance*perimeter)return false;
 }
 return true;
}

/** A punched polygon may use the real wall, but never borrow its fold margin.
 * Test triangles against source triangles, and ALL contour edges against ALL
 * wall edges (including holes). Testing vertices alone misses a concave notch. */
export function openingFitsWallPatch(outline,patch,clearance) {
 if(!patch?.rings?.length || !patch?.triangles?.length)return false;
 let triangles;try {triangles=triangulate(outline);} catch {return false;}
 if(!moduleFitsWallPatch({vertices:outline.map(p=>[...p,0]),triangles},patch))return false;
 const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
  const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
 for(let i=0;i<outline.length;i++)for(const ring of patch.rings)for(let j=0;j<ring.length;j++) {
  const a=outline[i],b=outline[(i+1)%outline.length],c=ring[j],d=ring[(j+1)%ring.length];
  if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0)return false;
  if(Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b))+1e-7<clearance)return false;
 }
 return true;
}
