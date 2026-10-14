/* orca3mf.js: multicolour project 3MF writer for single file browser benches.
 * Orca / Bambu Studio / Flash Studio dialect: parts pre assigned to filaments,
 * filament list fully declared. Plain script, no modules, works from file://.
 * Needs JSZip on the page for .zip(); everything else is dependency free.
 *
 *   const pkg = Orca3MF.build({
 *     filaments: [{color:'#1a1a1a', type:'PETG', name:'black'}, {color:'#FE0386', type:'PETG'}],
 *     printer: Orca3MF.DEFAULT_PRINTER,            // names only; '' leaves the slicer's selection alone
 *     presetPattern: 'Generic {TYPE} @FF C5P',
 *     writeFilaments: true,                        // false = keep the machine's tuned presets
 *     layerHeight: 0.24, title: 'coin',
 *     objects: [{ name:'coin', positions:[[128,128,0]],
 *                 parts:[{name:'body', slot:1, positions:Float32Array, indices:Uint32Array}, ...] }]
 *   });
 *   pkg.entries          // {path: string} every package entry
 *   await pkg.zip()      // Blob (needs window.JSZip); pkg.zip(JSZip, 'uint8array') for node
 *   Orca3MF.stl(part)    // ArrayBuffer, binary STL of one part
 *   Orca3MF.printCard(cfg) // text
 *
 * Coordinates: mm, part local, bed at z=0, triangles CCW from outside.
 * Parts of one object must not overlap each other. This writer repairs nothing.
 */
