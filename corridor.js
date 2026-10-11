/*
 * HWECorridor — route-corridor forecast manager (blueprint §8: "forecasts for
 * the route corridor with several points and elevations, plus a buffer", and
 * §4 Expect: expectations at the wearer's exact position, not one grid point).
 *
 * Builds N points along the great-circle-ish path start->destination, fetches
 * real terrain elevation (Open-Meteo /v1/elevation) and an hourly forecast per
 * point, then answers expectedAt(hour, altitude, pos) with an inverse-distance
 * blend, each point's station pressure corrected to the wearer's altitude.
 *
 * Also exposes helpers used by the offline position estimator (Traveler):
 * pointAtProgress(km), elevAtProgress(km), lengthKm, nearestKm(pos).
 */
(function (root) {
  'use strict';

  function toRad(d) { return d * Math.PI / 180; }
  function havKm(aLat, aLon, bLat, bLon) {
    var R = 6371, dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  var HOURLY = 'surface_pressure,pressure_msl,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover';

  function Corridor() {
    this.points = [];      // {lat, lon, elev, store:ForecastStore, cumKm}
    this.lengthKm = 0;
    this.t0 = null; this.generatedAt = null; this.gridElevation = 0;
    this.hours = [];
  }

  // same interface the Engine expects from ForecastStore
  Corridor.prototype.expectedAt = function (hr, alt, pos) {
    var pts = this.points;
    if (!pts.length) return null;
    // weights: inverse-square distance from wearer (default: corridor middle)
    var ref = pos || pts[Math.floor(pts.length / 2)];
    var wSum = 0, out = null;
    var vals = [];
    for (var i = 0; i < pts.length; i++) {
      var d = havKm(ref.lat, ref.lon, pts[i].lat, pts[i].lon);
      var w = 1 / (d * d + 0.64);                 // 0.8 km softening radius
      var e = pts[i].store.expectedAt(hr, alt);   // already corrected to `alt`
      vals.push({ w: w, e: e });
      if (e) wSum += w;
    }
    if (!wSum) return null;
    var keys = ['pSurf', 'pMsl', 'temp', 'rh', 'wind', 'gust', 'precip', 'cloud'];
    out = {};
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k], acc = 0;
      for (i = 0; i < vals.length; i++) if (vals[i].e) acc += vals[i].e[key] * vals[i].w;
      out[key] = acc / wSum;
    }
    return out;
  };

  Corridor.prototype.nearestKm = function (pos) {
    var m = Infinity;
    for (var i = 0; i < this.points.length; i++) {
      var d = havKm(pos.lat, pos.lon, this.points[i].lat, this.points[i].lon);
      if (d < m) m = d;
    }
    return m;
  };

  // position at `km` from route start (linear between corridor points)
  Corridor.prototype.pointAtProgress = function (km) {
    var pts = this.points;
    if (!pts.length) return null;
    km = Math.max(0, Math.min(this.lengthKm, km));
    for (var i = 1; i < pts.length; i++) {
      if (km <= pts[i].cumKm || i === pts.length - 1) {
        var seg = pts[i].cumKm - pts[i - 1].cumKm || 1;
        var t = Math.max(0, Math.min(1, (km - pts[i - 1].cumKm) / seg));
        return {
          lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t,
          lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t,
          elev: pts[i - 1].elev + (pts[i].elev - pts[i - 1].elev) * t
        };
      }
    }
    return pts[0];
  };
  Corridor.prototype.elevAtProgress = function (km) { var p = this.pointAtProgress(km); return p ? p.elev : 0; };
  Corridor.prototype.progressOf = function (pos) {   // nearest km along route
    var best = 0, bd = Infinity;
    for (var i = 0; i <= 200; i++) {
      var km = i / 200 * this.lengthKm;
      var p = this.pointAtProgress(km);
      var d = havKm(pos.lat, pos.lon, p.lat, p.lon);
      if (d < bd) { bd = d; best = km; }
    }
    return best;
  };

  /**
   * Build the corridor from a control polyline (waypoints in travel order).
   * Fetches real terrain elevation + an hourly forecast per sampled point.
   * Returns a Promise<Corridor>. Throws with a readable message on network loss.
   */
  async function build(waypts, nPerSeg, sourceTag) {
    nPerSeg = nPerSeg || 2;
    var coords = [];
    for (var w = 0; w < waypts.length - 1; w++) {
      var A = waypts[w], B = waypts[w + 1];
      for (var i = 0; i < nPerSeg; i++) {
        var t = i / nPerSeg;
        coords.push({ lat: A.lat + (B.lat - A.lat) * t, lon: A.lon + (B.lon - A.lon) * t });
      }
    }
    coords.push(waypts[waypts.length - 1]);
    var lats = coords.map(function (c) { return c.lat.toFixed(4); }).join(',');
    var lons = coords.map(function (c) { return c.lon.toFixed(4); }).join(',');

    var demR = await (await fetch('https://api.open-meteo.com/v1/elevation?latitude=' + lats + '&longitude=' + lons)).json();
    if (!demR || !demR.elevation) throw new Error('elevation lookup failed');

    var fcR = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lats +
      '&longitude=' + lons + '&hourly=' + HOURLY + '&forecast_days=3&timezone=auto')).json();
    var fcArr = Array.isArray(fcR) ? fcR : [fcR];

    var cor = new Corridor();
    var cum = 0;
    for (i = 0; i < coords.length; i++) {
      if (i > 0) cum += havKm(coords[i - 1].lat, coords[i - 1].lon, coords[i].lat, coords[i].lon);
      var raw = fcArr[i];
      raw._source = sourceTag || 'open-meteo-corridor';
      cor.points.push({
        lat: coords[i].lat, lon: coords[i].lon,
        elev: demR.elevation[i],
        cumKm: cum,
        store: new root.HWE.ForecastStore(raw)
      });
    }
    cor.lengthKm = cum;
    cor.t0 = cor.points[0].store.t0;
    cor.generatedAt = cor.points[0].store.generatedAt;
    cor.gridElevation = cor.points[Math.floor(cor.points.length / 2)].elev;
    cor.hours = cor.points[0].store.hours;
    return cor;
  }

  root.HWECorridor = { Corridor: Corridor, build: build, havKm: havKm };
})(typeof self !== 'undefined' ? self : this);
