/* AFRi Studio -- parameter schema, concepts, finishes and framing.
 *
 * Everything the interface can change about a design is declared here, once,
 * with its bounds and the sentence that explains it. The controls, the command
 * palette, the Claude designer's allow-list and the tech pack all read this
 * table, so a parameter cannot exist in one and be missing from another.
 */

/* group = [title, openByDefault, [ [key, min, max, step, unit, help], ... ] ] */
export const FLOWER_GROUPS = [
  ['Form', true, [
    ['diameter_mm', 30, 200, 1, 'mm', 'Overall diameter of the finished flower.'],
    ['relief_depth_mm', 4, 60, 0.5, 'mm', 'Height of the domed rosette above its base plane.'],
    ['thickness_mm', 0.3, 5, 0.1, 'mm', 'Material thickness of each petal.'],
  ]],
  ['Petals', true, [
    ['layer_count', 1, 12, 1, 'rows', 'Number of concentric petal rows.'],
    ['petal_count_base', 5, 60, 1, 'petals', 'Petals in the outermost row; inner rows scale from this.'],
    ['petal_density', 0.4, 2.5, 0.05, '×', 'Multiplier on petals per row. Higher reads fuller.'],
    ['petal_length_ratio', 0.15, 0.75, 0.01, '×', 'Petal length as a fraction of flower radius.'],
    ['petal_width_ratio', 0.2, 1.4, 0.01, '×', 'Width relative to natural spacing. Above 1 overlaps.'],
    ['petal_overlap', 0, 0.8, 0.01, '×', 'Radial overlap between adjacent rows.'],
  ]],
  ['Petal shape', false, [
    ['petal_curvature', 0, 1, 0.01, '×', 'Lengthwise curl. 0 is flat, 1 curls strongly inward.'],
    ['dome_gain', 0.1, 1.2, 0.01, '×', 'How steeply the rows climb toward the centre. This is what turns a flat rosette into a pompon.'],
    ['petal_cup', 0, 1, 0.01, '×', 'Crosswise cupping, the channel along the petal.'],
    ['petal_ruffle_amp', 0, 1, 0.01, '×', 'Amplitude of the ruffled petal edge.'],
    ['petal_ruffle_freq', 1, 10, 0.1, 'cycles', 'Number of ruffle waves across the petal edge.'],
    ['petal_notch', 0, 0.7, 0.01, '×', 'Depth of the notch at the petal tip.'],
    ['layer_tilt_gain', 0, 1.4, 0.01, '×', 'How much more upright each inner row stands.'],
  ]],
  ['Centre', false, [
    ['center_diameter_ratio', 0.08, 0.6, 0.01, '×', 'Centre boss diameter as a fraction of flower diameter.'],
    ['center_dome_height', 0, 1.2, 0.01, '×', 'Centre dome height relative to relief depth.'],
    ['center_floret_rings', 0, 10, 1, 'rings', 'Rings of tiny disc florets in the centre.'],
  ]],
  ['Structure', false, [
    ['base_disc_ratio', 0.15, 0.95, 0.01, '×', 'Structural base disc diameter. This is what physically carries each half.'],
    ['base_thickness_mm', 0.5, 6, 0.1, 'mm', 'Thickness of the structural base disc.'],
  ]],
  ['Variation', false, [
    ['organic_variation', 0, 1, 0.01, '×', 'Per-petal jitter in angle, length, width and tilt.'],
    ['seed', 1, 999999, 1, '', 'Random seed. The same seed reproduces the flower exactly.'],
  ]],
];

export const SPLIT_GROUP = ['Dividing curve', true, [
  ['position', -0.6, 0.6, 0.01, '×', 'Lateral position of the split. 0 is centred.'],
  ['orientation_deg', -180, 180, 1, '°', 'Rotation of the split axis around the flower.'],
  ['amplitude', 0, 0.9, 0.01, '×', 'How far the curve swings sideways. This drives the S.'],
  ['smoothness', 0.05, 1, 0.01, '×', 'Curve softness. Low is taut and angular, high is flowing.'],
  ['organic_roughness', 0, 1, 0.01, '×', 'Irregularity of the organic split only.'],
]];

