// STARK component libraries.
// Ring types and detector types transcribed from the "STARK detectors/rings"
// sheet (tabs I_Rings and I_Detectors). All lengths in mm, thickness in um.

// dir 1 = detectors face the beam axis radially (barrel: X6/BB10/CSD)
// dir 2 = detectors face along z (annular: QQQ5/CQ)
// off  = ring front face z  ->  detector z-centre
// z1/z2 = ring's own z extent relative to its front face
export const RING_TYPES = {
  '12':    { div: 12, r: 91.7,  off:  70.75, z1: 0,  z2: -12, dir: 1, det: 'X6' },
  '12dE':  { div: 12, r: 91.7,  off: -70.75, z1: 0,  z2:  15, dir: 1, det: 'BB10' },
  '12E':   { div: 12, r: 109.2, off: -52.75, z1: 0,  z2:  15, dir: 1, det: 'X6' },
  '16':    { div: 16, r: 140.5, off: -52.75, z1: 0,  z2:  50, dir: 1, det: 'X6' },
  'Q':     { div:  4, r: 110,   off: -53.8,  z1: 60, z2:  15, dir: 2, det: 'QQQ5' },
  'Q2':    { div:  4, r: 110,   off: -46.9,  z1: 0,  z2:   0, dir: 2, det: 'QQQ5' },
  '12dEb': { div: 12, r: 91.7,  off:  70.75, z1: 0,  z2: -15, dir: 1, det: 'BB10' },
  '12Eb':  { div: 12, r: 109.2, off:  52.75, z1: 0,  z2: -15, dir: 1, det: 'X6' },
};

// w/h = active area (mm), thick = um, nJ/nO = junction/ohmic strip counts
export const DET_TYPES = {
  X6:    { shape: 'rect',    w: 40.3,  h: 75,    thick: 1000, nJ: 8,  nO: 4,  ch: 20, note: 'resistive front strips' },
  BB10:  { shape: 'rect',    w: 39.45, h: 74.15, thick: 140,  nJ: 8,  nO: 0,  ch: 8,  note: 'dE, no back segmentation' },
  CSD:   { shape: 'rect',    w: 40.3,  h: 75,    thick: 1000, nJ: 4,  nO: 1,  ch: 5,  note: '' },
  W1:    { shape: 'rect',    w: 49.5,  h: 49.5,  thick: 1000, nJ: 16, nO: 16, ch: 32, note: 'Micron W1 DSSD' },
  QQQ5:  { shape: 'annular', rin: 25.25, rout: 81.95, thick: 1000, nJ: 32, nO: 4, ch: 36, note: '' },
  CQ:    { shape: 'annular', rin: 25,    rout: 80,    thick: 500,  nJ: 32, nO: 4, ch: 36, note: '' },
};

export const DET_COLOR = {
  X6: '#3f7fd0', BB10: '#2fa89a', QQQ5: '#8a6fd0', CQ: '#7a63ba',
  CSD: '#c56a9c', W1: '#5c8f3f',
};

// Bethe-Bloch inputs: rho g/cm3, ZA = <Z/A>, I = mean excitation energy (eV)
export const MATERIALS = {
  CH2:    { rho: 0.94,  ZA: 0.5714, I: 57.4 },
  CD2:    { rho: 1.06,  ZA: 0.5000, I: 57.4 },
  C:      { rho: 2.00,  ZA: 0.4995, I: 78.0 },
  Au:     { rho: 19.32, ZA: 0.4011, I: 790.0 },
  Al:     { rho: 2.70,  ZA: 0.4818, I: 166.0 },
  Si:     { rho: 2.329, ZA: 0.4985, I: 173.0 },
  Ti:     { rho: 4.54,  ZA: 0.4596, I: 233.0 },
  Mylar:  { rho: 1.40,  ZA: 0.5203, I: 78.7 },
  Havar:  { rho: 8.30,  ZA: 0.4545, I: 340.0 },
  LiF:    { rho: 2.64,  ZA: 0.4626, I: 94.0 },
  D2gas:  { rho: 0.0002, ZA: 0.4960, I: 19.2 },
};

export const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 8);

// Default layout: the "STARK 0330" arrangement from the sheet
// (16/X6 @140, 12E/X6 @180, 12dE/X6 @190, Q/QQQ5 @210), target at z = 0.
export const defaultSetup = function () {
  const ring = (name, type, z, det) => {
    const t = RING_TYPES[type];
    return {
      id: uid('ring'), kind: 'ring', name, type, z,
      div: t.div, r: t.r, off: t.off, offMode: 'center',
      z1: t.z1, z2: t.z2, rmin: Math.max(0, t.r - 4), rmax: t.r + 12,
      dir: t.dir, det: det || t.det, phi0: t.dir === 1 ? 180 / t.div : 45,
      flip: false, mount: 'frame', enabled: true,
    };
  };
  return {
    name: 'STARK 0330',
    beamSlots: [{
      id: uid('beam'), name: 'Beam A', nuc: '7Li', energy: 5.0, eUnit: 'MeV/u',
      intensity: 1e5, sx: 2.0, sy: 2.0, x0: 0, y0: 0, divx: 0, divy: 0, active: true,
    }],
    targetSlots: [{
      id: uid('targ'), name: 'CD2 1.0 mg/cm2', material: 'CD2', nuc: '2H',
      thickUnit: 'mg/cm2', thick: 1.0, radius: 7.5, z: 0, x0: 0, y0: 0, active: true,
    }],
    collimators: [{
      id: uid('coll'), name: 'Collimator 1', r: 5.0, z: -60, thick: 3, enabled: true,
    }],
    rings: [
      ring('Ring 16', '16', 140, 'X6'),
      ring('Ring 12E', '12E', 180, 'X6'),
      ring('Ring 12dE', '12dE', 190, 'X6'),
      ring('Ring Q', 'Q', 210, 'QQQ5'),
    ],
    singles: [],
    reaction: { ejectile: '1H', Ex: 0 },
    view: { zedit: false, showRings: true, showBeam: true, showLabels: true, showRuler: true },
  };
};
