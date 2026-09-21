"""ModelSpec (family + lattice + fields + exceptions) -> instances, one model hash for 2D and 3D.

Spec: docs/superpowers/specs/2026-09-16-parametric-facade-lattice-design.md. The evaluator lives
here, in Python, because fitting will call it thousands of times; the 3D side reads the instances
it writes and never evaluates a spec itself, so the hash cannot fork.
"""
GENERATOR_VERSION = "facade-parametric-v0.4"  # v0.2: rings sampled at a shared angle set that keeps the mouth's corners; v0.3: a seam through a throat squeezes the lens into its part; v0.4: a host edge that cuts past a funnel leaves a solid panel, so a veil finishes its host; the hash moves with the geometry
