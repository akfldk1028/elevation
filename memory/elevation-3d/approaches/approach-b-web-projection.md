# Approach B: Generated Views plus Web Projection

## Summary

Use Alibaba Wan/Qwen image generation or editing to create a coherent facade view set, then apply those images to the original mesh with camera-projection shaders in Three.js.

## Why it is the fallback path

- the authoritative geometry never becomes provider-generated geometry;
- source camera matrices are used directly by the application;
- provider requests are inexpensive enough for small controlled tests;
- it remains fully web-deployable.

## Generation package

- a labelled contact sheet derived from the six locked views;
- separate high-resolution front/right/back/left/top source images;
- floor-guide overlays;
- one shared material and opening brief;
- instructions prohibiting silhouette and storey changes;
- a request for a consistent named view set.

Wan 2.7 is preferred when more than three input images are necessary. Qwen Image is a comparison candidate when negative prompts or multiple output variants are more important.

## Projection method

For every fragment on the original mesh:

1. transform its world position through each locked view matrix;
2. sample only projections inside the corresponding image bounds;
3. reject back-facing or depth-occluded samples;
4. weight samples by normal/view alignment and distance from silhouettes;
5. blend overlapping views and report uncovered regions.

The first milestone may render a view-dependent projected material. Portable UV baking is a later milestone and must not be falsely represented as complete.

## Expected strengths

- absolute control of original geometry;
- exact reuse of supplied camera matrices;
- inexpensive provider comparison;
- easier debugging through per-view masks.

## Expected weaknesses

- seams and corner inconsistency;
- roof/underside coverage gaps;
- image models may hallucinate incompatible openings;
- browser texture baking and portable GLB export require additional engineering.

## Stop conditions

- generated views fail storey or silhouette checks;
- projection coverage is below the test threshold;
- corner disagreement makes derived drawings misleading;
- the provider cannot return a stable labelled view set.
