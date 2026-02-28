import os
import json
import sqlite3
import uuid
import time

from app.pipeline.options import PipelineOptions
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

rooms_json = row['rooms_json_path']
dxf_path = row['dxf_path']
pdir = f'/data/projects/{pid}'

if not rooms_json or not os.path.exists(rooms_json):
    raise RuntimeError(f'rooms_json missing: {rooms_json}')
if not dxf_path or not os.path.exists(dxf_path):
    raise RuntimeError(f'dxf_path missing: {dxf_path}')

with open(rooms_json, 'r', encoding='utf-8') as f:
    loaded_rooms = json.load(f)

if isinstance(loaded_rooms, dict):
    rooms = loaded_rooms.get('rooms', [])
else:
    rooms = loaded_rooms

debug_png = os.path.join(pdir, 'detectors_global_snapping_debug.png')
overlay_png = os.path.join(pdir, 'detectors_global_snapping_overlay.png')
placed, _ = place_detectors_from_rooms_json(
    rooms,
    opts.detector_spacing_m,
    opts.wall_buffer_m,
    opts.world_to_m,
    debug_png_path=debug_png,
    debug_overlay_png_path=overlay_png,
    mapping_json_path=row['mapping_json_path'],
    base_png_path=row['render_png_path'],
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
    'UPDATE projects SET status=?, output_dxf_path=?, output_preview_png_path=?, error=?, updated_at=? WHERE id=?',
    ('ready', out_dxf, out_png, None, now, pid),
)
con.commit()

print({
    'project_id': pid,
    'detectors': len(dets),
    'debug_png': debug_png,
    'overlay_png': overlay_png,
    'output_dxf': out_dxf,
    'output_preview_png': out_png,
    'output_preview_mapping': out_map,
})
