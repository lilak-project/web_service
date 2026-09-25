// node selfcheck.mjs — smoke test for the physics + geometry modules.
// Kept runnable outside the browser on purpose: these are the numbers the whole
// planner rests on, and they are cheap to check against the sheet and PSTAR.
import { PH } from './physics.js'
import { GEO } from './geometry.js'
import { RING_TYPES, MATERIALS } from './data.js'

const A = (c, m) => { if (!c) { console.error('FAIL ' + m); process.exitCode = 1; } else console.log('ok  ' + m); };

// masses
A(Math.abs(PH.nuc('2H').m - 1875.613) < 0.01, '2H mass 1875.613 MeV');

// 7Li(d,p)8Li  Q = 5.026 MeV (known)
const rx = PH.reaction('7Li', '2H', '1H', 35.0, 0);
A(rx.ok && rx.recName === '8Li', 'recoil identified as 8Li');
A(Math.abs(rx.Q + 0.192) < 0.01, 'Q = ' + rx.Q.toFixed(3) + ' MeV (expect -0.192)');
const dd = PH.reaction('2H', '2H', '1H', 10, 0);
A(Math.abs(dd.Q - 4.033) < 0.01, 'd(d,p)t Q = ' + dd.Q.toFixed(3) + ' MeV (expect 4.033)');
// inverse kinematics: light ejectile must reach 180 deg
A(rx.maxLab3 > 179, 'proton covers full lab range (' + rx.maxLab3.toFixed(1) + ' deg)');
// energy conservation at theta_cm = 0
const i0 = 0, tot = rx.T3[i0] + rx.T4[i0];
A(Math.abs(tot - (rx.Tbeam + rx.Q)) < 0.02, 'E conserved at 0 deg: ' + tot.toFixed(3) + ' vs ' + (rx.Tbeam + rx.Q).toFixed(3));
// lab <-> cm round trip
const probe = rx.atLab(40, 3);
A(probe.length >= 1 && Math.abs(probe[0].T - rx.T3[Math.round(probe[0].cm / 180 * (rx.cm.length - 1))]) < 0.3, 'lab->cm inversion consistent');

// geometry: 12E ring, X6 at r=109.2, z_centre = 127.25 per the sheet
const t = RING_TYPES['12E'];
const ring = { id: 'r', div: t.div, r: t.r, off: t.off, offMode: 'center', z: 180, z1: t.z1, z2: t.z2,
               rmin: t.r - 6, rmax: t.r + 22, dir: 1, det: 'X6', phi0: 15, enabled: true };
A(Math.abs(GEO.detCentreZ(ring) - 127.25) < 1e-9, 'detector z centre 127.25 mm');
const fs = GEO.faces(ring);
A(fs.length === 12, '12 faces');
A(Math.abs(fs[0].phi - 15) < 1e-9, 'first detector at phi = 15 deg');
// sheet: phi1 = 4.5452, phi2 = 25.4548  ->  half width atan(20.15/109.2)
const half = Math.atan(40.3 / 2 / 109.2) * 180 / Math.PI;
A(Math.abs(15 - half - 4.545164922) < 1e-6, 'phi1 matches sheet (' + (15 - half).toFixed(6) + ')');
const ang = GEO.faceAngles(fs[0], [0, 0, 0]);
const exp1 = Math.atan2(109.2, 127.25 + 37.5) * 180 / Math.PI;
const exp2 = Math.atan2(109.2, 127.25 - 37.5) * 180 / Math.PI;
A(Math.abs(ang.th1 - exp1) < 1e-6 && Math.abs(ang.th2 - exp2) < 1e-6,
  'theta_lab ' + ang.th1.toFixed(2) + ' - ' + ang.th2.toFixed(2) + ' deg');
// solid angle sanity: 12 X6 plates must be a few % of 4pi
const frac = ang.omega * 12 / (4 * Math.PI);
A(frac > 0.02 && frac < 0.35, 'ring solid angle ' + (frac * 100).toFixed(2) + ' % of 4pi');

