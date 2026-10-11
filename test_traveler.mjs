/* Headless accuracy test: corridor build (live API) + offline position
 * prediction quality. Run: node test_traveler.mjs */
global.self = global;
const { createRequire } = await import('node:module');
const req = createRequire(import.meta.url);
const HWE = req('./engine.js');
global.HWE = HWE;        // corridor.js resolves HWE off the shared root
req('./corridor.js');    // UMD attaches to `self` (=== global here)
req('./traveler.js');
const COR = global.HWECorridor;
const Traveler = global.Traveler;

// Real trail waypoints (verified via geocoding + Open-Meteo DEM): Namche ->
// Shomare ridge -> Monjo bridge -> climb -> Tengboche (the actual route)
const WAYPTS = [
  { lat: 27.8053, lon: 86.7106 },   // Namche Bazaar      3 463 m
  { lat: 27.8153, lon: 86.7209 },   // Shomare            3 855 m
  { lat: 27.8211, lon: 86.7441 },   // Monjo suspension    3 511 m
  { lat: 27.8289, lon: 86.7530 },   // Tengboche climb     3 592 m
  { lat: 27.8371, lon: 86.7641 }    // Tengboche           3 770 m
];
const cor = await COR.build(WAYPTS, 4);
console.log('corridor:', cor.lengthKm.toFixed(2), 'km | elevations:', cor.points.map(p => Math.round(p.elev)).join(' > '));

const tr = new Traveler(cor);
const HR = 3600e3, t0 = cor.t0 + 9 * HR;
let maxErrM = 0, worstUnc = 0, samples = [];
let anchor = null;   // differential barometer anchor {alt, p}, set at every fix
for (let t = 0; t <= 6 * HR; t += 30e3) {
  const s = t / HR, tt = t0 + t;
  const kmTrue = Math.min(cor.lengthKm, 2.6 * s);
  const tp = cor.pointAtProgress(kmTrue);
  const hr = (tt - cor.t0) / HR;
  const e = cor.expectedAt(hr, tp.elev, tp);
  const lost = s >= 0.5 && s < 4.5;   // GPS dies 30 min in, stays dead most of trek
  if (!lost) anchor = { alt: tp.elev, p: e.pSurf };
  // device-realistic barometric altitude: integrate pressure change since anchor
  const pNow = e.pSurf + (Math.random() - 0.5) * 0.12;   // 0.06 hPa noise ~0.6 m
  const altP = anchor ? anchor.alt + HWE.util.scaleHeight(e.temp) * Math.log(anchor.p / pNow) : tp.elev;
  let pos, unc = 0;
  if (!lost) {
    tr.fix({ lat: tp.lat, lon: tp.lon, elev: tp.elev }, tt, 'gps');
    pos = tp;
  } else {
    const est = tr.estimate(30e3 / HR, tt, altP);
    pos = cor.pointAtProgress(est.km);
    unc = est.uncM;
    const errM = COR.havKm(tp.lat, tp.lon, pos.lat, pos.lon) * 1000;
    maxErrM = Math.max(maxErrM, errM);
    worstUnc = Math.max(worstUnc, unc);
    if (errM > unc) console.log('  !! uncertainty under-claims: err', errM.toFixed(0), 'm > unc', unc, 'm at s=' + s.toFixed(1));
    if (t % 1800e3 === 0) samples.push('  s=' + s.toFixed(1) + 'h  err=' + errM.toFixed(0) + ' m  claimed ±' + unc + ' m  km ' + kmTrue.toFixed(2) + '->' + est.km.toFixed(2) + ' v=' + est.speedKmh.toFixed(2) + ' gAdj=' + (est.km - (samples._lastKm || kmTrue - 0.5 * 2.6)).toFixed(2));
    samples._lastKm = est.km;
  }
}
console.log('GPS-lost episode (2.5 h of trekking):');
samples.forEach(x => console.log(x));
console.log('max position error:', maxErrM.toFixed(0), 'm | worst claimed uncertainty: ±' + worstUnc.toFixed(0) + ' m');

// scenario(paceFn, lostFrom, lostUntil, pNoiseHpa): runs a GPS-lost episode and
// returns worst error + any uncertainty under-claims
function runScenario(label, paceFn, lostFrom, lostUntil, pNoise) {
  const tr2 = new Traveler(cor);
  const HR2 = 3600e3, t02 = cor.t0 + 9 * HR2;
  let anchor2 = null, maxE = 0, under = 0;
  let kmAcc = 0;
  for (let t = 0; t <= 6 * HR2; t += 30e3) {
    const s = t / HR2, tt = t02 + t, dt = 30e3 / HR2;
    kmAcc = Math.min(cor.lengthKm, kmAcc + paceFn(s) * dt);
    const tp = cor.pointAtProgress(kmAcc);
    const hr = (tt - cor.t0) / HR2;
    const e = cor.expectedAt(hr, tp.elev, tp);
    const lost = s >= lostFrom && s < lostUntil;
    if (!lost) anchor2 = { alt: tp.elev, p: e.pSurf };
    const pNow = e.pSurf + (Math.random() - 0.5) * pNoise;
    const altP = anchor2 ? anchor2.alt + HWE.util.scaleHeight(e.temp) * Math.log(anchor2.p / pNow) : tp.elev;
    let est;
    if (!lost) { tr2.fix({ lat: tp.lat, lon: tp.lon, elev: tp.elev }, tt, 'gps'); est = null; }
    else est = tr2.estimate(dt, tt, altP);
    if (est) {
      const pos = cor.pointAtProgress(est.km);
      const errM = COR.havKm(tp.lat, tp.lon, pos.lat, pos.lon) * 1000;
      maxE = Math.max(maxE, errM);
      if (errM > est.uncM) under++;
    }
  }
  console.log(label + ': max err ' + maxE.toFixed(0) + ' m | under-claims ' + under);
  return maxE;
}

runScenario('A steady 2.6 km/h, lost 0.5-4.5 h', () => 2.6, 0.5, 4.5, 0.12);
runScenario('B variable 1.8-3.6 km/h, lost 0.3-4 h', s => 2.7 + 0.9 * Math.sin(s * 1.7), 0.3, 4, 0.12);
runScenario('C steep slow 1.6 km/h, lost 0.2-3.5 h', () => 1.6, 0.2, 3.5, 0.2);
runScenario('D fast 3.6 km/h, lost 0.4-3 h', () => 3.6, 0.4, 3, 0.12);
const a = cor.expectedAt(12, 3463, WAYPTS[0]);
const b = cor.expectedAt(12, 3770, WAYPTS[4]);
console.log('start@3463m pSurf=' + a.pSurf.toFixed(1), '| dest@3770m pSurf=' + b.pSurf.toFixed(1), '(dest must be ~38 hPa lower)');
