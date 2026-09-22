"""Read native DXF back, verify all instance poses, and render the actual CAD.

Usage: python verify_cad.py <export-directory>
Requires matplotlib for the review image, in addition to requirements.txt.
"""
import json
import pathlib
import sys
import math
import ezdxf

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from src.curve_document import transformed_loops


def verify(directory):
    directory = pathlib.Path(directory)
    model = json.loads((directory / 'facade_model.json').read_text(encoding='utf-8'))
    cad = ezdxf.readfile(directory / 'facade.dxf')
    inserts = list(cad.modelspace().query('INSERT'))
    if cad.units != 4 or cad.audit().has_errors or len(inserts) != len(model['instances']):
        raise ValueError('CAD units, topology audit, or instance count mismatch')
    curves = 0
    for instance, insert in zip(model['instances'], inserts):
        _, (x, y, sx, sy, angle) = transformed_loops(model, instance)
        expected = [x*1000, y*1000, sx*1000, sy*1000, angle]
        actual = [insert.dxf.insert.x, insert.dxf.insert.y, insert.dxf.xscale, insert.dxf.yscale, insert.dxf.rotation]
        if not all(math.isclose(a, b, abs_tol=1e-7) for a,b in zip(expected, actual)):
            raise ValueError(f'CAD pose mismatch: {instance["id"]}')
        curves += sum(e.dxftype() == 'SPLINE' for e in cad.blocks[insert.dxf.name])
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy
    figure = plt.figure(figsize=(18, 8))
    axes = figure.add_axes([0, 0, 1, 1])
    config = Configuration(color_policy=ColorPolicy.BLACK, background_policy=BackgroundPolicy.WHITE)
    Frontend(RenderContext(cad), MatplotlibBackend(axes), config=config).draw_layout(cad.modelspace(), finalize=True)
    axes.set_xlim(0, model['width_m']*1000)
    axes.set_ylim(0, model['height_m']*1000)
    figure.savefig(directory / 'cad-review.png', dpi=120)
    plt.close(figure)
    result = {'ok':True, 'cad_units':'mm', 'verified_instance_poses':len(inserts),
              'native_splines':curves, 'render':'cad-review.png', 'reader':'ezdxf'}
    (directory/'cad-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1])))