(function (root) {
  'use strict';
  const MATERIALS = {"PLA": {"tray": "GFL99", "nozzle": 215, "nozzle_first": 220, "bed": 55, "bed_first": 55, "density": 1.24, "cost": 20, "vitrification": 45, "maxvol": 12, "fan_max": 100, "fan_min": 100, "overhang_fan": 100, "flow": 0.98, "range_low": 190, "range_high": 240}, "PETG": {"tray": "GFG99", "nozzle": 240, "nozzle_first": 245, "bed": 70, "bed_first": 70, "density": 1.27, "cost": 25, "vitrification": 60, "maxvol": 10, "fan_max": 40, "fan_min": 20, "overhang_fan": 90, "flow": 0.95, "range_low": 220, "range_high": 270}, "ABS": {"tray": "GFB99", "nozzle": 250, "nozzle_first": 255, "bed": 90, "bed_first": 90, "density": 1.04, "cost": 25, "vitrification": 90, "maxvol": 12, "fan_max": 30, "fan_min": 10, "overhang_fan": 80, "flow": 0.95, "range_low": 240, "range_high": 270}, "ASA": {"tray": "GFB98", "nozzle": 255, "nozzle_first": 260, "bed": 95, "bed_first": 95, "density": 1.05, "cost": 28, "vitrification": 95, "maxvol": 12, "fan_max": 30, "fan_min": 10, "overhang_fan": 80, "flow": 0.95, "range_low": 240, "range_high": 280}, "TPU": {"tray": "GFU99", "nozzle": 225, "nozzle_first": 230, "bed": 40, "bed_first": 40, "density": 1.21, "cost": 40, "vitrification": 35, "maxvol": 3.2, "fan_max": 100, "fan_min": 100, "overhang_fan": 100, "flow": 0.98, "range_low": 200, "range_high": 250}, "PC": {"tray": "GFC99", "nozzle": 270, "nozzle_first": 270, "bed": 100, "bed_first": 100, "density": 1.2, "cost": 40, "vitrification": 110, "maxvol": 10, "fan_max": 40, "fan_min": 10, "overhang_fan": 80, "flow": 0.94, "range_low": 250, "range_high": 300}, "PA": {"tray": "GFN99", "nozzle": 265, "nozzle_first": 270, "bed": 80, "bed_first": 80, "density": 1.14, "cost": 40, "vitrification": 80, "maxvol": 8, "fan_max": 40, "fan_min": 10, "overhang_fan": 80, "flow": 0.94, "range_low": 250, "range_high": 300}, "PVA": {"tray": "GFS99", "nozzle": 200, "nozzle_first": 200, "bed": 55, "bed_first": 55, "density": 1.23, "cost": 60, "vitrification": 50, "maxvol": 4, "fan_max": 100, "fan_min": 100, "overhang_fan": 100, "flow": 0.95, "range_low": 180, "range_high": 220}};
  const FILAMENT_TEMPLATE = {"verbatim": {"activate_air_filtration": "0", "activate_chamber_temp_control": "0", "additional_cooling_fan_speed": "70", "chamber_temperature": "0", "close_fan_the_first_x_layers": "1", "complete_print_exhaust_fan_speed": "70", "default_filament_colour": "", "dont_slow_down_outer_wall": "0", "during_print_exhaust_fan_speed": "70", "enable_overhang_bridge_fan": "1", "enable_pressure_advance": "0", "fan_cooling_layer_time": "60", "filament_cooling_final_speed": "3.4", "filament_cooling_initial_speed": "2.2", "filament_cooling_moves": "4", "filament_deretraction_speed": "nil", "filament_diameter": "1.75", "filament_end_gcode": "; filament end gcode \n", "filament_is_support": "0", "filament_load_time": "0", "filament_loading_speed": "28", "filament_loading_speed_start": "3", "filament_long_retractions_when_cut": "0", "filament_minimal_purge_on_wipe_tower": "15", "filament_multitool_ramming": "0", "filament_multitool_ramming_flow": "10", "filament_multitool_ramming_volume": "10", "filament_notes": "", "filament_prime_volume": "45", "filament_ramming_parameters": "120 100 6.6 6.8 7.2 7.6 7.9 8.2 8.7 9.4 9.9 10.0| 0.05 6.6 0.45 6.8 0.95 7.8 1.45 8.3 1.95 9.7 2.45 10 2.95 7.6 3.45 7.6 3.95 7.6 4.45 7.6 4.95 7.6", "filament_retract_before_wipe": "nil", "filament_retract_lift_above": "nil", "filament_retract_lift_below": "nil", "filament_retract_lift_enforce": "nil", "filament_retract_restart_extra": "nil", "filament_retract_when_changing_layer": "nil", "filament_retraction_distances_when_cut": "18", "filament_retraction_length": "nil", "filament_retraction_minimum_travel": "nil", "filament_retraction_speed": "nil", "filament_scarf_gap": "0%", "filament_scarf_height": "10%", "filament_scarf_length": "10", "filament_scarf_seam_type": "none", "filament_shrink": "100%", "filament_shrinkage_compensation_z": "100%", "filament_soluble": "0", "filament_stamping_distance": "0", "filament_stamping_loading_speed": "20", "filament_start_gcode": "; filament start gcode\n", "filament_toolchange_delay": "0", "filament_unload_time": "0", "filament_unloading_speed": "90", "filament_unloading_speed_start": "100", "filament_wipe": "nil", "filament_wipe_distance": "nil", "filament_z_hop": "nil", "filament_z_hop_types": "nil", "full_fan_speed_layer": "0", "idle_temperature": "0", "overhang_fan_threshold": "95%", "pressure_advance": "0.02", "reduce_fan_stop_start_freq": "1", "required_nozzle_HRC": "3", "slow_down_for_layer_cooling": "1", "slow_down_layer_time": "8", "slow_down_min_speed": "20", "support_material_interface_fan_speed": "-1"}, "computed": ["filament_colour", "filament_type", "filament_vendor", "filament_ids", "filament_settings_id", "filament_density", "filament_cost", "filament_flow_ratio", "filament_max_volumetric_speed", "nozzle_temperature", "nozzle_temperature_initial_layer", "nozzle_temperature_range_low", "nozzle_temperature_range_high", "hot_plate_temp", "hot_plate_temp_initial_layer", "cool_plate_temp", "cool_plate_temp_initial_layer", "eng_plate_temp", "eng_plate_temp_initial_layer", "textured_plate_temp", "textured_plate_temp_initial_layer", "textured_cool_plate_temp", "textured_cool_plate_temp_initial_layer", "supertack_plate_temp", "supertack_plate_temp_initial_layer", "temperature_vitrification", "fan_max_speed", "fan_min_speed", "overhang_fan_speed"]};
  const APP_VERSION = '01.10.01.50';
  const APPLICATION = 'BambuStudio-' + APP_VERSION;
  const SUF = {
    object: '-61cb-4c03-9d28-80fed5dfa1dc',
    sub: '-81cb-4c03-9d28-80fed5dfa1dc',
    comp: '-b206-40ff-9872-83e8017abed1',
    item: '-b1ec-4553-aec9-835e5b724bb4'
  };
  const BUILD_UUID = '2c7c17d8-22b5-4d84-8835-1976022ea369';
  const DEFAULT_PRINTER = {
    printer_settings_id: 'Flashforge Creator 5 Pro 0.4 nozzle',
    print_settings_id: '0.24mm Standard @FF C5',
    printer_model: 'Flashforge Creator 5 Pro',
    printer_variant: '0.4',
    printer_technology: 'FFF'
  };
  const DEFAULT_PATTERN = 'Generic {TYPE} @FF C5P';

  const uuid = (n, suf) => ('00000000' + (n >>> 0).toString(16)).slice(-8) + suf;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = v => { let s = (+v).toFixed(6).replace(/\.?0+$/, ''); return (s === '-0' || s === '') ? '0' : s; };
  const g = v => (typeof v === 'number' ? String(+v.toPrecision(6)) : String(v));

  function normFilaments(fils) {
    if (!fils || !fils.length) throw new Error('need at least one filament');
    return fils.map(f => {
      const type = String(f.type || 'PETG').toUpperCase();
      if (!MATERIALS[type]) throw new Error('unknown material ' + type);
      let color = f.color || '#808080';
      if (color[0] !== '#') color = '#' + color;
      return { color: color.toUpperCase(), type, name: f.name || '' };
    });
  }

  function signedVolume(part) {
    const p = part.positions, ix = part.indices;
    let v = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return v / 6;
  }

  function plan(objects) {
    let nid = 1;
    return objects.map(o => {
      if (!o.parts || !o.parts.length) throw new Error('object ' + o.name + ' has no parts');
      const meshIds = o.parts.map(() => nid++);
      const objId = nid++;
      const pos = (o.positions && o.positions.length ? o.positions : [[0, 0, 0]]).map(p => [p[0] || 0, p[1] || 0, p[2] || 0]);
      return { obj: o, meshIds, objId, pos };
    });
  }

  function modelXml(cfg, P) {
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n');
    const today = new Date().toISOString().slice(0, 10);
    const title = cfg.title || (P[0] && P[0].obj.name) || 'model';
    [['Application', APPLICATION], ['BambuStudio:3mfVersion', '1'], ['Copyright', ''], ['CreationDate', today],
     ['Description', ''], ['Designer', ''], ['DesignerCover', ''], ['DesignerUserId', ''], ['License', ''],
     ['ModificationDate', today], ['Origin', ''], ['Title', title]]
      .forEach(([k, v]) => out.push(' <metadata name="' + k + '">' + esc(v) + '</metadata>\n'));
    out.push(' <resources>\n');
    for (const p of P) {
      p.obj.parts.forEach((part, i) => {
        const mid = p.meshIds[i];
        const pos = part.positions, ix = part.indices;
        if (!ix || !ix.length) throw new Error('part ' + part.name + ' has no triangles');
        out.push('  <object id="' + mid + '" p:UUID="' + uuid(mid, SUF.sub) + '" type="model">\n   <mesh>\n    <vertices>\n');
        const vs = new Array(pos.length / 3);
        for (let k = 0, j = 0; k < pos.length; k += 3, j++) vs[j] = '     <vertex x="' + fmt(pos[k]) + '" y="' + fmt(pos[k + 1]) + '" z="' + fmt(pos[k + 2]) + '"/>';
        out.push(vs.join('\n') + '\n    </vertices>\n    <triangles>\n');
        const ts = new Array(ix.length / 3);
        for (let k = 0, j = 0; k < ix.length; k += 3, j++) ts[j] = '     <triangle v1="' + ix[k] + '" v2="' + ix[k + 1] + '" v3="' + ix[k + 2] + '"/>';
        out.push(ts.join('\n') + '\n    </triangles>\n   </mesh>\n  </object>\n');
      });
      out.push('  <object id="' + p.objId + '" p:UUID="' + uuid(p.objId, SUF.object) + '" type="model">\n   <components>\n');
      for (const mid of p.meshIds) {
        out.push('    <component objectid="' + mid + '" p:UUID="' + uuid(mid, SUF.comp) + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n');
      }
      out.push('   </components>\n  </object>\n');
    }
    out.push(' </resources>\n <build p:UUID="' + BUILD_UUID + '">\n');
    let n = 1;
    for (const p of P) for (const [x, y, z] of p.pos) {
      out.push('  <item objectid="' + p.objId + '" p:UUID="' + uuid(n++, SUF.item) + '" transform="1 0 0 0 1 0 0 0 1 ' + fmt(x) + ' ' + fmt(y) + ' ' + fmt(z) + '" printable="1"/>\n');
    }
    out.push(' </build>\n</model>\n');
    return out.join('');
  }

  function modelSettingsXml(cfg, P) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
    for (const p of P) {
      out.push('  <object id="' + p.objId + '">\n    <metadata key="name" value="' + esc(p.obj.name) + '"/>\n' +
        '    <metadata key="extruder" value="' + (p.obj.parts[0].slot | 0) + '"/>\n');
      p.obj.parts.forEach((part, i) => {
        const mid = p.meshIds[i];
        out.push('    <part id="' + mid + '" subtype="normal_part">\n' +
          '      <metadata key="name" value="' + esc(part.name) + '"/>\n' +
          '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
          '      <metadata key="source_file" value="' + esc(p.obj.name) + '.3mf"/>\n' +
          '      <metadata key="source_object_id" value="0"/>\n' +
          '      <metadata key="source_volume_id" value="' + i + '"/>\n' +
          '      <metadata key="source_offset_x" value="0"/>\n      <metadata key="source_offset_y" value="0"/>\n      <metadata key="source_offset_z" value="0"/>\n' +
          '      <metadata key="extruder" value="' + (part.slot | 0) + '"/>\n' +
          '      <mesh_stat face_count="' + (part.indices.length / 3) + '" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n' +
          '    </part>\n');
      });
      out.push('  </object>\n');
    }
    out.push('  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n' +
      '    <metadata key="locked" value="false"/>\n    <metadata key="filament_map_mode" value="' + esc(cfg.filamentMapMode || 'Auto For Flush') + '"/>\n' +
      '    <metadata key="filament_maps" value="' + cfg.filaments.map(() => '1').join(' ') + '"/>\n');
    let ident = 400;
    for (const p of P) p.pos.forEach((_, i) => {
      out.push('    <model_instance>\n      <metadata key="object_id" value="' + p.objId + '"/>\n      <metadata key="instance_id" value="' + i + '"/>\n' +
        '      <metadata key="identify_id" value="' + (++ident) + '"/>\n    </model_instance>\n');
    });
    out.push('  </plate>\n  <assemble>\n');
    for (const p of P) p.pos.forEach(([x, y, z], i) => {
      out.push('   <assemble_item object_id="' + p.objId + '" instance_id="' + i + '" transform="1 0 0 0 1 0 0 0 1 ' + fmt(x) + ' ' + fmt(y) + ' ' + fmt(z) + '" offset="0 0 0" />\n');
    });
    out.push('  </assemble>\n</config>\n');
    return out.join('');
  }

  function projectSettings(cfg) {
    const ps = {};
    const printer = Object.assign({}, DEFAULT_PRINTER, cfg.printer || {});
    for (const k in printer) if (printer[k]) ps[k] = printer[k];
    ps.version = APP_VERSION;
    const pat = cfg.presetPattern || DEFAULT_PATTERN;
    const F = cfg.filaments;
    if (cfg.writeFilaments === false) {
      ps.filament_colour = F.map(f => f.color);
      ps.filament_settings_id = F.map(f => pat.replace('{TYPE}', f.type));
      ps.filament_type = F.map(f => f.type);
      return ps;
    }
    for (const k in FILAMENT_TEMPLATE.verbatim) ps[k] = F.map(() => FILAMENT_TEMPLATE.verbatim[k]);
    const per = {};
    FILAMENT_TEMPLATE.computed.forEach(k => per[k] = []);
    for (const f of F) {
      const m = MATERIALS[f.type];
      const vals = {
        filament_colour: f.color, filament_type: f.type, filament_vendor: 'Generic', filament_ids: m.tray,
        filament_settings_id: pat.replace('{TYPE}', f.type), filament_density: g(m.density), filament_cost: g(m.cost),
        filament_flow_ratio: g(m.flow), filament_max_volumetric_speed: g(m.maxvol),
        nozzle_temperature: g(m.nozzle), nozzle_temperature_initial_layer: g(m.nozzle_first),
        nozzle_temperature_range_low: g(m.range_low), nozzle_temperature_range_high: g(m.range_high),
        hot_plate_temp: g(m.bed), hot_plate_temp_initial_layer: g(m.bed_first),
        cool_plate_temp: g(m.bed), cool_plate_temp_initial_layer: g(m.bed_first),
        eng_plate_temp: g(m.bed), eng_plate_temp_initial_layer: g(m.bed_first),
        textured_plate_temp: g(m.bed), textured_plate_temp_initial_layer: g(m.bed_first),
        textured_cool_plate_temp: g(m.bed), textured_cool_plate_temp_initial_layer: g(m.bed_first),
        supertack_plate_temp: g(m.bed), supertack_plate_temp_initial_layer: g(m.bed_first),
        temperature_vitrification: g(m.vitrification), fan_max_speed: g(m.fan_max), fan_min_speed: g(m.fan_min),
        overhang_fan_speed: g(m.overhang_fan)
      };
      for (const k in per) per[k].push(vals[k] !== undefined ? vals[k] : '');
    }
    Object.assign(ps, per);
    for (const k in ps) if (Array.isArray(ps[k]) && ps[k].length !== F.length) throw new Error('per filament key ' + k + ' wrong length');
    if ('extruder_variant_list' in ps) throw new Error('extruder_variant_list must not be written');
    return ps;
  }

  function sliceInfoXml(cfg, P) {
    const printer = Object.assign({}, DEFAULT_PRINTER, cfg.printer || {});
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
      '    <header_item key="X-BBL-Client-Version" value="' + APP_VERSION + '"/>\n  </header>\n  <plate>\n'];
    [['index', '1'], ['printer_model_id', ''], ['nozzle_diameters', printer.printer_variant || '0.4'], ['timelapse_type', '0'],
     ['prediction', '0'], ['weight', '0'], ['outside', 'false'], ['support_used', 'false'], ['label_object_enabled', 'false']]
      .forEach(([k, v]) => out.push('    <metadata key="' + k + '" value="' + esc(v) + '"/>\n'));
    let ident = 400;
    for (const p of P) p.pos.forEach(() => out.push('    <object identify_id="' + (++ident) + '" name="' + esc(p.obj.name) + '" skipped="false" />\n'));
    cfg.filaments.forEach((f, i) => out.push('    <filament id="' + (i + 1) + '" tray_info_idx="' + MATERIALS[f.type].tray + '" type="' + f.type + '" color="' + f.color + '" used_m="0" used_g="0" />\n'));
    out.push('  </plate>\n</config>\n');
    return out.join('');
  }

  const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    ' <Default Extension="png" ContentType="image/png"/>\n</Types>\n';
  const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';

  function build(cfgIn) {
    const cfg = Object.assign({}, cfgIn);
    cfg.filaments = normFilaments(cfg.filaments);
    if (!cfg.objects || !cfg.objects.length) throw new Error('no objects');
    for (const o of cfg.objects) for (const part of o.parts) {
      if (!(part.slot >= 1 && part.slot <= cfg.filaments.length)) throw new Error('part ' + part.name + ' slot ' + part.slot + ' out of range');
    }
    const P = plan(cfg.objects);
    const entries = {
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': RELS,
      '3D/3dmodel.model': modelXml(cfg, P),
      'Metadata/model_settings.config': modelSettingsXml(cfg, P),
      'Metadata/project_settings.config': JSON.stringify(projectSettings(cfg), null, 4),
      'Metadata/slice_info.config': sliceInfoXml(cfg, P)
    };
    return {
      entries,
      cfg,
      zip: async function (JSZipCtor, type) {
        const JZ = JSZipCtor || root.JSZip;
        if (!JZ) throw new Error('JSZip not found on the page');
        const z = new JZ();
        for (const k in entries) z.file(k, entries[k]);
        return z.generateAsync({ type: type || ((typeof Blob === 'undefined') ? 'uint8array' : 'blob'), compression: 'DEFLATE' });
      }
    };
  }

  function stl(part, name) {
    const pos = part.positions, ix = part.indices, n = ix.length / 3;
    const buf = new ArrayBuffer(84 + n * 50);
    const dv = new DataView(buf);
    const hdr = 'orca3mf ' + (name || part.name || '');
    for (let i = 0; i < 80; i++) dv.setUint8(i, i < hdr.length ? hdr.charCodeAt(i) & 0xff : 0);
    dv.setUint32(80, n, true);
    let o = 84;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
      for (const k of [a, b, c]) { dv.setFloat32(o, pos[k], true); dv.setFloat32(o + 4, pos[k + 1], true); dv.setFloat32(o + 8, pos[k + 2], true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return buf;
  }

  function printCard(cfg) {
    const F = normFilaments(cfg.filaments);
    const printer = Object.assign({}, DEFAULT_PRINTER, cfg.printer || {});
    const L = ['PRINT CARD', '========================================',
      'printer  : ' + (printer.printer_settings_id || '(unchanged)'),
      'process  : ' + (printer.print_settings_id || '(unchanged)'),
      'layer    : ' + (cfg.layerHeight || 0.24).toFixed(2) + ' mm', ''];
    const vol = {};
    for (const o of cfg.objects) for (const part of o.parts) {
      vol[part.slot] = (vol[part.slot] || 0) + Math.abs(signedVolume(part)) * ((o.positions && o.positions.length) || 1);
    }
    F.forEach((f, i) => {
      const grams = (vol[i + 1] || 0) / 1000 * MATERIALS[f.type].density;
      L.push('slot ' + (i + 1) + '   : ' + f.color + ' ' + f.type + '   ' + (f.name || '') + '   ' + grams.toFixed(1) + ' g');
    });
    L.push('');
    for (const o of cfg.objects) L.push('object ' + o.name + ' x' + ((o.positions && o.positions.length) || 1) + ': ' + o.parts.map(p => p.name + '(slot ' + p.slot + ')').join(', '));
    L.push('', 'fallback if the filament list imports as one: open all per colour STLs at once, answer yes to',
      "'load as a single object with multiple parts', then set the filament per part.");
    return L.join('\n') + '\n';
  }

  root.Orca3MF = { build, stl, printCard, signedVolume, MATERIALS, FILAMENT_TEMPLATE, DEFAULT_PRINTER, DEFAULT_PATTERN, APPLICATION };
})(typeof globalThis !== 'undefined' ? globalThis : this);
