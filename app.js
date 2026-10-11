/*
 * HWE v0.3 prototype — scenario simulator, replay mode, dashboard UI.
 * Vanilla JS, no dependencies. Pairs with engine.js.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var HOUR = 3600e3;

  // ---------------------------------------------------------------- state
  var S = {
    fc: null, engine: null,
    mode: 'sim',            // 'sim' | 'replay'
    scenario: 'front',
    timeScale: 600,         // simulated seconds per real second
    running: true,
    simT: 0,                // ms
    lastReal: 0,
    tickMs: 30e3,           // sensor cadence (simulated) — barometer 5 s on device, coarser here for replay perf
    series: { t: [], expM: [], obsM: [], resid: [], expT: [], obsT: [], expRH: [], obsRH: [], gust: [], alt: [], pts: [] },
    winH: 6,                // display window hours
    events: [],
    connectivity: true,
    battery: 92,
    replay: null,           // {hours:[{t,pSurf,temp,rh,gust,...}]}
    corridor: null,         // HWECorridor when a route is built
    traveler: null,         // Traveler (offline position prediction)
    gpsLost: false,
    pickMode: null,         // null | 'start' | 'dest'
    start: null, dest: null, waypoints: null,
    altAnchor: null,        // {alt, p} differential-barometer anchor set at each fix
    lastTickPos: null, lastPosSrc: null, lastEst: null, lastEstPos: null
  };

  // ---------------------------------------------------------------- map (Leaflet; OSM tiles, key-free — swap to Google tiles with a key later)
  var M = { ok: false };
  function initMap() {
    if (typeof L === 'undefined') return;
    // Leaflet layers have no show()/hide() — shim them over addLayer/removeLayer,
    // remembering the map each layer was originally added to.
    if (!L.Layer.prototype.show) {
      L.Layer.prototype.show = function () { if (this._hwMap) this._hwMap.addLayer(this); return this; };
      L.Layer.prototype.hide = function () { if (this._map) this._hwMap = this._map; if (this._hwMap) this._hwMap.removeLayer(this); return this; };
    }
    M.map = L.map('map').setView([27.8206, 86.7373], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 17, attribution: '© OpenStreetMap' }).addTo(M.map);
    M.route = L.polyline([], { color: '#38bdf8', weight: 3, dashArray: '5 7' }).addTo(M.map);
    M.cps = L.layerGroup().addTo(M.map);
    M.startM = L.circleMarker([0, 0], { radius: 6, color: '#22c55e', fillOpacity: 0.9 }).addTo(M.map).hide();
    M.destM = L.circleMarker([0, 0], { radius: 6, color: '#ef4444', fillOpacity: 0.9 }).addTo(M.map).hide();
    M.userM = L.circleMarker([0, 0], { radius: 5, color: '#7dd3fc', fillOpacity: 0.9 }).addTo(M.map).hide();
    M.unc = L.circle([0, 0], { radius: 60, color: '#8b5cf6', weight: 1, fillColor: '#8b5cf6', fillOpacity: 0.1 }).addTo(M.map).hide();
    M.trav = L.circleMarker([0, 0], { radius: 7, color: '#fbbf24', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.95 }).addTo(M.map).hide();
    M.map.on('click', function (ev) {
      if (!S.pickMode) return;
      var p = { lat: ev.latlng.lat, lon: ev.latlng.lng };
      if (S.pickMode === 'start') { S.start = p; M.startM.setLatLng([p.lat, p.lon]).show(); pushEvent('Start set manually: ' + p.lat.toFixed(4) + ', ' + p.lon.toFixed(4), 'info'); }
      else { S.dest = p; M.destM.setLatLng([p.lat, p.lon]).show(); pushEvent('Destination set: ' + p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) + ' — build the corridor when ready.', 'info'); }
      S.pickMode = null; pickBtns();
    });
    M.ok = true;
  }
  function pickBtns() {
    $('pickStart').style.borderColor = S.pickMode === 'start' ? '#22c55e' : '';
    $('pickDest').style.borderColor = S.pickMode === 'dest' ? '#ef4444' : '';
  }
  function drawCorridor(cor) {
    if (!M.ok) return;
    M.route.setLatLngs(cor.points.map(function (p) { return [p.lat, p.lon]; }));
    M.cps.clearLayers();
    cor.points.forEach(function (p) {
      L.circleMarker([p.lat, p.lon], { radius: 3, color: '#38bdf8', fillOpacity: 0.7 })
        .bindTooltip(Math.round(p.elev) + ' m').addTo(M.cps);
    });
    M.map.fitBounds(M.route.getBounds().pad(0.25));
  }
  function updateMap() {
    if (!M.ok || !S.lastTickPos) return;
    M.trav.setLatLng([S.lastTickPos.lat, S.lastTickPos.lon]).show();
    if (S.lastPosSrc === 'est' && S.lastEst) {
      M.unc.setLatLng([S.lastTickPos.lat, S.lastTickPos.lon]).setRadius(S.lastEst.uncM).show();
      M.trav.setStyle({ color: '#8b5cf6', fillColor: '#8b5cf6' });
    } else {
      M.unc.hide();
      M.trav.setStyle({ color: '#fbbf24', fillColor: '#fbbf24' });
    }
  }

  // ---------------------------------------------------------------- corridor + location actions
  async function buildCorridor() {
    if (!S.start || !S.dest) { pushEvent('Set a start and a destination first (map buttons or demo route).', 'info'); return; }
    // Waypoint polyline (real trails bend around ridges — a straight start→dest
    // line cuts over 4 000 m peaks the trekker never walks near).
    var wpts = (S.waypoints && S.waypoints.length >= 2) ? S.waypoints : [S.start, S.dest];
    pushEvent('Building route corridor: terrain elevations + forecasts for ' + (wpts.length * 5 + 1) + ' sampled points…', 'info');
    try {
      var cor = await HWECorridor.build(wpts, 5, 'open-meteo-corridor');
      S.corridor = cor;
      if (!S.traveler) S.traveler = new Traveler(cor); else S.traveler.setCorridor(cor);
      if (S.mode === 'sim') { S.fc = cor; if (S.engine) S.engine.fc = cor; }
      S.lastEstPos = null; S.lastEst = null; S.altAnchor = null;
      drawCorridor(cor);
      var e0 = cor.points[0].elev, e1 = cor.points[cor.points.length - 1].elev;
      pushEvent('Corridor ready: ' + cor.lengthKm.toFixed(1) + ' km, ' + Math.round(e0) + '→' + Math.round(e1) + ' m, ' + cor.points.length + ' cached forecasts. Expectations are now position-aware.', 'info');
    } catch (err) {
      pushEvent('Corridor build failed (' + err.message + '). Staying on the single-point cache.', 'info');
    }
  }

  async function refreshForecastFor(lat, lon, label) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&hourly=surface_pressure,pressure_msl,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover&forecast_days=3&timezone=auto';
    try {
      var raw = await (await fetch(url)).json();
      raw._source = 'open-meteo-live@' + label;
      var store = buildStore(raw, null);
      S.fc = store;
      if (S.engine && !S.corridor) S.engine.fc = store;
      pushEvent('Forecast refreshed for ' + label + ' (' + lat.toFixed(3) + ', ' + lon.toFixed(3) + '), grid elev ' + Math.round(store.gridElevation) + ' m.', 'info');
    } catch (e) { pushEvent('Could not refresh forecast (offline?). Keeping cached copy.', 'info'); }
  }

  function setManualPos(lat, lon, label) {
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { pushEvent('Invalid coordinates.', 'info'); return; }
    var p = { lat: lat, lon: lon };
    if (M.ok) M.userM.setLatLng([lat, lon]).show();
    if (S.corridor) {
      var elev = S.corridor.pointAtProgress(S.corridor.progressOf(p)).elev;
      if (S.traveler) S.traveler.fix({ lat: lat, lon: lon, elev: elev }, S.simT, 'manual');
      // re-anchor the differential barometer at the manual point too
      var hrNow = (S.simT - S.fc.t0) / HOUR;
      var eM = S.corridor.expectedAt(hrNow, elev, p);
      if (eM) S.altAnchor = { alt: elev, p: eM.pSurf };
      pushEvent(label + ' position re-anchored onto the route corridor.', 'info');
    } else {
      refreshForecastFor(lat, lon, label);
    }
  }

  // ---------------------------------------------------------------- forecast loading (Prepare)
  function buildStore(raw, generatedAtSimMs) {
    raw._generatedAt = generatedAtSimMs || Date.parse(raw.hourly.time[0] + 'Z');
    return new HWE.ForecastStore(raw);
  }

  async function loadCachedForecast() {
    // Prefer the on-disk snapshot so the demo works offline; fall back to live API.
    try {
      var r = await fetch('data/forecast_namche.json');
      if (r.ok) return await r.json();
    } catch (e) { /* file:// fetch of local json may fail in some Chrome flags */ }
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=27.8053&longitude=86.7106' +
      '&hourly=surface_pressure,pressure_msl,temperature_2m,relative_humidity_2m,' +
      'wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover&forecast_days=4&timezone=Asia%2FKathmandu';
    var r2 = await fetch(url);
    var j = await r2.json();
    j._source = 'open-meteo-live';
    return j;
  }

  async function loadReplayData() {
    // Historical replay (blueprint s13 step 1): model values as forecast proxy,
    // reanalysis observations as "measured weather".
    var lat = 27.8053, lon = 86.7106;
    var end = new Date(); var start = new Date(end - 9 * 24 * HOUR);
    var f = function (d) { return d.toISOString().slice(0, 10); };
    var fUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&hourly=surface_pressure,pressure_msl,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover' +
      '&start_date=' + f(start) + '&end_date=' + f(end) + '&timezone=Asia%2FKathmandu';
    var aUrl = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
      '&start_date=' + f(start) + '&end_date=' + f(new Date(end - 30 * HOUR)) +
      '&hourly=surface_pressure,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m' +
      '&timezone=Asia%2FKathmandu&models=era5_land';
    var fr = await (await fetch(fUrl)).json();
    var ar = null;
    try { ar = await (await fetch(aUrl)).json(); } catch (e) { ar = null; }
    return { fcRaw: fr, obsRaw: ar };
  }

  // ---------------------------------------------------------------- scenario model (Measure)
  // wearer altitude profile near Namche (m) as function of sim-hours since start
  function altProfile(scen, s) {
    var base = 3700 + 60 * Math.sin(s / 3.1);           // trail undulation
    if (scen === 'climb') {
      if (s < 1) return base;
      if (s < 2) return base + 350 * (s - 1);            // gain 350 m/h
      if (s < 3) return base + 350;
      return base + 350 - 350 * clamp01(s - 3, 1);       // descend next hour
    }
    return base;
  }
  function clamp01(x, span) { return Math.max(0, Math.min(1, x / span)); }
  function ramp(x, a, b) { return clamp01(x - a, b - a); }

  // anomaly generator per scenario: returns {dp,dt,rh,gust} vs "truth = forecast"
  function anomaly(scen, s) {
    var o = { dp: 0, dt: 0, rh: 0, gust: 8 + 10 * Math.max(0, Math.sin(s / 4)), precipBump: 0 };
    if (scen === 'quiet') { o.gust = 6; return o; }
    if (scen === 'front') {
      // front onset at s=2, passes ~s=6, conditions recover to forecast by ~s=10
      var rec = s > 6 ? Math.max(0, 1 - (s - 6) / 4) : 1;
      o.dp = -integrate(frontFallRate, s) * rec;
      o.dt = -7 * ramp(s, 2.2, 5) * rec; o.rh = 22 * ramp(s, 2.4, 5) * rec;
      o.gust = 8 + 55 * ramp(s, 2.5, 5) * rec;
      return o;
    }
    if (scen === 'thunder') {
      // storm cell builds at 1.5h, passes through by ~4h, relaxes by ~7h
      var on = 1.5;
      var rec = s > 4 ? Math.max(0, 1 - (s - 4) / 3) : 1;
      if (s >= on) { o.dp = -2.6 * (s - on) * (s < on + 1.5 ? 1 : 0.6) * rec; }
      o.dt = -5 * ramp(s, on, on + 1) * rec; o.rh = 32 * ramp(s, on, on + 0.8) * rec;
      o.gust = 8 + 72 * ramp(s, on + 0.3, on + 1.2) * rec; o.precipBump = ramp(s, on + 0.6, on + 1.4) * rec;
      return o;
    }
    if (scen === 'cold') {
      o.dp = -0.5 * ramp(s, 1.5, 4); o.dt = -9 * ramp(s, 1, 4); o.rh = -12 * ramp(s, 1, 3); o.gust = 8 + 30 * ramp(s, 1, 4);
      return o;
    }
    if (scen === 'whiteout') {
      o.dp = -1.0 * ramp(s, 1, 3); o.dt = -6 * ramp(s, 1, 3); o.rh = 30 * ramp(s, 1, 3); o.gust = 8 + 60 * ramp(s, 1.2, 3);
      return o;
    }
    return o;
  }
  // crude integral of a rate function: sample every 0.05h
  function integrate(rateFn, s) {
    if (typeof rateFn === 'number') return rateFn * Math.max(0, s);
    var acc = 0, step = 0.05;
    for (var x = 0; x < s; x += step) acc += rateFn(x) * step;
    return acc;
  }
  // front fall-rate as fn of absolute s: onset 2h, peak ~2.2 hPa/h, passes ~6h
  function frontFallRate(x) {
    if (x < 2) return 0;
    if (x < 6) return 0.5 + 1.7 * clamp01(x - 2, 2);
    return Math.max(0, 2.2 - (x - 6) * 0.8);
  }

  function sampleSensor(s) {
    // s = sim hours since start. Returns engine tick.
    var t = S.simStart + s * HOUR;
    var hr = (t - S.fc.t0) / HOUR;
    var a = anomaly(S.scenario, s);
    var alt = altProfile(S.scenario, s);
    var pos = null;

    if (S.corridor && S.traveler) {
      // true wearer motion: trek the route at trail pace
      var kmTrue = Math.min(S.corridor.lengthKm, 2.6 * s);
      var tp = S.corridor.pointAtProgress(kmTrue);
      alt = tp.elev + 8 * Math.sin(s / 3.1);
      if (!S.gpsLost) {
        S.traveler.fix({ lat: tp.lat, lon: tp.lon, elev: alt }, t, 'gps');
        pos = { lat: tp.lat, lon: tp.lon };
        // anchor the differential barometer: altitude + station pressure the
        // device actually reads at this confirmed point
        var eA = S.corridor.expectedAt(hr, alt, tp);
        if (eA) S.altAnchor = { alt: alt, p: eA.pSurf + a.dp };
        S.lastPosSrc = 'gps'; S.lastEst = null;
      } else {
        // no GPS: dead-reckon along the cached corridor; altitude comes from the
        // DIFFERENTIAL barometer — pressure change since the last anchored fix.
        // (Never mixes the provider's pressure_msl with our own hypsometric
        // reduction: same self-consistency invariant the engine relies on.)
        var eRef = S.corridor.expectedAt(hr, alt, S.lastEstPos || { lat: tp.lat, lon: tp.lon });
        var altP = null;
        if (eRef) {
          if (S.altAnchor) {
            var pNow = eRef.pSurf + a.dp + (Math.random() - 0.5) * 0.12;
            altP = S.altAnchor.alt + HWE.util.scaleHeight(eRef.temp) * Math.log(S.altAnchor.p / pNow);
          } else {
            altP = alt;   // no anchor yet (lost from cold start) — profile stands in
            S.altAnchor = { alt: alt, p: eRef.pSurf + a.dp };
          }
        }
        var est = S.traveler.estimate(S.tickMs / HOUR, t, altP);
        if (est) {
          pos = { lat: est.lat, lon: est.lon };
          alt = altP != null ? altP : est.elev;
          S.lastEstPos = pos; S.lastEst = est; S.lastPosSrc = 'est';
        } else pos = { lat: tp.lat, lon: tp.lon };
      }
      S.lastTickPos = pos;
    }

    var exp = S.fc.expectedAt(hr, alt, pos);
    if (!exp) return null;
    var noise = (Math.random() - 0.5) * 0.10;            // MEMS barometer ~0.1 hPa p-p
    var p = exp.pSurf + a.dp + noise;
    var temp = exp.temp + a.dt + (Math.random() - 0.5) * 0.3;
    var rh = Math.max(5, Math.min(100, exp.rh + a.rh + (Math.random() - 0.5) * 4));
    var gust = Math.max(0, Math.min(100, a.gust + (Math.random() - 0.5) * 8));
    var altOut = S.corridor && S.gpsLost ? alt : alt + (Math.random() - 0.5) * 6;   // GPS vertical noise only when GPS present
    var tick = { t: t, pressure: p, altitude: altOut, temp: temp, rh: rh, gust: gust, battery: S.battery, connectivity: S.connectivity };
    if (pos) { tick.lat = pos.lat; tick.lon = pos.lon; }
    return tick;
  }

  // replay sampler: measured weather from era5-land, wearer on a static-ish trail
  function sampleReplay(s) {
    var rp = S.replay;
    if (!rp) return null;
    var hr = s; // replay obs array is on hourly grid
    var i = Math.min(rp.obs.length - 1, Math.floor(hr));
    var w = hr - i;
    var j = Math.min(rp.obs.length - 1, i + 1);
    var lerp = function (k) { return rp.obs[i][k] * (1 - w) + rp.obs[j][k] * w; };
    var alt = rp.elev + 40 * Math.sin(hr / 3);
    var noise = (Math.random() - 0.5) * 0.12;
    // grid surface pressure refers to grid elevation; shift to wearer altitude
    // with the same hypsometric formula the engine uses (removes harness artifact)
    var pAtWearer = lerp('p') * HWE.util.pRatio(alt, rp.elev, lerp('t'));
    return {
      t: S.simStart + hr * HOUR,
      pressure: pAtWearer + noise,
      altitude: alt,
      temp: lerp('t'),
      rh: lerp('rh'),
      gust: Math.min(100, lerp('g') * 1.4),              // km/h gusts -> 0-100 vibration proxy
      battery: S.battery, connectivity: true
    };
  }

  // ---------------------------------------------------------------- loop
  function frame(real) {
    if (!S.lastReal) S.lastReal = real;
    var dtReal = Math.min(0.25, (real - S.lastReal) / 1000);
    S.lastReal = real;
    if (S.running && S.engine) {
      var adv = dtReal * S.timeScale * 1000;             // simulated ms this frame
      var budget = adv;
      var guard = 0;
      while (budget >= S.tickMs && guard++ < 400) {
        step(S.tickMs);
        budget -= S.tickMs;
      }
      render();
    }
  }
  // setInterval keeps running when the tab is hidden (rAF pauses there)
  setInterval(function () { frame(performance.now()); }, 100);

  function step(dtSim) {
    S.simT += dtSim;
    var s = (S.simT - S.simStart) / HOUR;
    var tick = S.mode === 'replay' ? sampleReplay(s) : sampleSensor(s);
    if (!tick) return;
    var alert = S.engine.feed(tick);
    record(tick, s);
    if (alert) onAlert(alert);
    if (S.mode === 'replay' && s > S.replay.maxH) { S.running = false; pushEvent('Replay finished.', 'info'); render(); }
  }

  function record(tick, s) {
    var e = S.engine.explain;
    var q = S.series, W = S.winH;
    q.t.push(tick.t);
    q.expM.push(e.expMsl != null ? e.expMsl : (e.expected ? e.expected.pMsl : null));
    q.obsM.push(e.pMslObs);
    q.resid.push(e.residP);
    q.expT.push(e.expected ? e.expected.temp : null);
    q.obsT.push(tick.temp);
    q.expRH.push(e.expected ? e.expected.rh : null);
    q.obsRH.push(tick.rh);
    q.gust.push(tick.gust);
    q.alt.push(tick.altitude);
    q.pts.push(S.engine._score ? null : null);
    // trim
    var cutoff = tick.t - W * HOUR;
    while (q.t.length && q.t[0] < cutoff) {
      ['t', 'expM', 'obsM', 'resid', 'expT', 'obsT', 'expRH', 'obsRH', 'gust', 'alt', 'pts'].forEach(function (k) { q[k].shift(); });
    }
  }

  function onAlert(a) {
    var cls = { Info: 'info', Watch: 'watch', Warning: 'warn', Danger: 'danger' }[a.level] || 'info';
    pushEvent('[' + a.level.toUpperCase() + '] ' + a.message +
      (a.etaMinutes ? ' (ETA ~' + a.etaMinutes + ' min)' : '') +
      ' — confidence ' + Math.round((a.confidence || 0) * 100) + '%', cls);
    var banner = $('banner');
    banner.textContent = a.level + ' — ' + a.message + ' ' + a.action;
    banner.className = 'banner lv-' + cls;
    if (a.level === 'Warning' || a.level === 'Danger') { beep(a.level === 'Danger' ? 3 : 2); }
    $('stateLevel').textContent = a.level;
    $('stateLevel').className = 'lvlchip lv-' + cls;
  }

  function pushEvent(msg, cls) {
    S.events.unshift({ t: S.simT, msg: msg, cls: cls });
    if (S.events.length > 80) S.events.pop();
    var el = $('log');
    var div = document.createElement('div');
    div.className = 'ev ev-' + cls;
    div.textContent = '[' + fmtClock(S.simT) + '] ' + msg;
    el.insertBefore(div, el.firstChild);
    while (el.children.length > 80) el.removeChild(el.lastChild);
  }

  // ---------------------------------------------------------------- render
  function fmtClock(t) {
    var d = new Date(t);
    // displayed in Asia/Kathmandu (UTC+5:45)
    return new Date(d.getTime() + (5 * 60 + 45) * 60e3).toISOString().slice(5, 16).replace('T', ' ');
  }

  function drawChart(cv, series, keys, colors, opts) {
    var ctx = cv.getContext('2d');
    var W = cv.width = cv.clientWidth * devicePixelRatio;
    var H = cv.height = cv.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    var t0 = S.simT - S.winH * HOUR, t1 = S.simT;
    var lo = Infinity, hi = -Infinity;
    keys.forEach(function (k) {
      series[k] && series[k].forEach(function (v, i) {
        if (v == null) return;
        if (series.t[i] < t0) return;
        if (v < lo) lo = v; if (v > hi) hi = v;
      });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var pad = (hi - lo) * 0.12 + 1e-6; lo -= pad; hi += pad;
    var X = function (t) { return (t - t0) / (t1 - t0) * W; };
    var Y = function (v) { return H - (v - lo) / (hi - lo) * H; };
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) { var y = g / 4 * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    keys.forEach(function (k, ki) {
      ctx.strokeStyle = colors[ki]; ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath(); var started = false;
      series[k].forEach(function (v, i) {
        if (v == null || series.t[i] < t0) return;
        var x = X(series.t[i]), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    // labels
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = (11 * devicePixelRatio) + 'px -apple-system, sans-serif';
    ctx.fillText(opts.max + ' ' + opts.unit, 6, 14 * devicePixelRatio);
    ctx.fillText(opts.min + ' ' + opts.unit, 6, H - 6);
  }

  var lastRender = 0;
  function render() {
    var now = performance.now();
    if (now - lastRender < 120) return;
    lastRender = now;
    var e = S.engine && S.engine.explain || {};
    $('clock').textContent = fmtClock(S.simT);
    $('scaleLbl').textContent = S.timeScale + '\u00d7';
    $('age').textContent = e.expected ? 'cached forecast covers \u00b1; age ' + (e.forecastAgeH ? e.forecastAgeH.toFixed(1) : '?') + ' h' : 'expired';
    $('age').textContent = 'forecast age ' + (e.forecastAgeH != null ? e.forecastAgeH.toFixed(1) + ' h' : '?');
    $('residLbl').textContent = e.residP != null ? e.residP.toFixed(2) + ' hPa' : '—';
    $('rateLbl').textContent = e.obsPRate != null ? e.obsPRate.toFixed(2) + ' / dev ' + (e.dRate != null ? e.dRate.toFixed(2) : '—') + ' hPa/h' : '—';
    $('altLbl').textContent = S.series.alt.length ? Math.round(S.series.alt[S.series.alt.length - 1]) + ' m (\u00b1' + Math.round(e.altRate || 0) + ' m/h)' : '—';
    $('climbLbl').textContent = (e.climbExplainedPct != null ? e.climbExplainedPct + '%' : '—');
    $('conf').textContent = S.engine && S.engine.lastAlert ? Math.round((S.engine.lastAlert.confidence || 0) * 100) + '%' : '—';

    drawChart($('chP'), S.series, ['expM', 'obsM'], ['#7dd3fc', '#fbbf24'], { max: 'MSL pressure', min: 'last 6h', unit: 'hPa' });
    drawChart($('chR'), S.series, ['resid'], ['#f87171'], { max: 'residual (obs-exp)', min: '0', unit: 'hPa' });
    drawChart($('chT'), S.series, ['expT', 'obsT'], ['#7dd3fc', '#fbbf24'], { max: 'temperature', min: '', unit: '\u00b0C' });
    drawChart($('chH'), S.series, ['expRH', 'obsRH'], ['#7dd3fc', '#34d399'], { max: 'humidity', min: '', unit: '%' });
    drawChart($('chG'), S.series, ['gust'], ['#c084fc'], { max: 'gust proxy', min: '', unit: '0-100' });

    // map + position/route status
    updateMap();
    var cs = $('corrStatus'), ps = $('posStatus'), us = $('uncStatus');
    if (S.corridor) {
      cs.textContent = 'corridor: ' + S.corridor.points.length + ' pts · ' + S.corridor.lengthKm.toFixed(1) + ' km · position-aware';
      cs.className = 'poschip';
    } else {
      cs.textContent = S.mode === 'sim' ? 'no corridor — single-point forecast' : 'replay: static point';
      cs.className = 'poschip';
    }
    if (S.lastTickPos) {
      if (S.lastPosSrc === 'est' && S.lastEst) {
        ps.textContent = 'position: ESTIMATED · ' + S.lastEst.km.toFixed(1) + ' km along route · pace ' + S.lastEst.speedKmh.toFixed(1) + ' km/h · ' + S.lastEst.lostMin + ' min w/o GPS';
        ps.className = 'poschip est';
        us.textContent = '±' + S.lastEst.uncM + ' m';
        us.className = 'poschip' + (S.lastEst.uncM > 250 ? ' warn' : '');
      } else {
        ps.textContent = 'position: ' + (S.lastPosSrc === 'gps' ? 'GPS' : 'true') + ' ' + S.lastTickPos.lat.toFixed(4) + ', ' + S.lastTickPos.lon.toFixed(4);
        ps.className = 'poschip';
        us.textContent = '';
      }
    } else {
      ps.textContent = 'position: —'; ps.className = 'poschip'; us.textContent = '';
    }
  }

  // ---------------------------------------------------------------- audio
  var AC = null;
  function beep(n) {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      for (var i = 0; i < n; i++) {
        var o = AC.createOscillator(), g = AC.createGain();
        o.connect(g); g.connect(AC.destination);
        o.frequency.value = 880; o.type = 'square';
        var t = AC.currentTime + i * 0.28;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        o.start(t); o.stop(t + 0.22);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- setup
  async function boot(mode) {
    S.mode = mode;
    S.events = []; S.series.t = [];
    S.corridor = null; S.traveler = null; S.lastTickPos = null; S.lastEst = null; S.lastEstPos = null; S.lastPosSrc = null;
    $('log').innerHTML = '';
    if (M.ok) { M.route.setLatLngs([]); M.cps.clearLayers(); M.unc.hide(); }
    if (mode === 'sim') {
      var raw = await loadCachedForecast();
      S.fc = buildStore(raw, null);
      S.simStart = S.fc.t0 + 9 * HOUR;           // start 09:00 on day 1
      S.simT = S.simStart;
      S.replay = null;
    } else {
      pushEvent('Loading 9-day historical replay for Namche (Open-Meteo archive + model grid)…', 'info');
      var d = await loadReplayData();
      // forecast proxy = model analysis grid values (documented caveat)
      d.fcRaw._source = 'open-meteo-model-past_days';
      S.fc = buildStore(d.fcRaw, null);
      var obsSrc = d.obsRaw && d.obsRaw.hourly ? d.obsRaw.hourly : d.fcRaw.hourly; // fallback if archive fails
      S.replay = { elev: d.obsRaw ? d.obsRaw.elevation : d.fcRaw.elevation, obs: [], maxH: 0 };
      var fillObs = function (src) {
        S.replay.obs = [];
        for (var i = 0; i < src.time.length; i++) {
          if (src.surface_pressure[i] == null || src.temperature_2m[i] == null) continue;
          S.replay.obs.push({
            p: +src.surface_pressure[i], t: +src.temperature_2m[i],
            rh: +(src.relative_humidity_2m[i] || 0), g: +(src.wind_gusts_10m ? src.wind_gusts_10m[i] : src.wind_speed_10m[i]) || 0
          });
        }
      };
      fillObs(obsSrc);
      if (S.replay.obs.length < 24 && obsSrc !== d.fcRaw.hourly) {
        obsSrc = d.fcRaw.hourly; fillObs(obsSrc);   // archive too fresh/lagging: use model grid
        pushEvent('ERA5-Land observations unavailable for these dates — replaying model grid vs itself.', 'info');
      }
      S.simStart = S.fc.t0;
      S.simT = S.simStart;
      S.replay.maxH = S.replay.obs.length - 1;
      if (!d.obsRaw) pushEvent('Archive unavailable — replaying model grid vs itself (expect near-zero residuals).', 'info');
    }
    S.lastReal = 0;
    S.engine = new HWE.Engine(S.fc, {
      sensitivity: $('sens').value,
      battery: S.battery,
      onAlert: function () {}
    });
    $('banner').className = 'banner lv-none';
    $('banner').textContent = 'System armed — ' + (mode === 'sim' ? 'scenario: ' + S.scenario : 'historical replay') + '. Watching live sensors against cached forecast.';
    $('stateLevel').textContent = 'Clear';
    $('stateLevel').className = 'lvlchip lv-clear';
    pushEvent('Engine online. Grid elev ' + Math.round(S.fc.gridElevation) + ' m, cache ' + S.fc.hours.length + ' h. Sensitivity ' + S.engine.sensitivity + '.', 'info');
    render();
  }

  function wire() {
    $('play').onclick = function () { S.running = !S.running; this.textContent = S.running ? 'Pause' : 'Resume'; };
    $('reset').onclick = function () { boot(S.mode); };
    $('sens').onchange = function () { if (S.engine) S.engine.setSensitivity(this.value); };
    $('scale').onchange = function () { S.timeScale = +this.value; };
    $('scenario').onchange = function () { S.scenario = this.value; boot('sim'); };
    $('modeSim').onclick = function () { boot('sim'); };
    $('modeReplay').onclick = function () { boot('replay'); };
    $('conn').onchange = function () { S.connectivity = this.checked; pushEvent('Connectivity ' + (S.connectivity ? 'restored — forecast refresh would run now.' : 'lost — engine continues fully offline.'), 'info'); };

    // location & route controls
    $('autoLoc').onclick = function () {
      if (!navigator.geolocation) { pushEvent('Geolocation unavailable in this browser.', 'info'); return; }
      pushEvent('Requesting device location…', 'info');
      navigator.geolocation.getCurrentPosition(
        function (p) { setManualPos(p.coords.latitude, p.coords.longitude, 'auto-GPS'); },
        function (e) { pushEvent('Auto location failed (' + e.message + '). Use manual entry or map pick.', 'info'); },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    };
    $('pickStart').onclick = function () { S.pickMode = S.pickMode === 'start' ? null : 'start'; pickBtns(); };
    $('pickDest').onclick = function () { S.pickMode = S.pickMode === 'dest' ? null : 'dest'; pickBtns(); };
    $('setManual').onclick = function () {
      setManualPos(parseFloat($('inLat').value), parseFloat($('inLon').value), 'manual');
    };
    $('demoRoute').onclick = function () {
      // Real trail waypoints (verified via Open-Meteo geocoding + DEM):
      // Namche 3 463 m → Shomare ridge 3 855 m → Monjo 3 511 m → Tengboche 3 770 m
      S.waypoints = [
        { lat: 27.8053, lon: 86.7106 },   // Namche Bazaar (start)
        { lat: 27.8153, lon: 86.7209 },   // Shomare
        { lat: 27.8211, lon: 86.7441 },   // Monjo suspension bridge
        { lat: 27.8289, lon: 86.7530 },   // Tengboche climb
        { lat: 27.8371, lon: 86.7641 }    // Tengboche (destination)
      ];
      S.start = S.waypoints[0]; S.dest = S.waypoints[S.waypoints.length - 1];
      if (M.ok) { M.startM.setLatLng([S.start.lat, S.start.lon]).show(); M.destM.setLatLng([S.dest.lat, S.dest.lon]).show(); }
      buildCorridor();
    };
    $('buildCorr').onclick = buildCorridor;
    $('gpsSim').onchange = function () {
      S.gpsLost = !this.checked;
      if (!S.gpsLost) pushEvent('GPS reacquired — estimate re-anchored to the real fix on the next sample.', 'info');
      else pushEvent('GPS lost — switching to corridor dead-reckoning + barometric altitude (position prediction active).', 'info');
    };
  }

  wire();
  initMap();
  boot('sim');
  window.S = S;   // debug handle
})();