export const HAT_GROUP = ['Hat', false, [
  ['head_circumference_mm', 520, 640, 5, 'mm', 'Inside head circumference. 58 cm is the commonest adult size, and it is the one dimension a hat cannot get wrong.'],
  ['crown_height_mm', 40, 200, 1, 'mm', 'Height of the crown above the brim plane.'],
  ['crown_crease', 0, 1.5, 0.01, '×', 'Depth of the centre crease and finger dents. 0 leaves a smooth crown.'],
  ['brim_width_mm', 10, 180, 1, 'mm', 'Brim reach beyond the head radius. This is what decides whether the accessory fits.'],
  ['brim_droop_deg', -10, 45, 0.5, '°', 'How far the brim falls from horizontal.'],
  ['brim_curl', 0, 0.6, 0.01, '×', 'Upward curl at the outer edge.'],
  ['thickness_mm', 0.4, 6, 0.1, 'mm', 'Material thickness of the hat body.'],
  ['band_height_mm', 0, 90, 1, 'mm', 'Height of the ribbon band. 0 omits it.'],
]];

export const PLACEMENT_GROUP = ['Placement', false, [
  ['radial_position', 0, 1, 0.01, '×', '0 seats the accessory against the band at the crown foot; 1 puts it at the brim edge.'],
  ['azimuth_deg', -180, 180, 1, '°', 'Position around the crown. 0 is the front of the hat.'],
  ['surface_offset_mm', -5, 30, 0.1, 'mm', 'Lift off the hat surface. The fixing takes up this gap.'],
  ['tilt_deg', -60, 60, 1, '°', 'Tip the accessory outward (+) or inward (-) from the local surface.'],
  ['roll_deg', -180, 180, 1, '°', 'Spin it in its own plane. This aims the dividing curve.'],
]];

export const HAT_STYLES = [
  ['fedora', 'Fedora'], ['wide_brim', 'Wide brim'], ['boater', 'Boater'],
  ['cloche', 'Cloche'], ['bucket', 'Bucket'],
];

export const CURVE_FAMILIES = [
  ['balanced', 'Balanced — single stroke'],
  ['s_river', 'S river — meander'],
  ['organic', 'Organic — fractal wander'],
];

export const CONCEPTS = [
  { key: 'A', name: 'Balanced Split',
    desc: 'A clear, near-symmetric division. The dividing line reads as a single confident stroke.',
    split: { type: 'balanced', position: 0, amplitude: 0.18, smoothness: 0.7, orientation_deg: 0, separation_mm: 18 } },
  { key: 'B', name: 'S River Split', priority: true,
    desc: 'A flowing, river-inspired separation with an editable curve.',
    split: { type: 's_river', position: 0, amplitude: 0.34, smoothness: 0.72, orientation_deg: 12, separation_mm: 18 } },
  { key: 'C', name: 'Organic Asymmetric',
    desc: 'An expressive, irregular division that wanders with the petal arrangement.',
    split: { type: 'organic', position: 0.10, amplitude: 0.40, smoothness: 0.55, orientation_deg: -28,
             separation_mm: 55, organic_octaves: 3, organic_roughness: 0.55, organic_seed: 11 } },
];

/* The refined marigold from the Concept C v2 review. One master flower serves
 * all three concepts -- only the dividing curve differs -- so the refinement
 * applies to every concept. ENGINE.FLOWER_DEFAULTS is left alone: it is the
 * engine's own baseline and what the Python parity test compares against. */
export const REFINED = {
  layer_count: 9, petal_count_base: 26, petal_density: 1.65, petal_overlap: 0.56,
  petal_length_ratio: 0.37, petal_width_ratio: 1.12,
  petal_curvature: 0.64, petal_cup: 0.58, layer_tilt_gain: 0.80,
  relief_depth_mm: 40.0, dome_gain: 0.56,
  petal_ruffle_amp: 0.42, petal_ruffle_freq: 4.6, petal_notch: 0.10,
  center_diameter_ratio: 0.14, center_dome_height: 0.16, center_floret_rings: 3,
  organic_variation: 0.52,
};

/* Finishes. Each is a plausible way the accessory could actually be made, and
 * each sets the shading of both halves plus the freshly cut wall between them,
 * which in a real part is the one face that shows the raw material. */
