"""What can be held without a GPU: the prompt, the rasters it reaches for, the provenance shape.

Generating an image needs 9 GB of weights and a CUDA card, so none of that is tested here. What
IS tested is everything this module decides BEFORE the model runs - and those decisions are
where the measured failures were: an open question that drew a blank mass, a front raster that
constrained nothing, and a fallback that has to find the edge raster beside the depth one.
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))


class ComposePrompt(unittest.TestCase):
    def test_the_subject_travels_verbatim_and_the_camera_is_added(self):
        from sdxl_concept import CAMERA, compose_prompt
        subject = "A five-storey building of exactly this form, 16.5 m tall, standing on the street."
        prompt = compose_prompt(subject)
        self.assertTrue(prompt.startswith(subject), "the commission is passed through, not rewritten")
        self.assertIn(CAMERA, prompt)

    def test_the_setup_names_the_camera_and_never_the_building(self):
        # The brief must stay open: this module may say what the PHOTOGRAPH is, never what the
        # building is made of. A material here would close every commission the lane ever sends.
        from sdxl_concept import CAMERA, NEGATIVE
        for word in ("brick", "concrete", "glass", "stone", "timber", "metal", "modernist", "brutalist"):
            self.assertNotIn(word, CAMERA.lower(), f"the camera setup must not name {word}")
        self.assertIn("sharp focus", CAMERA, "the trace reads cells; softness is the enemy")
        self.assertIn("blurry", NEGATIVE)


class ControlRasters(unittest.TestCase):
    def test_the_canny_fallback_looks_beside_the_depth_raster(self):
        # The evidence pack writes evidence/<kind>/<view>.png, so the edge raster for a depth one
        # is its sibling directory - not a suffix on the file name.
        from sdxl_concept import edge_raster_for
        found = pathlib.PurePath(edge_raster_for("/run/evidence/depth/axon.png"))
        self.assertEqual(found.parent.name, "edge")
        self.assertEqual(found.name, "axon.png")
        self.assertEqual(found.parent.parent.name, "evidence")


class Provenance(unittest.TestCase):
    def test_the_models_are_named_and_ungated(self):
        # SAM 3's weights are gated and cost this project an afternoon to pin down. These two are
        # not, and the ids are what a new machine downloads automatically - so they are pinned
        # here rather than typed into a command someone has to remember.
        from sdxl_concept import BASE_MODEL, CONTROLNET_CANNY, CONTROLNET_DEPTH, VAE_FIX
        for repo in (BASE_MODEL, CONTROLNET_DEPTH, CONTROLNET_CANNY, VAE_FIX):
            self.assertRegex(repo, r"^[\w.-]+/[\w.-]+$", "a Hugging Face repo id, not a path")

    def test_snapshot_lookup_answers_none_rather_than_throwing(self):
        # It runs inside the report that is written beside every image; a cache miss must not
        # take the picture down with it.
        from sdxl_concept import snapshot_of
        self.assertIsNone(snapshot_of("no-such-org/no-such-model"))


if __name__ == "__main__":
    unittest.main()
