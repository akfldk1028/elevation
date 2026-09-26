"""Generate a concept perspective locally, bound to the mass by the mass's own raster.

The standard lane is MASS -> PERSPECTIVE -> DRAWING. The perspective came from one closed
account, and when that account lost its entitlement the lane lost its entrance while every step
after it kept working. This is the open alternative: Stable Diffusion XL with a ControlNet over
the depth raster the evidence pack already renders for the bare mass.

The conditioning is the point, not a convenience. A commission DESCRIBES the mass in words and
asks the model to respect it - which is how a five-storey prism once came back as a star-plan
tower. A ControlNet does not ask: the geometry is an input, so a facade is invented inside a
silhouette that is already correct.

Measured while this was built (2026-09-24), and the reason the caller must choose well:
  - the open brief drawn verbatim ("what facade does this shape want?") returns a BLANK MASS.
    A diffusion model renders a description, it does not answer a question, so the programme
    has to be named. Style, palette and material still must not be.
  - a FRONT depth raster of a prism is nearly featureless, so the ControlNet holds nothing and
    the model returns a close-up wall texture. Condition on the three-quarter axon.
  - what the trace can read back is a dense, doubly periodic field of discrete cells; a
    continuous glazed skin yields zero apertures and a sparse window grid is refused by the
    lattice fit for lying on one line.
"""

import os

# Both are in the Hugging Face cache used by this project and neither is gated - unlike SAM 3,
# whose weights need an accepted licence. A machine without them downloads them automatically.
BASE_MODEL = "SG161222/RealVisXL_V4.0"
CONTROLNET_DEPTH = "xinsir/controlnet-union-sdxl-1.0"
CONTROLNET_CANNY = "xinsir/controlnet-canny-sdxl-1.0"
VAE_FIX = "madebyollin/sdxl-vae-fp16-fix"

# Not a style. A photographic setup - what the camera and the print are, never what the building
# is made of. The building is the caller's open question, and the brief must stay open.
CAMERA = ("architectural photograph, full building in frame, daylight, "
          "sharp focus across the facade, no motion blur, no depth-of-field haze")
NEGATIVE = ("blurry, out of focus, bokeh, heavy grain, watermark, text, people, cars, "
            "cropped building, distorted perspective, fisheye, painting, illustration, sketch")


def compose_prompt(subject):
    """The commission, plus the photographic setup. The subject is passed through verbatim."""
    return f"{subject}. {CAMERA}"


def edge_raster_for(depth_raster):
    """The evidence pack renders both; the canny fallback wants the edge one."""
    head, tail = os.path.split(depth_raster)
    return os.path.join(os.path.dirname(head), "edge", tail)


def snapshot_of(repo_id):
    """Which revision of a cached model this was. A concept nobody can reproduce is not evidence."""
    try:
        from huggingface_hub import scan_cache_dir
        for repo in scan_cache_dir().repos:
            if repo.repo_id == repo_id:
                revisions = sorted(repo.revisions, key=lambda revision: revision.last_modified, reverse=True)
                return revisions[0].commit_hash if revisions else None
    except Exception:
        return None
    return None


def load_pipeline(kind):
    """SDXL plus the ControlNet for `kind`. Returns the pipeline and the repo it came from."""
    import torch
    from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetPipeline

    repo = CONTROLNET_DEPTH if kind == "depth" else CONTROLNET_CANNY
    controlnet = ControlNetModel.from_pretrained(repo, torch_dtype=torch.float16)
    vae = AutoencoderKL.from_pretrained(VAE_FIX, torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        BASE_MODEL, controlnet=controlnet, vae=vae, torch_dtype=torch.float16, variant="fp16",
    )
    # 12 GB holds SDXL and a ControlNet in fp16, but offloading costs seconds and never costs a
    # run: draws on this machine have been killed three times for memory.
    pipe.enable_model_cpu_offload()
    return pipe, repo


def generate(control_raster, out_path, subject, kind="depth", steps=30, seed=7, scale=0.8, guidance=6.0):
    """Write the concept and return what made it, for the provenance file beside it."""
    from PIL import Image
    import torch

    def squared(path):
        image = Image.open(path).convert("RGB")
        return image if image.size == (1024, 1024) else image.resize((1024, 1024), Image.LANCZOS)

    control = squared(control_raster)
    note = None
    try:
        pipe, controlnet_repo = load_pipeline(kind)
    except Exception as error:
        if kind != "depth":
            raise
        # The union ControlNet carries its own class in some releases; the canny one is a plain
        # ControlNetModel, and the evidence pack renders an edge raster that suits it exactly.
        note = f"depth controlnet unavailable ({str(error)[:120]}); fell back to canny"
        kind = "canny"
        control = squared(edge_raster_for(control_raster))
        pipe, controlnet_repo = load_pipeline(kind)

    image = pipe(
        prompt=compose_prompt(subject),
        negative_prompt=NEGATIVE,
        image=control,
        num_inference_steps=steps,
        controlnet_conditioning_scale=scale,
        guidance_scale=guidance,
        generator=torch.Generator(device="cuda").manual_seed(seed),
    ).images[0]

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    image.save(out_path)

    return {
        "ok": True,
        "image": os.path.abspath(out_path),
        "engine": "sdxl-controlnet",
        "base_model": BASE_MODEL,
        "base_snapshot": snapshot_of(BASE_MODEL),
        "controlnet": controlnet_repo,
        "controlnet_snapshot": snapshot_of(controlnet_repo),
        "conditioned_on": {"kind": kind, "raster": os.path.abspath(control_raster)},
        "seed": seed,
        "steps": steps,
        "controlnet_conditioning_scale": scale,
        "guidance_scale": guidance,
        "subject": subject,
        **({"note": note} if note else {}),
    }
