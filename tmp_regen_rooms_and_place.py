import os
import json
import sqlite3
import uuid
import time

from app.pipeline.options import PipelineOptions
from app.pipeline.rooms_from_image import extract_rooms
from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json
from app.pipeline.dxf_export import write_detectors_to_dxf
from app.pipeline.render import render_dwg_to_png_with_qcad, write_mapping_from_dxf_and_png

pid = "f19cf883-8e9f-4c6f-93b5-b2c849a58c00"

con = sqlite3.connect('/data/firecad.sqlite')
con.row_factory = sqlite3.Row
row = con.execute('SELECT * FROM projects WHERE id=?', (pid,)).fetchone()
if row is None:
    raise RuntimeError('project not found')

settings = json.loads(row['settings_json'] or '{}')
opts = PipelineOptions.from_env().merge_settings(settings)

pdir = f'/data/projects/{pid}'
mapping_json = row['mapping_json_path']
dxf_path = row['dxf_path']
fixed = os.path.join(pdir, 'ultimate_fixed_wall.png')
render_png = row['render_png_path']

if not mapping_json or not os.path.exists(mapping_json):
    raise RuntimeError(f'mapping_json missing: {mapping_json}')
if not dxf_path or not os.path.exists(dxf_path):
    raise RuntimeError(f'dxf_path missing: {dxf_path}')
if not fixed or not os.path.exists(fixed):
    raise RuntimeError(f'fixed wall image missing: {fixed}')

rooms_json = os.path.join(pdir, 'rooms_from_image.json')
rooms_debug = os.path.join(pdir, 'rooms_debug.png')
rooms = extract_rooms(fixed, mapping_json, rooms_json, debug_png_path=rooms_debug)

debug_png = os.path.join(pdir, 'detectors_global_snapping_debug.png')
overlay_png = os.path.join(pdir, 'detectors_global_snapping_overlay.png')
placed, _ = place_detectors_from_rooms_json(
    rooms,
    opts.detector_spacing_m,
    opts.wall_buffer_m,
    opts.world_to_m,
    debug_png_path=debug_png,
    debug_overlay_png_path=overlay_png,
    mapping_json_path=mapping_json,
    base_png_path=render_png,
)

dets = [
    {
        'id': str(uuid.uuid4())[:8],
        'x': float(x),
        'y': float(y),
        'z': 0.0,
        'dtype': 'smoke',
        'locked': 0,
    }
    for (x, y) in placed
]

con.execute('DELETE FROM detectors WHERE project_id=?', (pid,))
now = time.time()
for d in dets:
    con.execute(
        'INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        (d['id'], pid, d['x'], d['y'], d['z'], d['dtype'], int(d['locked']), now, now),
    )

out_dxf = os.path.join(pdir, 'detectors_overlay.dxf')
write_detectors_to_dxf(dxf_path, out_dxf, dets, symbol_radius_world=150.0, text_height_world=150.0)

out_png = os.path.join(pdir, 'detectors_preview.png')
out_map = os.path.join(pdir, 'detectors_preview_mapping.json')
render_dwg_to_png_with_qcad(
    dwg_path=out_dxf,
    out_png=out_png,
    target_long_side_px=min(opts.target_long_side_px, 8000),
    background='white',
)
write_mapping_from_dxf_and_png(
    dxf_path=out_dxf,
    png_path=out_png,
    out_json=out_map,
    pad_frac=opts.pad_frac,
)

con.execute(
    'UPDATE projects SET status=?, rooms_json_path=?, output_dxf_path=?, output_preview_png_path=?, error=?, updated_at=? WHERE id=?',
    ('ready', rooms_json, out_dxf, out_png, None, now, pid),
)
con.commit()

print({
    'project_id': pid,
    'rooms': len(rooms),
    'detectors': len(dets),
    'rooms_debug': rooms_debug,
    'overlay_png': overlay_png,
    'output_dxf': out_dxf,
})