// collimator: centred 2 mm sigma beam through R = 5 mm  ->  1 - exp(-R^2/2s^2)
const T5 = PH.collimate({ x: 0, y: 0, sx: 2, sy: 2 }, 5).T;
const exact = 1 - Math.exp(-25 / 8);
A(Math.abs(T5 - exact) < 0.01, 'transmission ' + T5.toFixed(4) + ' vs analytic ' + exact.toFixed(4));

// envelope: two collimators, cumulative transmission must fall
const env = PH.envelope({ x0: 0, y0: 0, sx: 3, sy: 3, divx: 0, divy: 0 },
  [{ id: 'a', enabled: true, z: -100, r: 6 }, { id: 'b', enabled: true, z: -50, r: 4 }], 0);
A(env.stages.length === 2 && env.stages[1].Tcum < env.stages[0].Tcum, 'cumulative transmission decreases');
A(env.stages[1].outSx < 3, 'sigma shrinks after clipping: ' + env.stages[1].outSx.toFixed(2));

// Bethe-Bloch: 5 MeV proton in silicon, NIST PSTAR ~ 60 MeV cm2/g
const s = PH.dEdx(1, 1.007, 5, MATERIALS.Si);
A(s > 45 && s < 80, 'dE/dx(5 MeV p, Si) = ' + s.toFixed(1) + ' MeV cm2/g (PSTAR 60.3)');
// alpha in CD2 must lose more than a proton at the same energy
A(PH.dEdx(2, 4.003, 5, MATERIALS.CD2) > PH.dEdx(1, 1.007, 5, MATERIALS.CD2), 'alpha loses more than proton');

// ---- flip: mirror the ring about its own front face -------------------------
const flipped = Object.assign({}, ring, { flip: true });
A(Math.abs(GEO.detCentreZ(flipped) - (180 + 52.75)) < 1e-9,
  'flipped detector z centre ' + GEO.detCentreZ(flipped).toFixed(2) + ' (expect 232.75)');
A(GEO.ringZSpan(flipped)[0] === 165 && GEO.ringZSpan(flipped)[1] === 180,
  'flipped ring body moves upstream: ' + GEO.ringZSpan(flipped).join(' .. '));
A(GEO.ringZSpan(ring)[0] === 180 && GEO.ringZSpan(ring)[1] === 195, 'unflipped body 180 .. 195');

// ---- phi coverage and geometric efficiency ----------------------------------
const cov = GEO.ringCoverage(ring, [0, 0, 0]);
const expPhi = 12 * 2 * Math.atan(40.3 / 2 / 109.2) * 180 / Math.PI / 360;
A(Math.abs(cov.phiFrac - expPhi) < 1e-9, 'phi coverage ' + (cov.phiFrac * 100).toFixed(1) + ' % (12 x 20.91 deg)');
A(Math.abs(cov.omega - 12 * ang.omega) < 1e-6, 'ring solid angle = 12 x single face');
A(cov.effShell > cov.eff4pi, 'shell-filling ' + (cov.effShell * 100).toFixed(1) +
  ' % exceeds 4pi fraction ' + (cov.eff4pi * 100).toFixed(2) + ' %');
A(cov.effShell <= 1, 'shell-filling cannot exceed 1');
// a full 4-quadrant QQQ5 disc must cover all of phi
const qt = RING_TYPES['Q'];
const qring = { div: 4, r: qt.r, off: qt.off, offMode: 'center', z: 210, z1: qt.z1, z2: qt.z2,
                rmin: 106, rmax: 122, dir: 2, det: 'QQQ5', phi0: 45, enabled: true };
A(Math.abs(GEO.ringCoverage(qring, [0, 0, 0]).phiFrac - 1) < 1e-9, 'QQQ5 disc covers 100 % of phi');

// ---- unique acceptance vs summed wafer solid angle --------------------------
const allF = GEO.faces(ring, 0);
const uni = GEO.uniqueAcceptance(allF, [0, 0, 0]);
A(Math.abs(uni - cov.omega) / cov.omega < 0.05,
  'one ring: unique ' + uni.toFixed(3) + ' sr ~= summed ' + cov.omega.toFixed(3) + ' sr');
