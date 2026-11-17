// ==UserScript==
// @id             mu-labels@dieter
// @name           IITC Plugin: MU Info
// @category       Info
// @version        2.2.0
// @description    Info-Button links: im Info-Modus auf ein Feld bzw. Draw-Tools-Dreieck klicken → Popup mit geschätzter MU (eigene MU-API, getMUbulk).
// @author         Dieter
// @match          https://intel.ingress.com/*
// @match          https://intel.ingress.com/intel*
// @namespace      https://github.com/doppeIkeks/iitc-plugins
// @updateURL      https://raw.githubusercontent.com/doppeIkeks/iitc-plugins/main/mu-labels.meta.js
// @downloadURL    https://raw.githubusercontent.com/doppeIkeks/iitc-plugins/main/mu-labels.user.js
// @grant          none
// ==/UserScript==

/* global L, $ */

// IITC Standard-Injection-Wrapper (CSP von intel.ingress.com)
function wrapper (plugin_info) {
  'use strict'

  if (typeof window.plugin !== 'function') window.plugin = function () {}

  window.plugin.muLabels = function () {}
  const self = window.plugin.muLabels

  // ─── Konfiguration ─────────────────────────────────────────────────────────
  const STORAGE_SETTINGS = 'plugin-mu-labels-settings'
  const STORAGE_CACHE = 'plugin-mu-labels-cache'
  const BULK_MAX = 50     // Server-Limit pro getMUbulk-Request
  const CACHE_MAX = 20000 // max. Einträge im localStorage-Cache

  self.defaults = {
    apiBase: 'https://miokij.de/mu',
    lineTriangles: true   // Dreiecke auch aus Draw-Tools-Linien erkennen
  }
  self.settings = Object.assign({}, self.defaults)

  self.cache = {}         // key -> { mu, area }
  self.cacheModel = null
  self.active = false     // Info-Modus an/aus
  self.highlight = null   // Umrisse der getroffenen Felder
  self.popup = null
  self.clickSeq = 0       // verwirft Antworten älterer Klicks

  // ─── Persistenz ────────────────────────────────────────────────────────────
  self.loadSettings = function () {
    try { Object.assign(self.settings, JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || '{}')) } catch (_) {}
    // Altlasten früherer Versionen: leerer Wert bzw. alte LAN-Adresse → neuer Standard
    if (!self.settings.apiBase || self.settings.apiBase === 'https://192.168.178.26:8443') {
      self.settings.apiBase = self.defaults.apiBase
    }
  }

  self.saveSettings = function () {
    try { localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(self.settings)) } catch (_) {}
  }

  self.loadCache = function () {
    try {
      const c = JSON.parse(localStorage.getItem(STORAGE_CACHE) || '{}')
      if (c && c.entries) self.cache = c.entries
      self.cacheModel = c.model || null
    } catch (_) { self.cache = {} }
  }

  self.saveCache = function () {
    const keys = Object.keys(self.cache)
    if (keys.length > CACHE_MAX) {
      keys.slice(0, keys.length - CACHE_MAX).forEach(function (k) { delete self.cache[k] })
    }
    try {
      localStorage.setItem(STORAGE_CACHE, JSON.stringify({ model: self.cacheModel || '', entries: self.cache }))
    } catch (_) {}
  }

  self.clearCache = function () {
    self.cache = {}
    try { localStorage.removeItem(STORAGE_CACHE) } catch (_) {}
  }

  // ─── Geometrie ─────────────────────────────────────────────────────────────
  function ptStr (lat, lng) {
    return lat.toFixed(6) + ',' + lng.toFixed(6)
  }

  // Reihenfolge-unabhängiger Schlüssel eines Dreiecks
  function triKey (pts) {
    return pts.map(function (p) { return ptStr(p.lat, p.lng) }).sort().join('|')
  }

  function flattenLatLngs (lls) {
    while (Array.isArray(lls) && lls.length && Array.isArray(lls[0])) lls = lls[0]
    return lls || []
  }

  function dedupeClosing (lls) {
    if (lls.length > 1) {
      const a = lls[0]; const b = lls[lls.length - 1]
      if (a.lat === b.lat && a.lng === b.lng) return lls.slice(0, -1)
    }
    return lls
  }

  function roughArea (pts) {
    return Math.abs(
      (pts[1].lng - pts[0].lng) * (pts[2].lat - pts[0].lat) -
      (pts[2].lng - pts[0].lng) * (pts[1].lat - pts[0].lat)
    ) / 2
  }

  // Punkt-in-Dreieck (planar in lat/lng; für Ingress-Felder ausreichend genau)
  function pointInTri (p, t) {
    function sign (a, b, c) {
      return (a.lng - c.lng) * (b.lat - c.lat) - (b.lng - c.lng) * (a.lat - c.lat)
    }
    const d1 = sign(p, t[0], t[1]); const d2 = sign(p, t[1], t[2]); const d3 = sign(p, t[2], t[0])
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
  }

  function fmtMU (mu) {
    return Number(mu).toLocaleString('de-DE')
  }

  function esc (s) {
    return $('<div>').text(String(s)).html()
  }

  // ─── Datenquellen ──────────────────────────────────────────────────────────
  // Intel-Felder, die den Punkt enthalten
  self.fieldsAt = function (ll) {
    const out = []
    Object.keys(window.fields || {}).forEach(function (guid) {
      const f = window.fields[guid]
      const d = f.options && f.options.data
      let pts
      if (d && d.points && d.points.length === 3) {
        pts = d.points.map(function (p) { return { lat: p.latE6 / 1e6, lng: p.lngE6 / 1e6 } })
      } else {
        pts = dedupeClosing(flattenLatLngs(f.getLatLngs ? f.getLatLngs() : []))
        if (pts.length !== 3) return
      }
      if (!pointInTri(ll, pts)) return
      out.push({ key: triKey(pts), pts: pts, kind: 'field', team: f.options.team, area: roughArea(pts) })
    })
    return out
  }

  // Draw-Tools-Dreiecke (Polygone mit 3 Ecken + optional aus Linien), die den Punkt enthalten
  self.drawTrianglesAt = function (ll) {
    const out = []
    const seen = new Set()
    const dt = window.plugin.drawTools
    if (!dt || !dt.drawnItems) return out

    const nodes = {}
    const adj = {}
    function addEdge (a, b) {
      const ka = ptStr(a.lat, a.lng); const kb = ptStr(b.lat, b.lng)
      if (ka === kb) return
      nodes[ka] = a; nodes[kb] = b
      ;(adj[ka] = adj[ka] || new Set()).add(kb)
      ;(adj[kb] = adj[kb] || new Set()).add(ka)
    }
    function push (pts, source) {
      if (!pointInTri(ll, pts)) return
      const key = triKey(pts)
      if (seen.has(key)) return
      seen.add(key)
      out.push({ key: key, pts: pts, kind: 'draw', source: source, area: roughArea(pts) })
    }

    dt.drawnItems.eachLayer(function (layer) {
      if (!layer.getLatLngs || layer instanceof L.Circle) return
      const lls = dedupeClosing(flattenLatLngs(layer.getLatLngs()))
        .map(function (p) { return { lat: p.lat, lng: p.lng } })
      if (layer instanceof L.Polygon) {
        if (lls.length === 3) push(lls, 'polygon')
        if (self.settings.lineTriangles) {
          for (let i = 0; i < lls.length; i++) addEdge(lls[i], lls[(i + 1) % lls.length])
        }
      } else if (self.settings.lineTriangles) {
        for (let i = 0; i + 1 < lls.length; i++) addEdge(lls[i], lls[i + 1])
      }
    })

    if (self.settings.lineTriangles) {
      const keys = Object.keys(adj).sort()
      for (const a of keys) {
        for (const b of adj[a]) {
          if (b <= a) continue
          for (const c of adj[b]) {
            if (c <= b || !adj[a].has(c)) continue
            push([nodes[a], nodes[b], nodes[c]], 'lines')
            if (out.length >= 200) return out
          }
        }
      }
    }
    return out
  }

  // ─── API ───────────────────────────────────────────────────────────────────
  // Holt fehlende MU-Werte für die Dreiecke; liefert { key: fehlertext }
  self.fetchMU = function (tris) {
    const missing = []
    const seen = new Set()
    tris.forEach(function (t) {
      if (!self.cache[t.key] && !seen.has(t.key)) { seen.add(t.key); missing.push(t) }
    })
    const errors = {}
    if (!missing.length) return Promise.resolve(errors)

    const url = self.settings.apiBase.replace(/\/+$/, '') + '/api/getMUbulk'
    const chunks = []
    for (let i = 0; i < missing.length; i += BULK_MAX) chunks.push(missing.slice(i, i + BULK_MAX))

    return Promise.all(chunks.map(function (batch) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: batch.map(function (t) { return t.pts.map(function (p) { return ptStr(p.lat, p.lng) }) })
        })
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json()
        })
        .then(function (data) {
          if (data.model && self.cacheModel && data.model !== self.cacheModel) self.cache = {}
          if (data.model) self.cacheModel = data.model
          ;(data.results || []).forEach(function (res) {
            const t = batch[res.index]
            if (!t) return
            if (res.ok) self.cache[t.key] = { mu: res.mu, area: res.area_km2 }
            else errors[t.key] = res.error || 'Fehler'
          })
        })
        .catch(function (e) {
          batch.forEach(function (t) { errors[t.key] = e.message || String(e) })
        })
    })).then(function () {
      self.saveCache()
      return errors
    })
  }

  // ─── Popup ─────────────────────────────────────────────────────────────────
  const TEAM = { 1: ['RES', 'mu-res'], 2: ['ENL', 'mu-enl'], 3: ['MAC', 'mu-mac'] }

  function rowLabel (t) {
    if (t.kind === 'field') {
      const tm = TEAM[t.team] || ['Feld', 'mu-neutral']
      return '<span class="' + tm[1] + '">' + tm[0] + '-Feld</span>'
    }
    return '<span class="mu-draw">Draw ' + (t.source === 'polygon' ? 'Polygon' : 'Linien') + '</span>'
  }

  self.popupHtml = function (tris, errors, loading) {
    if (!tris.length) return '<div class="mu-popup">Kein Feld / Dreieck an dieser Stelle.<br><small>Hilfe: Toolbox → „MU Info“</small></div>'

    let html = '<div class="mu-popup"><table><tr><th></th><th>MU</th><th>km²</th></tr>'
    const sums = { field: 0, draw: 0 }
    const counts = { field: 0, draw: 0 }
    tris.forEach(function (t) {
      const c = self.cache[t.key]
      counts[t.kind]++
      if (c) sums[t.kind] += c.mu
      let mu
      if (c) mu = '<b>' + fmtMU(c.mu) + '</b>'
      else if (errors && errors[t.key]) mu = '<span class="mu-err" title="' + esc(errors[t.key]) + '">⚠ Fehler</span>'
      else mu = loading ? '…' : '?'
      html += '<tr><td>' + rowLabel(t) + '</td><td>' + mu + '</td><td>' +
        (c && c.area != null ? c.area.toFixed(3) : '') + '</td></tr>'
    })
    html += '</table>'
    ;['field', 'draw'].forEach(function (kind) {
      const all = tris.filter(function (t) { return t.kind === kind })
      if (all.length < 2 || !all.every(function (t) { return self.cache[t.key] })) return
      html += '<div class="mu-sum">Summe ' + (kind === 'field' ? 'Felder' : 'Draw') + ' (' + all.length +
        ' Lagen): <b>' + fmtMU(sums[kind]) + ' MU</b></div>'
    })
    const firstErr = errors && Object.keys(errors).length ? errors[Object.keys(errors)[0]] : null
    if (firstErr) html += '<div class="mu-err">' + esc(firstErr) + '</div>'
    html += '</div>'
    return html
  }

  self.clearHighlight = function () {
    if (self.highlight) { window.map.removeLayer(self.highlight); self.highlight = null }
  }

  self.onMapClick = function (e) {
    if (!self.active) return
    if (!self.settings.apiBase) { self.openSettings(); return }
    const ll = { lat: e.latlng.lat, lng: e.latlng.lng }
    // kleinste (innerste) Felder zuerst
    const tris = self.fieldsAt(ll).concat(self.drawTrianglesAt(ll))
      .sort(function (a, b) { return a.area - b.area })

    self.clearHighlight()
    self.highlight = L.layerGroup(tris.map(function (t) {
      return L.polygon(t.pts, {
        color: t.kind === 'draw' ? '#ffcc33' : '#ffffff',
        weight: 2, dashArray: '6 4', fill: false, interactive: false
      })
    })).addTo(window.map)

    const seq = ++self.clickSeq
    self.popup = L.popup({ maxWidth: 320, className: 'mu-leaflet-popup' })
      .setLatLng(e.latlng)
      .setContent(self.popupHtml(tris, null, true))
      .openOn(window.map)

    self.fetchMU(tris).then(function (errors) {
      if (seq !== self.clickSeq || !self.popup || !window.map.hasLayer(self.popup)) return
      self.popup.setContent(self.popupHtml(tris, errors, false))
    })
  }

  // ─── Info-Button (links) ───────────────────────────────────────────────────
  self.setActive = function (on) {
    self.active = on
    $(self.button).toggleClass('mu-active', on)
    $(window.map.getContainer()).toggleClass('mu-info-mode', on)
    if (!on) {
      self.clearHighlight()
      if (self.popup) window.map.closePopup(self.popup)
    }
  }

  self.addControl = function () {
    const Ctl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control mu-control')
        const a = L.DomUtil.create('a', '', div)
        a.href = '#'
        a.title = 'MU-Info an/aus – dann auf ein Feld klicken (Esc beendet). Anleitung: Toolbox → „MU Info“'
        a.innerHTML = 'MU'
        L.DomEvent.disableClickPropagation(div)
        L.DomEvent.on(a, 'click', function (ev) {
          L.DomEvent.preventDefault(ev)
          self.setActive(!self.active)
        })
        self.button = a
        return div
      }
    })
    window.map.addControl(new Ctl())
  }

  // ─── Einstellungen (Toolbox) ───────────────────────────────────────────────
  self.helpHtml = function () {
    return '<div class="mu-help"><b>Kurzanleitung</b><ol>' +
      '<li>Links auf <b>MU</b> klicken – der Button wird gelb, der Info-Modus ist an.</li>' +
      '<li>Auf eine Stelle innerhalb eines Feldes oder Draw-Tools-Dreiecks klicken.</li>' +
      '<li>Das Popup zeigt jede Lage an dieser Stelle (innerstes Feld zuerst) mit MU und km², ' +
      'bei mehreren Lagen auch die Summe. Die getroffenen Felder werden gestrichelt umrandet.</li>' +
      '<li><b>MU</b> erneut klicken oder <b>Esc</b> drücken beendet den Info-Modus.</li>' +
      '</ol>' +
      '<div class="mu-legend">Farben: <span class="mu-enl">ENL</span> · <span class="mu-res">RES</span> · ' +
      '<span class="mu-mac">MAC</span> · <span class="mu-draw">Draw-Tools</span>. ' +
      'Draw-Tools-Dreiecke = Polygone mit 3 Ecken und (optional) Dreiecke, die sich aus gezeichneten Linien ergeben. ' +
      'Die MU sind Schätzwerte des MU-Servers; einmal abgefragte Felder kommen aus dem Cache.</div></div>'
  }

  self.openSettings = function () {
    const s = self.settings
    const html = self.helpHtml() + '<div class="mu-settings">' +
      '<label>API: <input type="text" id="mu-api" value="' + esc(s.apiBase) + '" placeholder="https://server.example.de" style="width:230px"></label><br>' +
      '<label><input type="checkbox" id="mu-lineTri"' + (s.lineTriangles ? ' checked' : '') + '> Draw-Tools: Dreiecke auch aus Linien erkennen</label><br>' +
      '<div style="margin-top:6px;opacity:.7">Cache: ' + Object.keys(self.cache).length + ' Felder' +
      (self.cacheModel ? ' · Modell ' + esc(self.cacheModel) : '') + '</div></div>'
    window.dialog({
      html: html,
      id: 'mu-labels-settings',
      title: 'MU Info',
      width: 380,
      buttons: {
        'Cache leeren': function () { self.clearCache(); $(this).dialog('close') },
        'OK': function () {
          const el = $(this)
          s.apiBase = String(el.find('#mu-api').val() || '').trim() || self.defaults.apiBase
          s.lineTriangles = el.find('#mu-lineTri').is(':checked')
          self.saveSettings()
          el.dialog('close')
        }
      }
    })
  }

  // ─── CSS ───────────────────────────────────────────────────────────────────
  self.injectCSS = function () {
    $('<style>').prop('type', 'text/css').html(
      '.mu-control a { font: bold 11px/26px Arial, sans-serif; text-align: center; }' +
      '.mu-control a.mu-active { background: #ffcc33; color: #000; }' +
      '.mu-info-mode, .mu-info-mode .leaflet-interactive { cursor: help !important; }' +
      '.mu-popup table { border-collapse: collapse; }' +
      '.mu-popup td, .mu-popup th { padding: 1px 6px; text-align: right; white-space: nowrap; }' +
      '.mu-popup td:first-child { text-align: left; }' +
      '.mu-popup .mu-sum { margin-top: 4px; }' +
      '.mu-popup .mu-err { color: #ff6666; }' +
      '.mu-popup .mu-enl { color: #03dc03; }' +
      '.mu-popup .mu-res { color: #0088ff; }' +
      '.mu-popup .mu-mac { color: #ff4040; }' +
      '.mu-popup .mu-draw { color: #e0a000; }' +
      '.mu-help { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.2); }' +
      '.mu-help ol { margin: 4px 0 4px 18px; padding: 0; }' +
      '.mu-help li { margin-bottom: 2px; }' +
      '.mu-help .mu-legend { font-size: 11px; opacity: 0.85; }' +
      '.mu-help .mu-enl { color: #03dc03; } .mu-help .mu-res { color: #0088ff; }' +
      '.mu-help .mu-mac { color: #ff4040; } .mu-help .mu-draw { color: #e0a000; }'
    ).appendTo('head')
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────
  self.setup = function () {
    self.loadSettings()
    self.loadCache()
    self.injectCSS()
    self.addControl()

    window.map.on('click', self.onMapClick)
    window.map.on('popupclose', function (e) {
      if (e.popup === self.popup) self.clearHighlight()
    })
    $(document).on('keydown', function (e) {
      if (e.key === 'Escape' && self.active) self.setActive(false)
    })

    $('#toolbox').append(' <a onclick="window.plugin.muLabels.openSettings();return false;" title="Kurzanleitung und Einstellungen für MU-Info">MU Info</a>')
    console.log('[IITC] MU Info geladen')
  }

  self.setup.info = plugin_info
  if (!window.bootPlugins) window.bootPlugins = []
  window.bootPlugins.push(self.setup)
  if (window.iitcLoaded && typeof self.setup === 'function') self.setup()
} // Ende wrapper()

// ─── Injection in den Seiten-Kontext ─────────────────────────────────────────
;(function () {
  const script = document.createElement('script')
  const info = {}
  if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
    info.script = {
      version: GM_info.script.version,
      name: GM_info.script.name,
      description: GM_info.script.description
    }
  }
  script.textContent = ';(' + wrapper.toString() + ')(' + JSON.stringify(info) + ');'
  ;(document.body || document.head || document.documentElement).appendChild(script)
})()
