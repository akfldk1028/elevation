"""Explicit design edits on observed geometry; no unmeasured depth inference.

Fields are evaluated at the original measured centres, so changing spacing does
not feed back into the field. Scales multiply and rotations add in grade order.
"""
import copy
import math

PARAMETERS = {'scale_u', 'scale_v', 'spacing_u', 'spacing_v', 'rotation_deg'}
INSTANCE = {'scale_u', 'scale_v', 'rotation_deg', 'offset_m'}
ATTRIBUTES = {'scale_u', 'scale_v', 'rotation_deg'}


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _point(value):
    return isinstance(value, (list, tuple)) and len(value) == 2 and all(_number(v) for v in value)


def validate_parameters(model):
    groups = [(model.get('parameters', {}), PARAMETERS)]
    groups += [({k:v for k,v in i.items() if k in INSTANCE}, INSTANCE) for i in model['instances']]
    for values, allowed in groups:
        if set(values) - allowed:
            raise ValueError('unknown transform parameter')
        for key, value in values.items():
            if key == 'offset_m':
                if not _point(value):
                    raise ValueError('offset_m needs two finite coordinates')
            elif not _number(value) or (key != 'rotation_deg' and value <= 0):
                raise ValueError('scale and spacing must be positive; transforms must be finite')
    fields = model.get('fields', [])
    if len({f['id'] for f in fields}) != len(fields):
        raise ValueError('duplicate field IDs')
    for field in fields:
        kind = field.get('kind')
        if kind == 'radial':
            if (not _point(field.get('center_m')) or not _number(field.get('radius_m'))
                    or field['radius_m'] <= 0 or not _number(field.get('falloff', 1))
                    or field.get('falloff', 1) <= 0):
                raise ValueError('invalid radial field')
        elif kind == 'linear':
            if (not _point(field.get('start_m')) or not _point(field.get('end_m'))
                    or field['start_m'] == field['end_m']):
                raise ValueError('invalid linear field')
        else:
            raise ValueError('supported fields: radial, linear')
    ids = {f['id'] for f in fields}
    for grade in model.get('grades', []):
        if grade.get('field') not in ids or grade.get('attribute') not in ATTRIBUTES:
            raise ValueError('grade needs a declared field and supported attribute')
        if not all(_number(grade.get(k)) for k in ('from', 'to')):
            raise ValueError('grade endpoints must be finite')
        if grade['attribute'] != 'rotation_deg' and min(grade['from'], grade['to']) <= 0:
            raise ValueError('graded scale must remain positive')


def field_transform(model, instance):
    result = {'scale_u':1, 'scale_v':1, 'rotation_deg':0}
    x, y = instance['center_m']
    fields = {f['id']:f for f in model.get('fields', [])}
    for grade in model.get('grades', []):
        field = fields[grade['field']]
        if field['kind'] == 'radial':
            a, b = field['center_m']
            value = max(0, 1-math.hypot(x-a, y-b)/field['radius_m']) ** field.get('falloff', 1)
        else:
            a, b = field['start_m']
            dx, dy = field['end_m'][0]-a, field['end_m'][1]-b
            value = min(1, max(0, ((x-a)*dx+(y-b)*dy)/(dx*dx+dy*dy)))
        value = grade['from'] + (grade['to']-grade['from'])*value
        attr = grade['attribute']
        if attr == 'rotation_deg':
            result[attr] += value
        else:
            result[attr] *= value
    return result


def edit_document(model, edit):
    from .curve_document import validate_curve_document
    if set(edit) - {'parameters', 'instances', 'fields', 'grades'}:
        raise ValueError('unknown edit section')
    updated = copy.deepcopy(model)
    updated.setdefault('parameters', {}).update(edit.get('parameters', {}))
    instances = {i['id']:i for i in updated['instances']}
    for key, changes in edit.get('instances', {}).items():
        if key not in instances or set(changes) - INSTANCE:
            raise ValueError('unknown instance ID or editable attribute')
        instances[key].update(changes)
    for key in ('fields', 'grades'):
        if key in edit:
            updated[key] = copy.deepcopy(edit[key])
    validate_curve_document(updated)
    updated.setdefault('design_edits', []).append(copy.deepcopy(edit))
    return updated
