/*
 * HWE — Offline Hazard Early-Warning Engine (v0.3 prototype core)
 * Blueprint: "Offline Hazard Early-Warning Wearable" v0.1, sections 7-9.
 *
 * Dependency-free UMD module. Runs in browser (simulator/replay) and
 * will run unchanged inside the Android app (phase 2).
 *
 * The four-stage loop from the blueprint:
 *   Prepare  -> ForecastStore (caller supplies cached forecast JSON)
 *   Expect   -> expectedAt(t, altitude)   [interpolation + hypsometric correction]
 *   Measure  -> feed(tick)                [sensor samples pushed in]
 *   Compare  -> rule scoring + graded alert state machine
 *
 * Key design decisions (documented for auditability — blueprint 9.1 "transparent"):
 *   1. Observed station pressure is reduced to sea level using live GNSS altitude
 *      before ANY comparison. This removes elevation-driven pressure change
 *      (the #1 false-alarm source on a climbing wearer) in a single correction.
 *   2. Residuals are computed against the *cached forecast*, so the normal
 *      diurnal pressure tide does not look like an anomaly.
 *   3. Alerts require multi-signal confirmation, persistence, hysteresis and
 *      cooldown (blueprint 9.4).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HWE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var G = 9.80665;          // m/s^2
  var R_D = 287.052;        // J/(kg K) dry air
  var deg = 180 / Math.PI;

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // Scale height H = R*T/g  (~7.2 km at -10 C, ~8.5 km at +30 C)
  function scaleHeight(tempC) { return R_D * (tempC + 273.15) / G; }

  // Hypsometric: pressure ratio between two heights (isothermal approx)
  function pRatio(h2_m, h1_m, tempC) {
    return Math.exp(-(h2_m - h1_m) / scaleHeight(tempC));
  }

  /* ------------------------------------------------------------------ *
   * ForecastStore — "Prepare" + "Expect" (blueprint 7.2 layers 1-2)
   * ------------------------------------------------------------------ */
  function ForecastStore(raw) {
    // Accept Open-Meteo hourly JSON. Build dense numeric arrays.
    var h = raw.hourly;
    this.source = raw._source || 'open-meteo';
    this.generatedAt = raw._generatedAt || Date.now();
    this.lat = raw.latitude; this.lon = raw.longitude;
    this.gridElevation = raw.elevation || 0;
    this.t0 = Date.parse(h.time[0] + 'Z'); // treat api local times as the anchor
    // For a same-timezone demo the epoch offset is irrelevant; engine works on
    // relative hours from t0. We store times as fractional hours since t0.
    this.hours = [];
    this.pSurf = []; this.pMsl = []; this.temp = []; this.rh = [];
    this.wind = []; this.gust = []; this.precip = []; this.cloud = [];
    for (var i = 0; i < h.time.length; i++) {
      this.hours.push(i + (raw._hourOffsetHours || 0));
      this.pSurf.push(+h.surface_pressure[i]);
      this.pMsl.push(+h.pressure_msl[i]);
      this.temp.push(+h.temperature_2m[i]);
      this.rh.push(+h.relative_humidity_2m[i]);
      this.wind.push(+h.wind_speed_10m[i]);
      this.gust.push(+h.wind_gusts_10m[i]);
      this.precip.push(+h.precipitation[i]);
      this.cloud.push(+h.cloud_cover[i]);
    }
  }

  ForecastStore.prototype.ageHours = function (nowSimMs) {
    // age relative to generatedAt mapped onto sim time by caller convention:
    return (nowSimMs - this.generatedAt) / 3600e3;
  };

  function interp(arr, hoursArr, hr) {
    if (hr <= hoursArr[0]) return arr[0];
    var last = hoursArr.length - 1;
    if (hr >= hoursArr[last]) return null; // beyond cache -> unknown
    var lo = 0, hi = last;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (hoursArr[mid] <= hr) lo = mid; else hi = mid; }
    var w = (hr - hoursArr[lo]) / (hoursArr[hi] - hoursArr[lo]);
    return arr[lo] * (1 - w) + arr[hi] * w;
  }

  // Expected conditions at absolute time hr (hours since t0) for a wearer at
  // altitude `alt` m. Station pressure expectation is corrected from the grid
  // elevation to the wearer's actual altitude (blueprint 4 "Expect").
  ForecastStore.prototype.expectedAt = function (hr, alt, pos) {
    // `pos` accepted for interface parity with Corridor; single-point store ignores it
    var pSurfGrid = interp(this.pSurf, this.hours, hr);
    var t = interp(this.temp, this.hours, hr);
    if (pSurfGrid === null || t === null) return null;
    var dh = (alt || this.gridElevation) - this.gridElevation;
    return {
      pSurf: pSurfGrid * pRatio(alt || this.gridElevation, this.gridElevation, t),
      pMsl: interp(this.pMsl, this.hours, hr),
      temp: t,
      rh: interp(this.rh, this.hours, hr),
      wind: interp(this.wind, this.hours, hr),
      gust: interp(this.gust, this.hours, hr),
      precip: interp(this.precip, this.hours, hr),
      cloud: interp(this.cloud, this.hours, hr)
    };
  };

  /* ------------------------------------------------------------------ *
   * Feature buffers — running sensor-derived signals (blueprint 9.2)
   * ------------------------------------------------------------------ */
  function Ring(max) { this.a = []; this.max = max; }
  Ring.prototype.push = function (v) { this.a.push(v); if (this.a.length > this.max) this.a.shift(); };
  Ring.prototype.last = function () { return this.a[this.a.length - 1]; };
  Ring.prototype.span = function () { return this.a.length ? this.a[this.a.length - 1].t - this.a[0].t : 0; };

  // robust slope of y vs t (hours) over samples newer than withinH hours
  function slopePerHour(samples, withinH) {
    if (samples.length < 2) return 0;
    var cutoff = samples[samples.length - 1].t - withinH * 3600e3;
    var s = samples.filter(function (p) { return p.t >= cutoff; });
    if (s.length < 2) return 0;
    var n = s.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) {
      var x = (s[i].t - s[n - 1].t) / 3600e3, y = s[i].v;
      if (!isNum(y)) continue;
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    var d = n * sxx - sx * sx;
    return d === 0 ? 0 : (n * sxy - sx * sy) / d;
  }

  /* ------------------------------------------------------------------ *
   * Engine configuration (guide-tunable sensitivity — blueprint 9.4)
   * ------------------------------------------------------------------ */
  var PRESETS = {
    low:    { pRateWatch: 1.4, pRateWarn: 2.4, pRateDanger: 3.5, pResidWatch: 4, pResidWarn: 7, pResidDanger: 11, tResidWarn: 6, persistS: 600, confirmMin: 2 },
    normal: { pRateWatch: 1.0, pRateWarn: 1.8, pRateDanger: 3.0, pResidWatch: 3, pResidWarn: 6, pResidDanger: 9,  tResidWarn: 5, persistS: 420, confirmMin: 2 },
    high:   { pRateWatch: 0.7, pRateWarn: 1.3, pRateDanger: 2.2, pResidWatch: 2.2, pResidWarn: 4.5, pResidDanger: 7, tResidWarn: 4, persistS: 300, confirmMin: 2 }
  };

  var LEVELS = ['Info', 'Watch', 'Warning', 'Danger'];

  /* ------------------------------------------------------------------ *
   * Engine
   * ------------------------------------------------------------------ */
  function Engine(forecast, opts) {
    opts = opts || {};
    this.fc = forecast;
    this.sensitivity = opts.sensitivity || 'normal';
    this.cfg = PRESETS[this.sensitivity];
    this.onAlert = opts.onAlert || function () {};
    this.onLog = opts.onLog || function () {};

    this.simNow = null;                 // ms of newest sample
    this.pos = null;                    // latest {lat, lon} (auto, manual or estimated)
    this.altGps = forecast.gridElevation;
    this.tempAmb = null;                // best ambient temp estimate (C)
    this.obsP = new Ring(720);          // raw station pressure samples
    this.pMslObs = new Ring(720);       // elevation-corrected, reduced-to-MSL
    this.rhObs = new Ring(360);
    this.gustProxy = new Ring(360);     // vibration percentile proxy 0..100
    this.tempObs = new Ring(360);
    this.altSamples = new Ring(120);
    this.battery = isNum(opts.battery) ? opts.battery : 100;
    this.connectivity = true;

    this.state = { level: 0, hazard: null, since: null, lastAlertAt: null };
    this._fired = false;                // true only on the tick a new alert emitted
    this.minLevelAfterDowngrade = 0;    // hysteresis latch
    this.downgradeSince = null;
    this.cooldownMs = 20 * 60e3;        // same-level re-announce cool-down (20 min sim)
    this.explain = {};                  // last computed features for UI/audit
    this.lastAlert = null;
  }

  Engine.prototype.setSensitivity = function (s) {
    if (PRESETS[s]) { this.sensitivity = s; this.cfg = PRESETS[s]; }
  };

  // Median of last k pressures (noise rejection for MEMS barometer)
  Engine.prototype._smoothP = function (k) {
    var a = this.obsP.a;
    if (a.length === 0) return null;
    var vals = a.slice(-k).map(function (s) { return s.v; }).sort(function (x, y) { return x - y; });
    return vals[vals.length >> 1];
  };

  // Reduce observed station pressure to sea level using live GNSS altitude.
  // This is Rule #1 (review finding): all weather residuals are computed
  // AFTER this correction, so climbing cannot fake a pressure fall.
  Engine.prototype._toMsl = function (pStation, alt, tempC) {
    return pStation / pRatio(alt, 0, tempC);
  };

  Engine.prototype.feed = function (tick) {
    // tick: {t: ms, pressure: hPa, altitude: m, temp: C|null, rh: %|null,
    //        gust: 0-100|null, battery: %|null, connectivity: bool|null}
    if (!isNum(tick.t) || !isNum(tick.pressure) || !isNum(tick.altitude)) return null;
    this._fired = false;
    this.simNow = tick.t;
    if (isNum(tick.lat) && isNum(tick.lon)) this.pos = { lat: tick.lat, lon: tick.lon, t: tick.t };
    if (isNum(tick.battery)) this.battery = tick.battery;
    if (tick.connectivity !== undefined && tick.connectivity !== null) this.connectivity = !!tick.connectivity;

    this.altGps = tick.altitude;
    this.obsP.push({ t: tick.t, v: tick.pressure });
    this.altSamples.push({ t: tick.t, v: tick.altitude });
    if (isNum(tick.temp)) this.tempObs.push({ t: tick.t, v: tick.temp });
    if (isNum(tick.rh)) this.rhObs.push({ t: tick.t, v: tick.rh });
    if (isNum(tick.gust)) this.gustProxy.push({ t: tick.t, v: tick.gust });

    // Ambient temp: prefer real ambient; else crude stability estimate from the
    // most recent non-body-affected reading (phase-1 honesty: low confidence).
    if (isNum(tick.temp)) this.tempAmb = tick.temp;

    var pS = this._smoothP(5);
    var tempForScale = this.tempAmb !== null ? this.tempAmb : (this.fc.expectedAt(this._hr(), this.altGps, this.pos) || { temp: 0 }).temp;
    var pMsl = this._toMsl(pS, this.altGps, tempForScale);
    if (isNum(pMsl)) this.pMslObs.push({ t: tick.t, v: pMsl });

    var warm = this.pMslObs.a.length >= 12;
    if (!warm) return null;

    // --- Features (blueprint 9.2) ---
    var hr = this._hr();
    var exp = this.fc.expectedAt(hr, this.altGps, this.pos);
    var exp1hAgo = this.fc.expectedAt(hr - 1, this.altGps, this.pos);
    if (!exp) return this._staleForecast();
    // Self-consistent reduction: reduce the FORECAST station pressure to sea
    // level with the SAME hypsometric formula applied to observations, so the
    // provider's internal MSL convention cancels out and only weather remains.
    var mslFactor = pRatio(0, this.altGps, tempForScale);   // = exp(alt/H)
    var expMslC = exp.pSurf * mslFactor;
    var residP = pMsl - expMslC;                             // hPa, offset-free
    // Observed weather-driven pressure tendency: slope of MSL-reduced obs,
    // minus forecast tendency at the same instant => deviation of tendency.
    var obsPRate = slopePerHour(this.pMslObs.a, 2);               // hPa/h (already elevation-free)
    var fcPRate = exp.pMsl - exp1hAgo.pMsl;                        // hPa/h expected
    var dRate = obsPRate - fcPRate;                                // hPa/h anomaly in tendency
    var obsPRate3h = slopePerHour(this.pMslObs.a, 5);

    var tResid = this.tempObs.a.length && isNum(exp.temp) ? this.tempObs.last().v - exp.temp : 0;
    var tRate = slopePerHour(this.tempObs.a, 2);
    var rhLast = this.rhObs.last();
    var rhResid = rhLast && isNum(exp.rh) ? rhLast.v - exp.rh : 0;
    var gustLast = this.gustProxy.last();
    var gustNow = gustLast ? gustLast.v : 0;
    var altRate = slopePerHour(this.altSamples.a, 0.5) ;           // m/h vertical
    // how much of raw pressure fall is explained by climbing?
    var rawRate = slopePerHour(this.obsP.a, 2);
    var climbExplained = Math.abs(rawRate) > 1e-9
      ? clamp(Math.abs(-pS * (altRate / scaleHeight(tempForScale)) / rawRate), 0, 1.5) : 0;

    this.explain = {
      hrSinceAnchor: hr, expected: exp, expMsl: expMslC, pMslObs: pMsl, residP: residP,
      obsPRate: obsPRate, fcPRate: fcPRate, dRate: dRate, obsPRate3h: obsPRate3h,
      tResid: tResid, tRate: tRate, rhResid: rhResid, gustNow: gustNow,
      altRate: altRate, climbExplainedPct: Math.round(clamp(climbExplained, 0, 1) * 100),
      forecastAgeH: Math.max(0, (tick.t - this.generatedAnchorSimMs()) / 3600e3)
    };

    var scored = this._score();
    this._updateState(scored, tick.t);
    return this._fired ? this.lastAlert : null;
  };

  Engine.prototype._hr = function () {
    return (this.simNow - this.fc.t0) / 3600e3;
  };
  Engine.prototype.generatedAnchorSimMs = function () {
    // In sim/replay the caller keeps generatedAt aligned to sim clock via fc.
    return this.fc.generatedAt;
  };

  Engine.prototype._staleForecast = function () {
    if (!this._staleWarned) {
      this._staleWarned = true;
      var a = this._mkAlert(0, 'Info', 'forecast_expired',
        'Cached forecast no longer covers this time. ' + (this.connectivity ? 'Refresh when online.' : 'Rule engine degraded; trend-only watch active.'),
        1.0, null, 'Connect whenever possible to refresh weather data.');
      this._emit(a);
    }
    return this._fired ? this.lastAlert : null;
  };

  /* ---------------- Rule scoring (transparent, blueprint 9.1) ---------
   * Each hazard family accumulates points from independent signal groups.
   * A level requires total points AND at least cfg.confirmMin distinct
   * signal families (multi-signal rule, 9.4).
   * ------------------------------------------------------------------- */
  Engine.prototype._score = function () {
    var c = this.cfg, e = this.explain;
    var fall = -e.dRate;   // positive => pressure falling faster than forecast

    var fam = {}; var pts = 0;
    // Family A: pressure-tendency deviation (the backbone signal)
    var ratePts = 0;
    if (fall >= c.pRateWatch) ratePts = 1;
    if (fall >= c.pRateWarn) ratePts = 2;
    if (fall >= c.pRateDanger) ratePts = 3;
    if (ratePts > 0) { fam.pressureTendency = true; pts += ratePts * 2; }

    // Family B: absolute residual vs expectation (catches slow mismatch)
    var resPts = 0;
    if (e.residP <= -c.pResidWatch) resPts = 1;
    if (e.residP <= -c.pResidWarn) resPts = 2;
    if (e.residP <= -c.pResidDanger) resPts = 3;
    if (resPts > 0) { fam.pressureResidual = true; pts += resPts * 2; }

    // Family C: temperature behaviour (extreme deviation counts stronger)
    if (e.tResid <= -c.tResidWarn || e.tRate <= -2.5) {
      fam.temperature = true; pts += 2;
      if (e.tResid <= -1.5 * c.tResidWarn || e.tRate <= -4) pts += 3;
    }

    // Family D: humidity surge
    if (e.rhResid >= 15) { fam.humidity = true; pts += 2; }

    // Family E: wind / gust vibration proxy
    if (e.gustNow >= 60) { fam.wind = true; pts += 2; }
    else if (e.gustNow >= 40) { fam.wind = true; pts += 1; }

    // Family F: precipitation onset not in forecast
    if (e.rhResid > 25 && e.expected.precip < 0.2 && fall > c.pRateWatch) { fam.precip = true; pts += 2; }

    var nFam = Object.keys(fam).length;

    // Classify hazard family with the dominant pattern
    var hazard = null;
    if (nFam === 0) return { pts: 0, level: 0, hazard: null, fam: fam };

    var stormFront = (fam.pressureTendency || fam.pressureResidual) &&
                     (fam.temperature || fam.wind || fam.humidity || fam.precip);
    var thunderstorm = fam.pressureTendency && fam.humidity && (fam.wind || fam.precip) && fall >= c.pRateWarn;
    var coldSnap = fam.temperature && !fam.humidity && e.tResid <= -c.tResidWarn;
    // recovery: residual deep but tendency no longer anomalous => the event
    // already arrived and conditions are relaxing back toward expectation
    var recovering = e.residP <= -c.pResidWarn && fall < c.pRateWatch;

    if (thunderstorm) hazard = 'thunderstorm';
    else if (recovering) hazard = 'recovery';
    else if (stormFront) hazard = 'fast_front';
    else if (coldSnap) hazard = 'cold_snap';
    else hazard = 'drift';

    // Level from points, gated by multi-signal requirement + persistence
    // Exception: an extreme single-family deviation may reach Watch alone.
    var level = 0;
    var strongSingle = ratePts === 3 || resPts === 3 ||
      (fam.temperature && pts >= 5);
    if (pts >= 2 && nFam >= 1) level = 1;                       // Info
    if (pts >= 5 && (nFam >= c.confirmMin || strongSingle)) level = 2; // Watch
    if (pts >= 9 && nFam >= c.confirmMin) level = 3;            // Warning
    if (pts >= 13 && nFam >= Math.max(3, c.confirmMin) &&
        (fall >= c.pRateDanger || e.residP <= -c.pResidDanger)) level = 4; // Danger

    return { pts: pts, level: level, hazard: hazard, fam: fam };
  };

  /* ---------------- State machine: persistence, hysteresis, cooldown -- */
  Engine.prototype._updateState = function (scored, t) {
    var c = this.cfg, st = this.state;

    if (scored.level === 0) {
      if (st.level > 0) {
        // downgrade requires 2x persistence window of quiet conditions
        if (this.downgradeSince === null) this.downgradeSince = t;
        if (t - this.downgradeSince >= 2 * c.persistS * 1000) {
          this._transition(0, null, t, 'Conditions back in line with the cached forecast.');
          this.downgradeSince = null;
        }
      }
      this._pump = null;
      return;
    }
    this.downgradeSince = null;

    if (scored.level > st.level) {
      // upgrade requires sustained condition for persistS seconds
      if (!this._pump || this._pump.target !== scored.level) {
        this._pump = { target: scored.level, since: t };
      } else if (t - this._pump.since >= c.persistS * 1000) {
        this._pump = null;
        this._transition(scored.level, scored.hazard, t);
      }
    } else if (scored.level < st.level) {
      // asymmetric hysteresis: step down at most one level, and only after a
      // longer quiet window from Danger (prevents Danger/Warning flapping)
      var target = Math.max(scored.level, st.level - 1);
      var need = (st.level >= 4 ? 4 : 2) * c.persistS * 1000;
      if (!this._pump || this._pump.target !== target) this._pump = { target: target, since: t };
      else if (t - this._pump.since >= need) {
        this._pump = null;
        this._transition(target, scored.hazard || st.hazard, t);
      }
    }
  };

  var MSG = {
    Info: {
      drift: 'Weather is changing a little faster than expected.',
      fast_front: 'Small signs of change vs the stored forecast. Nothing to act on yet.',
      thunderstorm: 'Slight instability vs forecast. Keep an eye on the sky.',
      cold_snap: 'A bit colder than the cached forecast said.',
      recovery: 'Conditions still differ from the forecast, but are settling.'
    },
    Watch: {
      fast_front: 'Storm signs building. Plan your shelter options.',
      thunderstorm: 'Thunderstorm signs building. Identify low ground and shelter now.',
      cold_snap: 'Cold snap developing beyond forecast. Add layers soon.',
      recovery: 'Weather has passed; cached forecast is now behind reality. Refresh when online.',
      drift: 'Multiple small deviations from forecast. Conditions may be turning.'
    },
    Warning: {
      fast_front: 'Rapid weather change likely in about {eta}. Move to shelter or lower ground.',
      thunderstorm: 'Thunderstorm likely within {eta}. Get off ridges and exposed ridgelines now.',
      cold_snap: 'Dangerous cold building within {eta}. Belay early; wind-chill risk rising.',
      recovery: 'Conditions remain well off forecast after the change. Stay cautious; refresh the forecast when online.',
      drift: 'Weather diverging strongly from forecast within {eta}. Reconsider today’s plan.'
    },
    Danger: {
      fast_front: 'Front arriving imminently. Take shelter NOW and secure gear.',
      thunderstorm: 'Thunderstorm imminent. Crouched position, off high ground, now.',
      cold_snap: 'Severe cold event in progress. Stop, insulate, huddle.',
      recovery: 'Conditions remain far from forecast. Treat as settled weather hazard, not an approaching front.',
      drift: 'Severe deviation from forecast in progress. Abort objective.'
    }
  };
  var ACTION = {
    Info: 'No action needed. Note the time in case it develops.',
    Watch: 'Choose shelter/lower-ground options before you need them.',
    Warning: 'Start moving to shelter or descent now — do not wait for Danger.',
    Danger: 'Take shelter immediately. Crouched if caught on exposed ground.'
  };

  Engine.prototype._etaMinutes = function () {
    // naive linear extrapolation of the anomalous tendency toward danger band
    var e = this.explain, c = this.cfg;
    var fall = -e.dRate;
    if (fall <= 0.1) return 0;                       // 0 => imminent / n.a.
    var needed = (c.pResidDanger - Math.abs(e.residP));
    if (needed <= 0) return 0;                       // already past the band
    var m = needed / fall * 60;
    return clamp(Math.round(m / 5) * 5, 10, 180);
  };

  Engine.prototype._mkAlert = function (levelIdx, hazard, famKey, msgOverride, confidence, etaMin, action) {
    var level = LEVELS[Math.max(0, levelIdx - 1)] || 'Info';
    var tmpl = msgOverride || (MSG[level] && MSG[level][hazard] || MSG[level].drift || 'Deviation detected.');
    var msg = tmpl.replace('{eta}', etaMin ? etaMin + ' minutes' : 'moments');
    return {
      level: level, levelIdx: levelIdx, hazard: hazard,
      message: msg,
      etaMinutes: etaMin, confidence: confidence,
      action: action || ACTION[level],
      t: this.simNow
    };
  };

  Engine.prototype._transition = function (level, hazard, t, quietMsg) {
    var st = this.state;
    if (level === 0) {
      if (st.level > 0) {
        st.level = 0; st.hazard = null; st.since = null;
        this._emit(this._mkAlert(1, hazard || 'drift', 'clear',
          quietMsg || 'Alert cleared. Live conditions match the cached forecast again.', 0.9, null, 'Resume normal travel.'));
      }
      return;
    }
    var fam = this.explain;
    var conf = clamp(
      0.45 + 0.15 * Object.keys(this._score().fam).length +
      (fam.forecastAgeH > 12 ? -0.1 : fam.forecastAgeH < 3 ? 0.1 : 0),
      0.3, 0.95);
    var eta = this._etaMinutes();
    var a = this._mkAlert(level, hazard, null, null, Math.round(conf * 100) / 100, eta);
    var sameLevel = st.level === level;
    if (sameLevel && st.lastAlertAt && t - st.lastAlertAt < this.cooldownMs) return; // cool-down
    st.level = level; st.hazard = hazard; st.since = st.since || t; st.lastAlertAt = t;
    this._emit(a);
  };

  Engine.prototype._emit = function (alert) {
    this.lastAlert = alert;
    this._fired = true;
    this.onAlert(alert);
    this.onLog(alert);
  };

  return {
    ForecastStore: ForecastStore,
    Engine: Engine,
    LEVELS: LEVELS,
    PRESETS: PRESETS,
    util: { scaleHeight: scaleHeight, pRatio: pRatio, slopePerHour: slopePerHour }
  };
});
