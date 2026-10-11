/*
 * Traveler — offline position prediction (blueprint §4 Expect + §10 lead-and-
 * follow: the device must keep knowing roughly where the wearer is with no
 * GPS and no internet, using: last confirmed point, the cached route toward
 * the given destination, walking-speed dead reckoning with gradient-aware
 * pace, and barometric-altitude cross-checks against the route elevation
 * profile. Uncertainty grows honestly and is shown to the wearer.
 */
(function (root) {
  'use strict';

  function Traveler(corridor) {
    this.corridor = corridor;
    this.confirmed = null;   // {lat, lon, elev, t, src:'gps'|'manual'}
    this.est = {
      km: 0,                 // progress along corridor (km)
      uncM: 60,              // uncertainty radius (m)
      lostSince: null,       // sim-ms when GPS was last lost
      kmAtLost: 0,           // corridor progress when GPS was lost
      speedKmh: 2.5
    };
  }

  Traveler.prototype.setCorridor = function (c) {
    this.corridor = c;
    if (this.confirmed && c) this.est.km = c.progressOf(this.confirmed);
  };

  // called whenever a real fix (GPS or manual) is available
  Traveler.prototype.fix = function (pos, tMs, src) {
    this.confirmed = { lat: pos.lat, lon: pos.lon, elev: pos.elev, t: tMs, src: src };
    if (this.corridor) this.est.km = this.corridor.progressOf(pos);
    this.est.uncM = 60;
    this.est.lostSince = null;
    this.est.kmAtLost = this.est.km;
  };

  // Gradient of the route at current estimated progress (m per m).
  // DEM samples are noisy at trail scale, so we average the forward and
  // backward slopes over a wide ±0.6 km window and clamp to plausible
  // mountain-trail grades (±18%). A single tight-window finite difference
  // can read a 40 m contour jitter as a 16% grade and crush the pace model.
  Traveler.prototype._grade = function () {
    var c = this.corridor;
    if (!c) return 0;
    var d = 0.6; // km window
    var here = this.est.km;
    var eF = c.elevAtProgress(Math.min(c.lengthKm, here + d));
    var eB = c.elevAtProgress(Math.max(0, here - d));
    var span = Math.min(c.lengthKm, here + d) - Math.max(0, here - d);
    if (span < 0.2) return 0;
    var g = (eF - eB) / (span * 1000);
    return Math.max(-0.18, Math.min(0.18, g));
  };

  /**
   * Advance the estimate by dtHours of walking. altFromPressureM (optional)
   * is the barometric altitude computed against the corridor's expected MSL
   * pressure — used to nudge progress where the route profile has gradient.
   */
  Traveler.prototype.estimate = function (dtHours, tMs, altFromPressureM) {
    var c = this.corridor;
    if (!c) return null;
    if (this.est.lostSince === null) {
      this.est.lostSince = tMs;
      this.est.kmAtLost = this.est.km;
    }

    // Gradient-aware trekking pace (loaded, mountain trail). Flat ~3.3 km/h;
    // each 0.1 of uphill grade costs ~0.65 km/h; mild downhills help a little.
    // Clamped so DEM noise or a steep read can never zero out forward motion.
    var g = this._grade();
    var v = 3.0 - 6.5 * Math.max(0, g) + 1.2 * Math.max(0, -g);
    v = Math.max(1.4, Math.min(4.0, v));
    this.est.speedKmh = v;
    this.est.km = Math.min(c.lengthKm, this.est.km + v * dtHours);

    // Barometric cross-check: compare pressure-derived altitude against the
    // route elevation profile. Only trust it where the route actually climbs or
    // descends; a flat stretch can't be resolved by pressure alone. The nudge is
    // RATE-CAPPED (never faster than twice the walked distance this tick) and
    // dead-banded (< 20 m disagreement is sensor noise, not signal) — without
    // these guards a biased altitude reading can run the estimate away.
    var altitudeInformative = false;
    if (typeof altFromPressureM === 'number' && isFinite(altFromPressureM)) {
      var prof = c.elevAtProgress(this.est.km);
      var err = altFromPressureM - prof;             // m
      var perKm = g * 1000;                          // m elevation change per km
      if (Math.abs(perKm) > 25) {
        altitudeInformative = true;
        if (Math.abs(err) > 20) {
          var maxAdj = Math.max(0.015, v * dtHours * 2);   // km this tick, bounded
          // SIGN: on a climbing route (perKm>0), reading HIGHER than the
          // profile (err>0) means we are AHEAD → advance. err/perKm is the
          // physically correct direction; negating it is positive feedback.
          var adj = err / perKm * 0.25;                   // heavily damped
          // Monotonicity prior: a trekker on a known route to a cached
          // destination moves forward. A correction may throttle most of one
          // tick's walking but never reverse it — this is what stops the
          // altimeter from latching onto the wrong side of a pass.
          adj = Math.max(-v * dtHours * 0.6, Math.min(maxAdj, adj));
          this.est.km = Math.max(0, Math.min(c.lengthKm, this.est.km + adj));
        }
      } else {
        // flat + big altitude disagreement means the expectation is off, not us
        this.est.uncM += Math.min(12, Math.abs(err) * 0.5);
      }
    }

    // Honest uncertainty growth from three independent sources:
    //  1. dead-reckoning distance (trail is not a straight line, pace varies)
    //  2. elapsed time without a fix (waiting, rest, route-finding)
    //  3. terrain that gives the barometer no leverage (flat / non-informative)
    var minLost = (tMs - this.est.lostSince) / 60e3;
    var kmWalked = Math.abs(this.est.km - this.est.kmAtLost);
    // ~160 m of along-route spread per km walked: the true pace of a loaded
    // trekker is unknown to ±15-20% and the dead-reckon drift accumulates
    // with distance, which is what actually dominates the error budget
    var distTerm = 160 * kmWalked;
    // pace is unknown to ±~0.8 km/h → ~13 m/min of along-route spread; the
    // barometric cross-check can reclaim roughly half of that when the route
    // is climbing/descending (altitude pins progress there)
    var timeTerm = (altitudeInformative ? 7 : 15) * minLost;
    this.est.uncM = Math.min(1200, 60 + distTerm + timeTerm);

    var p = c.pointAtProgress(this.est.km);
    return { lat: p.lat, lon: p.lon, elev: p.elev, km: this.est.km, uncM: Math.round(this.est.uncM), speedKmh: v, lostMin: Math.round(minLost) };
  };

  root.Traveler = Traveler;
})(typeof self !== 'undefined' ? self : this);
