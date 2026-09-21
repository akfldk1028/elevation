/** Reproducible written-GLB cost probe; outputs outside the source tree. */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { funnelModuleGeometry } from '../../plugins/elevation-3d/lib/facade-agent/polygon-prism.mjs';
import { writeEnrichedGlb } from '../../plugins/elevation-3d/lib/enrichment.mjs';
import { resolveRoots } from './config.mjs';

const out = join(resolveRoots().outputRoot, 'module-cost-probe');
await mkdir(out, { recursive: true });
const results = [];
for (const points of [8, 12, 16, 24]) for (const rings of [0, 1, 3, 6]) {
  const loop = (r) => Array.from({length:points}, (_,i) => [0.5+r*Math.cos(i*2*Math.PI/points),0.5+r*Math.sin(i*2*Math.PI/points)]);
  const tile=loop(0.5), mouth=loop(0.45), throat=loop(0.25);
  const profile={kind:rings ? 'quarter_ellipse':'linear', rings};
  const geometry=funnelModuleGeometry({origin:[0,0,0]},null,{brick_module_m:[1,1]},
    {u0:0,u1:1,v0:0,v1:1,n0:0,n1:0.45},tile,mouth,throat,(_p,_t,u,v,n)=>[u,n,v],profile);
  const sizes=[];
  for(const count of [10,100]) {
    const path=join(out,`p${points}-r${rings}-n${count}.glb`);
    await writeEnrichedGlb({base:{positions:[[0,0,0],[1,0,0],[0,0,1]],indices:[[0,1,2]]},
      details:Array.from({length:count},(_,i)=>({...geometry,material:'concrete',kind:'louvre',
        id:`cell-${i}`,module:{tile,mouth,throat,profile}}))},path);
    sizes.push((await stat(path)).size);
  }
  results.push({points,rings,vertices:geometry.positions.length,indices:geometry.indices.length*3,
    bytes_10:sizes[0],bytes_100:sizes[1],marginal_bytes:(sizes[1]-sizes[0])/90});
}
await writeFile(join(out,'measurements.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({out,results}));