// two identical rings stacked in radius see the same sky -> unique must not double
const outer = Object.assign({}, ring, { r: 140.5 });
const both = GEO.faces(ring, 0).concat(GEO.faces(outer, 0));
const uni2 = GEO.uniqueAcceptance(both, [0, 0, 0]);
const sum2 = cov.omega + GEO.ringCoverage(outer, [0, 0, 0]).omega;
A(uni2 < sum2, 'stacked layers: unique ' + uni2.toFixed(3) + ' sr < wafer sum ' + sum2.toFixed(3) + ' sr');
A(uni2 <= 4 * Math.PI, 'unique acceptance stays under 4pi');

// ---- QQQ5 wafer azimuth ------------------------------------------------------
// phi0 is the detector CENTRE for both facings. The frame's four spokes sit on
// the axes, so the wafers are centred on the diagonals and span 0-90, 90-180, …
const qf = GEO.faces(qring, 0);
A(qf.length === 4, '4 QQQ5 wafers');
A(Math.abs(qf[0].phi - 45) < 1e-9, 'first wafer centred at 45 deg');
A(Math.abs(qf[0].phiStart - 0) < 1e-9 && Math.abs(qf[0].phiSpan - 90) < 1e-9,
  'first wafer spans ' + qf[0].phiStart + ' .. ' + (qf[0].phiStart + qf[0].phiSpan));
A(qf.every((f, i) => Math.abs(f.phiStart - i * 90) < 1e-9), 'wafers tile 0/90/180/270');
// centre convention must agree with the barrel rings, which already did this
A(Math.abs(fs[0].phi - ring.phi0) < 1e-9, 'barrel phi0 is also the detector centre');

// ---- telescope pairing -------------------------------------------------------
const Etel  = { ...ring, id: 'E', det: 'X6', z: 180 };                      // r 109.2
const dEtel = { ...ring, id: 'dE', r: 91.7, det: 'BB10', z: 190, rmin: 87.7, rmax: 103.7 };
const wantA = GEO.edgeAngles(Etel, [0, 0, 0]);
const gap0 = GEO.mismatch(GEO.edgeAngles(dEtel, [0, 0, 0]), wantA);
const fit = GEO.matchZ(dEtel, Etel, [0, 0, 0]);
A(fit && fit.after < gap0, 'matchZ improves the pair: ' + gap0.toFixed(2) + ' -> ' + fit.after.toFixed(2) + ' deg');
A(Math.abs(fit.before - gap0) < 1e-9, 'matchZ reports the mismatch it started from');
// two rings at the SAME radius and height can be matched exactly
const twin = { ...Etel, id: 'twin', z: 260 };
const twinFit = GEO.matchZ(twin, Etel, [0, 0, 0]);
A(twinFit.after < 0.01 && Math.abs(twinFit.z - 180) < 0.2,
  'identical rings match exactly at z ' + twinFit.z + ' (residual ' + twinFit.after.toFixed(3) + ' deg)');

// ---- bare (frameless) rings --------------------------------------------------
// No frame: z IS the detector centre, and the ring claims no volume.
const framed = { ...ring, id: 'framed', z: 180 };
const bareR  = { ...ring, id: 'bare', mount: 'bare', z: GEO.detCentreZ(framed) };
A(Math.abs(GEO.detCentreZ(bareR) - 127.25) < 1e-9, 'bare ring z is the detector centre');
A(JSON.stringify(GEO.edgeAngles(bareR, [0, 0, 0]).map((v) => +v.toFixed(6)))
  === JSON.stringify(GEO.edgeAngles(framed, [0, 0, 0]).map((v) => +v.toFixed(6))),
  'bare and framed rings at the same detector centre see the same theta');
const [bz1, bz2] = GEO.ringZSpan(bareR);
A(Math.abs((bz2 - bz1) - 75) < 1e-9, 'bare ring reports the wafer extent (' + (bz2 - bz1).toFixed(1) + ' mm), not a frame');
// a bare ring may overlap anything, since there is nothing there to hit
A(GEO.collisions([framed, { ...bareR, z: 182 }]).size === 0, 'bare rings never collide');
A(GEO.collisions([framed, { ...framed, id: 'twin2', z: 182 }]).size === 2, 'framed rings still do');
