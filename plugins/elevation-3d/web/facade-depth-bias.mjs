/** Closed positive-depth modules already resolve visibility through their solid
 * geometry. Slope-scaled bias on their nearly edge-on internal caps can pull
 * hidden triangles in front of the outer face. Their rear may coincide with
 * the mass at standoff zero; the proud front still occludes it without bias.
 * Flush details and recessed panes retain their established mass separation.
 */
export function facadeDepthBias({facadeDetail,primitiveExtras=null,detailFactor=-4}) {
 const bounds=primitiveExtras?.local_bounds;
 const closedModule=facadeDetail && primitiveExtras?.module_cell===true
  && primitiveExtras?.kind==='louvre' && Number.isFinite(bounds?.n0)
  && Number.isFinite(bounds?.n1) && bounds.n0>=0 && bounds.n1>bounds.n0;
 const factor=closedModule?0:facadeDetail?detailFactor:4;
 return {polygonOffset:!closedModule,polygonOffsetFactor:factor,polygonOffsetUnits:factor};
}