export const MATERIALS = [
  { key: 'resin', name: 'Marigold resin', note: 'Cast urethane, pigment through the body.',
    a: 0xF2A007, b: 0xE0780D, wall: 0xC8541B, roughness: 0.62, metalness: 0.02, wallRough: 0.48 },
  { key: 'brass', name: 'Polished brass', note: 'Lost-wax cast, hand polished.',
    a: 0xC9942F, b: 0xB07B22, wall: 0x8C5F18, roughness: 0.26, metalness: 0.92, wallRough: 0.42 },
  { key: 'enamel', name: 'Cream enamel', note: 'Vitreous enamel over a cast core.',
    a: 0xF3E8D3, b: 0xE4D4B6, wall: 0xB98B4E, roughness: 0.22, metalness: 0.04, wallRough: 0.5 },
  { key: 'felt', name: 'Dyed wool felt', note: 'Blocked felt, the millinery route.',
    a: 0xC4541F, b: 0xA6421A, wall: 0x7C3214, roughness: 0.96, metalness: 0.0, wallRough: 0.96 },
  { key: 'graphite', name: 'Matte graphite', note: 'SLS nylon, dyed and tumbled.',
    a: 0x4A4A46, b: 0x3A3A36, wall: 0x6E6A5E, roughness: 0.82, metalness: 0.12, wallRough: 0.7 },
];

/* Lighting rigs. Colour and intensity only -- the geometry never moves, so a
 * measurement taken under one rig is the measurement under all of them. */
export const ENVIRONMENTS = [
  { key: 'studio', name: 'Studio warm',
    hemi: [0xF6E2C0, 0x1A1610, 0.85],
    key_: [0xFFF0D6, 2.35, [7, -9, 12]],
    fill: [0xC8D8FF, 0.55, [-9, 4, 5]],
    rim: [0xFFB347, 0.85, [-3, 10, -6]] },
  { key: 'daylight', name: 'North daylight',
    hemi: [0xDDE8F6, 0x201E18, 1.15],
    key_: [0xFFFFFF, 1.9, [5, -8, 13]],
    fill: [0xBFD4F2, 1.0, [-8, 5, 6]],
    rim: [0xFFFFFF, 0.45, [-2, 9, -5]] },
  { key: 'dusk', name: 'Dusk',
    hemi: [0x6B5B7A, 0x14110C, 0.5],
    key_: [0xFFC98A, 1.5, [9, -6, 6]],
    fill: [0x7D8BC4, 0.4, [-7, 6, 4]],
    rim: [0xFF8A3D, 1.6, [-4, 8, -7]] },
  { key: 'flat', name: 'Flat inspection',
    hemi: [0xFFFFFF, 1.5, [0xBFC3B4, 0, 0]],
    key_: [0xFFFFFF, 1.1, [6, -7, 10]],
    fill: [0xFFFFFF, 0.9, [-7, 5, 6]],
    rim: [0xFFFFFF, 0.5, [0, 8, -8]] },
];

/* azimuth, elevation, and distance as a multiple of the measured radius, so
 * the framing holds when the flower's diameter changes. */
export const VIEWS = {
  three_quarter: [0.66, 0.52, 4.7],
  top: [-Math.PI / 2, 1.44, 4.3],
  front: [-Math.PI / 2, 0.10, 5.0],
  side: [0, 0.14, 5.0],
};
export const VIEW_LABELS = [
  ['three_quarter', 'Three quarter'], ['top', 'Top'], ['front', 'Front'], ['side', 'Side'],
];

/* ---- flat index -------------------------------------------------------- */
/* name -> {scope, key, lo, hi, step, unit, help, label}. One lookup table for
 * the command palette, the designer's validator and the parameter diff. */
export const PARAMS = (() => {
  const out = new Map();
  const add = (scope, group) => {
    for (const [key, lo, hi, step, unit, help] of group) {
      out.set(scope + '.' + key, { scope, key, lo, hi, step, unit, help, label: label(key) });
    }
  };
  for (const [, , items] of FLOWER_GROUPS) add('flower', items);
  add('split', SPLIT_GROUP[2]);
  add('hat', HAT_GROUP[2]);
  add('placement', PLACEMENT_GROUP[2]);
  return out;
})();

export function label(key) {
  return key.replace(/_/g, ' ').replace(/\bmm\b/, '(mm)').replace(/\bdeg\b/, '(deg)');
}

export function fmt(x, d) { return Number(x).toFixed(d); }

/* A parameter's display value: integers stay integers, everything else keeps
 * two decimals, and the unit rides along. */
export function showValue(spec, v) {
  const s = (spec.step >= 1) ? String(Math.round(v)) : fmt(v, 2);
  return spec.unit ? s + ' ' + spec.unit : s;
}
