"""
grammar_synthesizer.py
Universal Facade Grammar Synthesizer for ElevationAgent.
Dynamically constructs schema-valid arr.elevation3d.facade-grammar.v3 programs
tailored to:
1. Detected Architectural Typology (diagrid/staggered vs orthogonal/stacked).
2. Aperture Geometry (unit contours, scoop angles, rotations).
3. Macro Singularities (The Oculus / Atrium Voids).
4. Ground Typology (Lifted arches / glazed lobby vs solid plinth).
5. Target Candidate Mass Geometry & Clearances (from context-summary.json).
"""

import os
import json

def synthesize_facade_grammar(typology, unit_outline, scoop_deg, field, context, candidate_id, source_photo_name):
    # Read clearances from target mass context
    exclusions = context.get("exclusions", {}) if context else {}
    fold_clr = float(exclusions.get("fold_clearance_m", 0.30))
    band_clr = float(exclusions.get("floor_band_clearance_m", 0.15))
    recess_limit = float(exclusions.get("max_recess_m", 0.50))
    storeys = context.get("storeys", []) if context else []
    top_storey_num = len(storeys) if storeys else 5

    # Safe clearances guaranteeing 0 clearance faults across all candidate masses
    u_margin = round(fold_clr + 0.02, 2)     # 0.32m
    z_margin = round(band_clr + 0.05, 2)     # 0.20m
    cell_depth = -min(0.35, recess_limit - 0.05)
    oculus_depth = -min(0.45, recess_limit - 0.05)

    # 1. Palette & Materials
    pal = typology.get("palette", {})
    wall_substance = pal.get("wall_substance", "cast")
    wall_lightness = pal.get("wall_lightness", "pale")
    wall_hue = pal.get("wall_hue", "neutral")

    materials = [
        {
            "id": "facade-wall",
            "substance": wall_substance,
            "lightness": wall_lightness,
            "hue": wall_hue,
            "finish": "matte",
            "joint_m": 1.15,
            "reads_as": f"Primary {wall_lightness} {wall_substance} rainscreen panels."
        },
        {
            "id": "aperture-cavity",
            "substance": "glazing",
            "lightness": "dark",
            "hue": "neutral",
            "finish": "satin",
            "joint_m": None,
            "reads_as": "Deeply recessed vision glazing behind sculpted apertures."
        },
        {
            "id": "facade-rib",
            "substance": "extrusion",
            "lightness": "mid-dark",
            "hue": "neutral",
            "finish": "satin",
            "joint_m": None,
            "reads_as": "Structural mullion webs and perimeter framing."
        }
    ]

    if typology.get("has_macro_void"):
        materials.append({
            "id": "oculus-cave",
            "substance": "glazing",
            "lightness": "dark",
            "hue": "cool-neutral",
            "finish": "polished",
            "joint_m": None,
            "reads_as": "Cavernous vision glass lining the central Oculus depression."
        })

    # 2. Macro Attractor Field
    fields_decl = []
    if field and field.get("at"):
        fields_decl.append({
            "id": "facade_attractor",
            "kind": "point",
            "at": field["at"],
            "range_m": field.get("range_m", [2.0, 16.0]),
            "falloff": float(field.get("falloff", 1.5))
        })

    # 3. Entrance configuration on primary ground segment
    entrance_config = {
        "segment_selector": "primary_visible_ground_segment",
        "preferred_bay": "central_focus",
        "door_family": "portal",
        "width_m": 1.4,
        "height_m": 2.1,
        "recess_m": 0.35
    }

    # 4. Synthesize Dynamic Rules
    is_diagrid = typology.get("grid_type") == "diagrid_staggered"
    has_oculus = typology.get("has_macro_void", False)
    is_lifted = typology.get("base_condition") == "lifted_arcade"

    rules = {}

    # Root Facet Rule:
    # Divides each facet into framing giant piers on the folds and central storeys.
    # The giant mullion piers span the full height of the mass (storeys 1..N),
    # breaking storey lockstep (max_storey_span >= 2) and providing continuous vertical articulation.
    front_segments = [s for s in (context.get("facade_segments", []) if context else []) if (s.get("face_view") or s.get("view")) == "front"]
    if front_segments:
        if typology.get("has_macro_void") and typology.get("macro_void"):
            void_u = typology["macro_void"].get("center_u_norm", 0.5)
            center_front_idx = max(0, min(len(front_segments) - 1, int(round(void_u * (len(front_segments) - 1)))))
        else:
            center_front_idx = len(front_segments) // 2
    else:
        center_front_idx = 2

    pier_w = 0.08
    inner_margin = round(max(0.06, u_margin - pier_w), 2)

    facet_alts = []
    if has_oculus:
        facet_alts.append({
            "when": f"face_view == front && index == {center_front_idx}",
            "split": {
                "axis": "u",
                "parts": [
                    {"size": str(pier_w), "symbol": "GiantPier"},
                    {"size": "~1", "symbol": "ApexFacetStoreys"},
                    {"size": str(pier_w), "symbol": "GiantPier"}
                ]
            }
        })
    facet_alts.append({
        "split": {
            "axis": "u",
            "parts": [
                {"size": str(pier_w), "symbol": "GiantPier"},
                {"size": "~1", "symbol": "FacetStoreys"},
                {"size": str(pier_w), "symbol": "GiantPier"}
            ]
        }
    })
    rules["Facet"] = facet_alts

    rules["GiantPier"] = [
        {
            "terminal": "mullion",
            "material": "facade-rib",
            "depth_m": 0.15
        }
    ]

    rules["ApexFacetStoreys"] = [
        {
            "split": {
                "axis": "storey",
                "parts": [{"size": "~1", "symbol": "ApexStoreyLevel"}]
            }
        }
    ]

    rules["FacetStoreys"] = [
        {
            "split": {
                "axis": "storey",
                "parts": [{"size": "~1", "symbol": "StoreyLevel"}]
            }
        }
    ]

    # StoreyLevel Rule:
    # 1. Storey 1: Lifted base or standard base
    # 2. Storey Top (5): Cornice termination (satisfies TOP_TERMINATION)
    # 3. Middle: Standard veil course flanked by FloorBands (satisfies MATERIAL_ROLE)
    storey_alts = []
    if is_lifted:
        storey_alts.append({
            "when": "storey == 1",
            "split": {
                "axis": "z",
                "parts": [
                    {"size": "2.6", "symbol": "LiftedBase"},
                    {"size": "0.15", "symbol": "FloorBand"},
                    {"size": "~1", "symbol": "LobbyBand"}
                ]
            }
        })

    # Top Storey with Cornice termination
    storey_alts.append({
        "when": f"storey == {top_storey_num}",
        "split": {
            "axis": "z",
            "parts": [
                {"size": "0.12", "symbol": "FloorBand"},
                {"size": "~1", "symbol": "VeilCourse"},
                {"size": "0.25", "symbol": "RoofCornice"}
            ]
        }
    })

    # Default intermediate storeys: FloorBand at bottom and top + VeilCourse in middle
    storey_alts.append({
        "split": {
            "axis": "z",
            "parts": [
                {"size": "0.12", "symbol": "FloorBand"},
                {"size": "~1", "symbol": "VeilCourse"},
                {"size": "0.12", "symbol": "FloorBand"}
            ]
        }
    })
    rules["StoreyLevel"] = storey_alts

    # ApexStoreyLevel (carries the large central Oculus on storey 3)
    if has_oculus:
        apex_alts = []
        if is_lifted:
            apex_alts.append({
                "when": "storey == 1",
                "split": {
                    "axis": "z",
                    "parts": [
                        {"size": "2.6", "symbol": "LiftedBase"},
                        {"size": "0.15", "symbol": "FloorBand"},
                        {"size": "~1", "symbol": "LobbyBand"}
                    ]
                }
            })
        # Storey 3: The Oculus Void! Spans full facet width between fold clearances
        apex_alts.append({
            "when": "storey == 3",
            "split": {
                "axis": "z",
                "parts": [
                    {"size": "0.15", "symbol": "FloorBand"},
                    {"size": "~1", "symbol": "OculusCourse"},
                    {"size": "0.15", "symbol": "FloorBand"}
                ]
            }
        })
        apex_alts.append({
            "when": f"storey == {top_storey_num}",
            "split": {
                "axis": "z",
                "parts": [
                    {"size": "0.12", "symbol": "FloorBand"},
                    {"size": "~1", "symbol": "VeilCourse"},
                    {"size": "0.25", "symbol": "RoofCornice"}
                ]
            }
        })
        apex_alts.append({
            "split": {
                "axis": "z",
                "parts": [
                    {"size": "0.12", "symbol": "FloorBand"},
                    {"size": "~1", "symbol": "VeilCourse"},
                    {"size": "0.12", "symbol": "FloorBand"}
                ]
            }
        })
        rules["ApexStoreyLevel"] = apex_alts

        # OculusCourse rule: large singular cavernous aperture (scale ratio > 2.0)
        rules["OculusCourse"] = [
            {
                "split": {
                    "axis": "u",
                    "parts": [
                        {"size": str(inner_margin), "symbol": "WallBand"},
                        {"size": "~1", "symbol": "OculusEye"},
                        {"size": str(inner_margin), "symbol": "WallBand"}
                    ]
                }
            }
        ]
        rules["OculusEye"] = [
            {
                "terminal": "glass",
                "material": "oculus-cave",
                "depth_m": oculus_depth,
                "inset_m": 0.05,
                "scoop_deg": -round(abs(scoop_deg if scoop_deg != 0 else 26.0), 1),
                "outline": unit_outline
            }
        ]

    # LiftedBase (for arched ground lobby)
    if is_lifted:
        rules["LiftedBase"] = [
            {
                "split": {
                    "axis": "u",
                    "parts": [
                        {"size": str(inner_margin), "symbol": "WallBand"},
                        {"size": "~1", "symbol": "BaseArch"},
                        {"size": str(inner_margin), "symbol": "WallBand"}
                    ]
                }
            }
        ]
        rules["BaseArch"] = [
            {
                "terminal": "arch",
                "material": "facade-wall",
                "depth_m": 0.15,
                "inset_m": 0.05
            }
        ]
        rules["LobbyBand"] = [
            {
                "terminal": "spandrel",
                "material": "facade-wall",
                "depth_m": 0.10
            }
        ]

    # VeilCourse Rule: Diagrid vs Orthogonal
    if is_diagrid:
        rules["VeilCourse"] = [
            {
                "when": "storey % 2 == 0",
                "split": {
                    "axis": "u",
                    "parts": [
                        {"size": str(inner_margin), "symbol": "WallBand"},
                        {"size": "0.35", "symbol": "HalfCell"},
                        {"size": "~1.1", "symbol": "FullCell", "repeat": True},
                        {"size": "0.35", "symbol": "HalfCell"},
                        {"size": str(inner_margin), "symbol": "WallBand"}
                    ]
                }
            },
            {
                "split": {
                    "axis": "u",
                    "parts": [
                        {"size": str(inner_margin), "symbol": "WallBand"},
                        {"size": "~1.1", "symbol": "FullCell", "repeat": True},
                        {"size": str(inner_margin), "symbol": "WallBand"}
                    ]
                }
            }
        ]
        rules["HalfCell"] = [
            {
                "terminal": "spandrel",
                "material": "facade-wall",
                "depth_m": 0.08
            }
        ]
    else:
        # Standard Orthogonal Stacked
        rules["VeilCourse"] = [
            {
                "split": {
                    "axis": "u",
                    "parts": [
                        {"size": str(inner_margin), "symbol": "WallBand"},
                        {"size": "~1.2", "symbol": "FullCell", "repeat": True},
                        {"size": str(inner_margin), "symbol": "WallBand"}
                    ]
                }
            }
        ]

    # FullCell Rule
    rules["FullCell"] = [
        {
            "split": {
                "axis": "u",
                "parts": [
                    {"size": "0.06", "symbol": "MullionRib"},
                    {"size": "~1", "symbol": "CellAperture"},
                    {"size": "0.06", "symbol": "MullionRib"}
                ]
            }
        }
    ]
    rules["MullionRib"] = [
        {
            "terminal": "mullion",
            "material": "facade-rib",
            "depth_m": 0.12
        }
    ]

    # CellAperture Rule
    cell_def = {
        "terminal": "glass",
        "material": "aperture-cavity",
        "inset_m": 0.05,
        "depth_m": cell_depth,
        "outline": unit_outline
    }
    if abs(scoop_deg) > 5.0:
        cell_def["scoop_deg"] = round(scoop_deg, 1)

    rules["CellAperture"] = [cell_def]

    # Supporting terminals
    rules["FloorBand"] = [
        {
            "terminal": "band",
            "material": "facade-wall",
            "depth_m": 0.06,
            "reach": "facet_edge"
        }
    ]
    rules["RoofCornice"] = [
        {
            "terminal": "cornice",
            "depth_m": 0.25
        }
    ]
    rules["WallBand"] = [{"terminal": "wall"}]

    # Assembled Grammar JSON
    grammar = {
        "schema_version": "arr.elevation3d.facade-grammar.v3",
        "concept_id": f"vision-universal-{candidate_id}",
        "source_photograph": source_photo_name,
        "start": "Facet",
        "design_rationale": [
            f"Universal automated vision-to-grammar transcription from {source_photo_name}.",
            f"Detected Grid Topology: {typology.get('grid_type')}, Aperture: {typology.get('aperture_shape')}.",
            f"Macro Feature: {'Oculus/Void detected' if has_oculus else 'Regular surface rhythm'}.",
            f"Base Condition: {'Lifted arch lobby' if is_lifted else 'Continuous ground contact'}."
        ],
        "materials": materials,
        "entrance": entrance_config,
        "fields": fields_decl if fields_decl else None,
        "rules": rules
    }

    return grammar
