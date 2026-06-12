(function () {
  const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:8080' : '';
  let map, highlightLayer, baseLayerGroup;
  let chatHistory = [];
  let isStreaming = false;
  let chatAbortController = null;
  let layerColors = {
    building: '#e06c75',
    land_use: '#50fa7b',
    zoning: '#61afef',
    road: '#d19a66'
  };
  let activeLayers = {};
  let enable3DBuildings = false;
  let activeGisTool = null;
  let routeStart = null;
  let routeEnd = null;
  let gisMarkers = null;
  let gisLayers = null;
  let pendingIsochroneLatLng = null;
  let loadedBounds = {};
  let cachedGeoJSON = {};
  let loadedZoom = {};
  let lastRendered3DState = false;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  const dynamicLayers = ['building', 'land_use', 'zoning', 'road'];
  let viewportLoadTimeout = null;

  function initMap() {
    map = L.map('map', {
      center: [6.92, 79.865],
      zoom: 15,
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true
    });

    const darkTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    });

    const osmTile = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM contributors</a>',
      maxZoom: 19
    });

    const satelliteTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19
    });

    // Default is CartoDB Dark Matter tile layer
    darkTile.addTo(map);

    const baseMaps = {
      "OpenStreetMap Standard": osmTile,
      "CartoDB Dark Matter": darkTile,
      "Esri Satellite Imagery": satelliteTile
    };

    L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

    highlightLayer = L.layerGroup().addTo(map);
    baseLayerGroup = L.layerGroup().addTo(map);
    gisMarkers = L.layerGroup().addTo(map);
    gisLayers = L.layerGroup().addTo(map);

    map.zoomControl.setPosition('bottomright');

    map.on('moveend', () => {
      onMapViewportChange();
    });

    map.on('zoomend', () => {
      Object.entries(activeLayers).forEach(([name, layer]) => {
        if (layer && typeof layer.setStyle === 'function') {
          layer.setStyle(layer.options.style);
        }
      });
      if (highlightLayer) {
        highlightLayer.eachLayer(layer => {
          if (layer && typeof layer.setStyle === 'function') {
            layer.setStyle(layer.options.style);
          }
        });
      }
    });

    map.on('click', onMapClick);
    map.on('popupopen', () => {
      if (activeGisTool) {
        map.closePopup();
      }
    });

    setTimeout(() => map.invalidateSize(), 300);
  }

  function getFeatureColor(layerName, properties) {
    if (!properties) return '#abb2bf';
    
    if (layerName === 'building') {
      const use = (properties.main_use || '').toLowerCase();
      if (use.includes('residen')) return '#e06c75';
      if (use.includes('commerc') || use.includes('shop') || use.includes('bank')) return '#61afef';
      if (use.includes('educat') || use.includes('school') || use.includes('univers')) return '#e5c07b';
      if (use.includes('relig') || use.includes('templ') || use.includes('church') || use.includes('mosqu')) return '#c678dd';
      if (use.includes('indust') || use.includes('factor')) return '#d19a66';
      if (use.includes('instit') || use.includes('gov')) return '#56b6c2';
      return '#888';
    }
    
    if (layerName === 'land_use') {
      const desc = (properties.discriptio || properties.descriptio || '').toLowerCase();
      if (desc.includes('residen')) return '#e06c75';
      if (desc.includes('commerc') || desc.includes('bank')) return '#61afef';
      if (desc.includes('open') || desc.includes('park') || desc.includes('play') || desc.includes('beach')) return '#50fa7b';
      if (desc.includes('water') || desc.includes('canal') || desc.includes('river') || desc.includes('lake')) return '#56b6c2';
      if (desc.includes('indust')) return '#d19a66';
      if (desc.includes('road') || desc.includes('rail') || desc.includes('transport')) return '#abb2bf';
      return '#888';
    }
    
    if (layerName === 'zoning') {
      const zone = (properties.zone || '').toLowerCase();
      if (zone.includes('residen')) return '#e06c75';
      if (zone.includes('commerc') || zone.includes('business')) return '#61afef';
      if (zone.includes('mixed')) return '#c678dd';
      if (zone.includes('indust')) return '#d19a66';
      if (zone.includes('open') || zone.includes('recreat')) return '#50fa7b';
      return '#888';
    }
    
    if (layerName === 'road') {
      const cls = (properties.road_class || '').toLowerCase();
      if (cls === 'primary' || cls === 'motorway' || cls === 'trunk' || cls.includes('class a') || cls === 'a') return '#ff4444';
      if (cls === 'secondary' || cls === 'tertiary' || cls.includes('class b') || cls === 'b') return '#ffad44';
      return '#abb2bf';
    }
    
    return layerColors[layerName] || '#abb2bf';
  }

  function getBuildingHeight(properties) {
    const use = (properties.main_use || '').toLowerCase();
    const area = properties['st_area(sh'] || properties.area || 100;
    if (use.includes('commerc') || use.includes('shop') || use.includes('bank')) return 25 + Math.min(30, area / 20);
    if (use.includes('indust') || use.includes('factory')) return 15 + Math.min(15, area / 50);
    if (use.includes('educat') || use.includes('school')) return 12 + Math.min(10, area / 50);
    if (use.includes('instit') || use.includes('gov')) return 18 + Math.min(20, area / 30);
    return 8 + Math.min(10, area / 100);
  }

  function colorMix(color1, color2, weight) {
    const d2h = (d) => ('0' + d.toString(16)).slice(-2);
    const parse = (c) => {
      if (c && c.startsWith('#')) {
        if (c.length === 4) {
          return [parseInt(c[1]+c[1], 16), parseInt(c[2]+c[2], 16), parseInt(c[3]+c[3], 16)];
        }
        return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
      }
      return [136, 136, 136];
    };
    const rgb1 = parse(color1);
    const rgb2 = parse(color2);
    const r = Math.round(rgb1[0] * (1 - weight) + rgb2[0] * weight);
    const g = Math.round(rgb1[1] * (1 - weight) + rgb2[1] * weight);
    const b = Math.round(rgb1[2] * (1 - weight) + rgb2[2] * weight);
    return '#' + d2h(r) + d2h(g) + d2h(b);
  }

  function bindPopupToLayer(layer, feature, layerName) {
    if (feature.properties) {
      let html = '<div class="feature-popup">';
      const p = feature.properties;
      const t = escapeHtml(p.name || p.main_use || p.zone || p.discriptio || p.road_class || layerName);
      html += `<div class="popup-title">${t}</div>`;
      Object.entries(p).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '' && k !== 'geometry') {
          html += `<div class="popup-row"><span class="popup-key">${escapeHtml(k)}</span><span class="popup-val">${escapeHtml(v)}</span></div>`;
        }
      });
      html += '</div>';
      layer.bindPopup(html, { maxWidth: 300 });
    }

    layer.on('click', function (e) {
      if (activeGisTool) {
        L.DomEvent.stopPropagation(e);
        onMapClick(e);
      }
    });
  }

  function resetAllNativeStyles() {
    const resetLayer = (layer) => {
      if (layer.options && layer.options.originalStyle) {
        layer.setStyle(layer.options.originalStyle);
      }
      if (layer.eachLayer) {
        layer.eachLayer(resetLayer);
      }
    };
    Object.values(activeLayers).forEach(activeLayer => {
      if (activeLayer && activeLayer.eachLayer) {
        activeLayer.eachLayer(resetLayer);
      }
    });
  }

  function createStyledGeoJSON(geojson, layerName) {
    if (!geojson || !geojson.features) return L.featureGroup();

    if (layerName === 'building' && enable3DBuildings && map.getZoom() >= 16) {
      const layerGroup = L.featureGroup();
      geojson.features.forEach(feature => {
        const geom = feature.geometry;
        if (!geom) return;

        const color = getFeatureColor(layerName, feature.properties);
        const gt = geom.type;

        if (gt === 'Polygon' || gt === 'MultiPolygon') {
          const rings = gt === 'Polygon' ? [geom.coordinates] : geom.coordinates;
          rings.forEach(ring => {
            const basePoints = ring[0].map(c => L.latLng(c[1], c[0]));
            if (basePoints.length < 3) return;

            const height = getBuildingHeight(feature.properties);
            const zoom = map.getZoom();
            const degPerMeter = 0.000009 * Math.pow(2, zoom - 18);
            const dy = height * degPerMeter * 0.7;
            const dx = height * degPerMeter * 0.7;

            const roofPoints = basePoints.map(p => L.latLng(p.lat + dy, p.lng + dx));

            const strokeColor = colorMix(color, '#ffffff', 0.2);
            const wallColor = colorMix(color, '#000000', 0.25);

            for (let i = 0; i < basePoints.length - 1; i++) {
              const p1 = basePoints[i];
              const p2 = basePoints[i+1];
              const r1 = roofPoints[i];
              const r2 = roofPoints[i+1];
              const wallOptions = {
                fillColor: wallColor,
                fillOpacity: 0.8,
                color: strokeColor,
                weight: 0.5,
                opacity: 0.5
              };
              const wall = L.polygon([p1, p2, r2, r1], wallOptions);
              wall.options.originalStyle = Object.assign({}, wallOptions);
              bindPopupToLayer(wall, feature, layerName);
              layerGroup.addLayer(wall);
            }

            const roofOptions = {
              fillColor: color,
              fillOpacity: 0.9,
              color: strokeColor,
              weight: 0.8,
              opacity: 0.8
            };
            const roof = L.polygon(roofPoints, roofOptions);
            roof.options.originalStyle = Object.assign({}, roofOptions);
            bindPopupToLayer(roof, feature, layerName);
            layerGroup.addLayer(roof);
          });
        }
      });
      return layerGroup;
    }

    const geoLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const color = getFeatureColor(layerName, feature.properties);
        const geom = feature.geometry;
        const gt = geom ? geom.type : '';
        const options = {};
        if (gt === 'LineString' || gt === 'MultiLineString') {
          const zoom = map ? map.getZoom() : 13;
          const cls = (feature.properties && feature.properties.road_class || '').toLowerCase();
          let baseWeight = (cls.includes('class a') || cls === 'a') ? 4 : (cls.includes('class b') || cls === 'b') ? 3 : 2;
          let weight = baseWeight;
          if (zoom >= 16) {
            weight = baseWeight;
          } else if (zoom === 15) {
            weight = baseWeight * 0.75;
          } else if (zoom === 14) {
            weight = baseWeight * 0.5;
          } else if (zoom === 13) {
            weight = baseWeight * 0.35;
          } else {
            weight = baseWeight * 0.2;
          }
          options.color = color;
          options.weight = Math.max(0.3, weight);
          options.opacity = 0.75;
        } else {
          options.fillColor = color;
          options.fillOpacity = 0.35;
          options.color = color;
          options.weight = 1;
          options.opacity = 0.6;
        }
        return options;
      },
      onEachFeature: (feature, layer) => {
        const color = getFeatureColor(layerName, feature.properties);
        const geom = feature.geometry;
        const gt = geom ? geom.type : '';
        const options = {};
        if (gt === 'LineString' || gt === 'MultiLineString') {
          options.color = color;
          options.weight = 2;
          options.opacity = 0.75;
        } else {
          options.fillColor = color;
          options.fillOpacity = 0.35;
          options.color = color;
          options.weight = 1;
          options.opacity = 0.6;
        }
        layer.options.originalStyle = options;
        bindPopupToLayer(layer, feature, layerName);
      }
    });

    return geoLayer;
  }

  function onMapClick(e) {
    if (activeGisTool === 'route') {
      if (!routeStart) {
        routeStart = e.latlng;
        L.marker(routeStart, {
          icon: L.divIcon({
            className: 'gis-marker start-marker',
            html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>Start',
            iconSize: [68, 24],
            iconAnchor: [34, 24]
          })
        }).addTo(gisMarkers);
        showNotification('Click destination point on the map', 'info');
      } else if (!routeEnd) {
        routeEnd = e.latlng;
        L.marker(routeEnd, {
          icon: L.divIcon({
            className: 'gis-marker end-marker',
            html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>End',
            iconSize: [68, 24],
            iconAnchor: [34, 24]
          })
        }).addTo(gisMarkers);
        calculateRoute();
      } else {
        clearGisData();
        routeStart = e.latlng;
        L.marker(routeStart, {
          icon: L.divIcon({
            className: 'gis-marker start-marker',
            html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>Start',
            iconSize: [68, 24],
            iconAnchor: [34, 24]
          })
        }).addTo(gisMarkers);
      }
    } else if (activeGisTool === 'isochrone') {
      pendingIsochroneLatLng = e.latlng;
      const modal = $('#isochroneModal');
      if (modal) {
        modal.classList.remove('hidden');
        const input = $('#isochroneMinutes');
        if (input) { input.value = '10'; input.focus(); }
      }
    }
  }

  async function calculateRoute() {
    if (!routeStart || !routeEnd) return;
    setStatus('Routing...', 'var(--warn)');
    showNotification('Calculating shortest walking path...', 'info');
    try {
      const res = await fetch(`${API_BASE}/api/tool/get_walking_route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          args: {
            start_lat: routeStart.lat,
            start_lon: routeStart.lng,
            end_lat: routeEnd.lat,
            end_lon: routeEnd.lng
          }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.status === 'success' && result.data && result.data.route_geojson) {
        const routeLayer = L.geoJSON(result.data.route_geojson, {
          style: {
            color: '#14F195',
            weight: 6,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round'
          }
        });
        gisLayers.addLayer(routeLayer);
        map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
        
        const dist = result.data.distance_meters;
        const time = result.data.estimated_walk_time_minutes;
        showNotification(`Route found: ${dist.toFixed(0)}m (~${time.toFixed(1)} mins)`, 'success');
        addMessage('text', `**Walking Route Calculated**\n- **Distance:** ${dist.toFixed(0)} meters\n- **Estimated Walk Time:** ${time.toFixed(1)} minutes (at 4.5 km/h)\n- **Start:** ${routeStart.lat.toFixed(5)}, ${routeStart.lng.toFixed(5)}\n- **End:** ${routeEnd.lat.toFixed(5)}, ${routeEnd.lng.toFixed(5)}`);
      } else {
        showNotification(result.message || 'No route found', 'error');
      }
      setStatus('Ready', 'var(--green)');
    } catch (e) {
      showNotification(`Routing failed: ${e.message}`, 'error');
      setStatus('Ready', 'var(--green)');
    }
  }

  async function calculateIsochrone(latlng, minutes) {
    setStatus('Computing Isochrone...', 'var(--warn)');
    showNotification(`Calculating ${minutes}-min walking isochrone...`, 'info');
    try {
      const res = await fetch(`${API_BASE}/api/tool/get_network_isochrone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          args: {
            lat: latlng.lat,
            lon: latlng.lng,
            walk_time_minutes: minutes
          }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.status === 'success' && result.data && result.data.isochrone_geojson) {
        const isoLayer = L.geoJSON(result.data.isochrone_geojson, {
          style: {
            fillColor: '#c678dd',
            fillOpacity: 0.4,
            color: '#c678dd',
            weight: 2,
            opacity: 0.8
          }
        });
        gisLayers.addLayer(isoLayer);
        
        L.marker(latlng, {
          icon: L.divIcon({
            className: 'gis-marker iso-center-marker',
            html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Center',
            iconSize: [68, 24],
            iconAnchor: [34, 24]
          })
        }).addTo(gisMarkers);

        map.fitBounds(isoLayer.getBounds(), { padding: [40, 40] });
        
        const nodes = result.data.reachable_nodes;
        const coverage = result.data.coverage_distance_m;
        showNotification(`Isochrone created: ${nodes} nodes reached`, 'success');
        addMessage('text', `**Walking Isochrone Generated**\n- **Walk Time:** ${minutes} minutes\n- **Coverage Radius:** ~${coverage.toFixed(0)} meters\n- **Reachable Nodes:** ${nodes} intersection nodes\n- **Center:** ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
      } else {
        showNotification(result.message || 'Failed to calculate isochrone', 'error');
      }
      setStatus('Ready', 'var(--green)');
    } catch (e) {
      showNotification(`Isochrone calculation failed: ${e.message}`, 'error');
      setStatus('Ready', 'var(--green)');
    }
  }

  function clearGisData() {
    if (gisMarkers) gisMarkers.clearLayers();
    if (gisLayers) gisLayers.clearLayers();
    routeStart = null;
    routeEnd = null;
  }

  function onMapViewportChange() {
    if (!map) return;
    clearTimeout(viewportLoadTimeout);
    viewportLoadTimeout = setTimeout(() => {
      Object.keys(activeLayers).forEach(layerName => {
        if (dynamicLayers.includes(layerName)) {
          loadLayerViewport(layerName);
        }
      });
    }, 400);
  }

  async function loadLayerViewport(layerName, forceReload = false) {
    if (!map) return;

    const currentZoom = map.getZoom();
    const mapBounds = map.getBounds();

    // Performance: Avoid loading individual buildings when zoomed out to prevent browser freeze
    if (layerName === 'building' && currentZoom < 15) {
      if (activeLayers['building']) {
        baseLayerGroup.removeLayer(activeLayers['building']);
        delete activeLayers['building'];
        updateLayerControls();
      }
      setStatus('Zoom in closer (Level 15+) to load buildings', 'var(--warn)');
      return;
    }

    // Performance: Avoid loading roads when zoomed out to prevent browser freeze
    if (layerName === 'road' && currentZoom < 13) {
      if (activeLayers['road']) {
        baseLayerGroup.removeLayer(activeLayers['road']);
        delete activeLayers['road'];
        updateLayerControls();
      }
      setStatus('Zoom in closer (Level 13+) to load roads', 'var(--warn)');
      return;
    }

    // Determine if we need to fetch fresh simplified geometries from the server
    const needsFetch = forceReload ||
                       !loadedBounds[layerName] ||
                       loadedZoom[layerName] !== currentZoom ||
                       !loadedBounds[layerName].contains(mapBounds) ||
                       !cachedGeoJSON[layerName];

    // Determine if we need to re-render the layer (either because we fetched new data, or styling constraints changed)
    let needsRerender = needsFetch;
    if (!needsFetch) {
      if (layerName === 'building') {
        const was3D = lastRendered3DState && (loadedZoom[layerName] >= 16);
        const is3D = enable3DBuildings && (currentZoom >= 16);
        if (was3D !== is3D || lastRendered3DState !== enable3DBuildings) {
          needsRerender = true;
        }
      }
    }

    if (!needsRerender) {
      return; // Do nothing; current map view is completely valid and details are sufficient
    }

    try {
      let geojson;
      if (needsFetch) {
        // Cushion/Buffer bounds by 40% in each direction to preload adjacent features
        const paddedBounds = mapBounds.pad(0.4);
        const bbox = `${paddedBounds.getWest()},${paddedBounds.getSouth()},${paddedBounds.getEast()},${paddedBounds.getNorth()}`;
        
        setStatus(`Loading ${layerName}...`, 'var(--warn)');
        const res = await fetch(`${API_BASE}/api/layer/${layerName}/geojson?bbox=${bbox}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.status === 'success' && data.geojson) {
          geojson = data.geojson;
          cachedGeoJSON[layerName] = geojson;
          loadedBounds[layerName] = paddedBounds;
          loadedZoom[layerName] = currentZoom;
        } else {
          throw new Error(data.message || 'Invalid format');
        }
      } else {
        geojson = cachedGeoJSON[layerName];
      }

      if (geojson) {
        const geoLayer = createStyledGeoJSON(geojson, layerName);

        if (activeLayers[layerName]) {
          baseLayerGroup.removeLayer(activeLayers[layerName]);
        }
        activeLayers[layerName] = geoLayer;
        baseLayerGroup.addLayer(geoLayer);
        
        if (layerName === 'building') {
          lastRendered3DState = enable3DBuildings;
        }
        updateLayerControls();
      }
      setStatus('Ready', 'var(--green)');
    } catch (e) {
      showNotification(`Failed to load viewport: ${e.message}`, 'error');
      setStatus('Ready', 'var(--green)');
    }
  }

  function initResizeHandle() {
    const handle = $('#resizeHandle');
    const chatContainer = $('#chatContainer');
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startWidth = chatContainer.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const diff = e.clientX - startX;
        const newWidth = Math.max(300, Math.min(window.innerWidth * 0.7, startWidth + diff));
        chatContainer.style.width = newWidth + 'px';
        chatContainer.style.flex = 'none';
        map.invalidateSize();
      };

      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        map.invalidateSize();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  let _scrollTimer = null;
  function debouncedScrollToBottom() {
    if (_scrollTimer) return;
    _scrollTimer = requestAnimationFrame(() => {
      _scrollTimer = null;
      scrollToBottom();
    });
  }

  function scrollToBottom() {
    const container = $('#chatMessages');
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  function hideWelcome() {
    const ws = $('#welcomeScreen');
    if (ws) {
      ws.style.opacity = '0';
      ws.style.transform = 'translate(-50%, -50%) scale(0.95)';
      ws.style.transition = 'all 0.3s ease';
      setTimeout(() => ws.remove(), 300);
    }
  }

  function addMessage(type, content) {
    hideWelcome();
    const container = $('#chatMessages');
    const div = document.createElement('div');
    div.className = `msg msg-${type}`;

    if (type === 'text') {
      try {
        div.innerHTML = DOMPurify.sanitize(marked.parse(content, { breaks: true, gfm: true }));
      } catch {
        div.textContent = content;
      }
    } else {
      div.textContent = content;
    }

    container.appendChild(div);
    scrollToBottom();
    return div;
  }

  function createStreamingMessage(type) {
    hideWelcome();
    const container = $('#chatMessages');
    const div = document.createElement('div');
    div.className = `msg msg-${type}`;
    container.appendChild(div);
    scrollToBottom();
    return div;
  }

  function showTypingIndicator() {
    hideWelcome();
    const container = $('#chatMessages');
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.id = 'typingIndicator';
    div.innerHTML = '<span class="thinking-text">Thinking...</span>';
    container.appendChild(div);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const ind = $('#typingIndicator');
    if (ind) ind.remove();
  }

  function setStatus(text, color) {
    const dot = $('#statusDot');
    const statusText = $('#statusText');
    statusText.textContent = text;
    dot.style.background = color || 'var(--green)';
    dot.style.boxShadow = `0 0 6px ${color || 'var(--green)'}`;
    if (color === 'var(--warn)') {
      dot.style.animation = 'breathe 1s ease-in-out infinite';
    } else {
      dot.style.animation = 'breathe 3s ease-in-out infinite';
    }
  }

  function showNotification(message, type = 'info') {
    const existing = document.querySelectorAll('.notification-toast');
    existing.forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function updateStats(data) {
    const panel = $('#statsContent');
    if (!panel || !data) return;

    let html = '';
    if (typeof data === 'object') {
      const msg = data.message || '';
      const d = data.data;

      if (d) {
        if (d.breakdown || d.composition) {
          const items = d.breakdown || d.composition;
          const totalArea = d.total_area_hectares || items.reduce((a, b) => a + (b.area_hectares || 0), 0);
          
          html += `<div class="stats-summary-header">
            <span class="summary-title">${msg}</span>
            <div class="summary-sub">Total Area: <strong class="text-accent">${totalArea.toLocaleString(undefined, {maximumFractionDigits:2})} ha</strong></div>
          </div>`;
          
          html += '<div class="stats-bar-container">';
          const sorted = [...items].sort((a, b) => (b.area_hectares || 0) - (a.area_hectares || 0));
          const colors = ['#e06c75', '#50fa7b', '#61afef', '#d19a66', '#c678dd', '#56b6c2', '#e5c07b', '#abb2bf'];
          
          sorted.forEach((item, i) => {
            const name = item[d.category_column] || item.discriptio || item.descriptio || item.category || Object.values(item)[0];
            const area = item.area_hectares || 0;
            const pct = item.percentage !== undefined ? item.percentage : ((area / (totalArea || 1)) * 100);
            const count = item.feature_count || 0;
            
            html += `<div class="stats-bar">
              <div class="stats-bar-header">
                <span class="stats-bar-label" title="${name}">${name} <span class="count-badge">(${count})</span></span>
                <span class="stats-bar-value">${area.toFixed(2)} ha (${pct.toFixed(1)}%)</span>
              </div>
              <div class="stats-bar-track">
                <div class="stats-bar-fill" style="width:${pct}%;background:${colors[i % colors.length]}"></div>
              </div>
            </div>`;
          });
          html += '</div>';
        }

        else if (msg && msg.includes("Unique values")) {
          html += `<div class="stats-summary-header">
            <span class="summary-title">${msg}</span>
          </div>`;
          
          html += '<div class="stats-bar-container">';
          const entries = Object.entries(d);
          const totalCount = entries.reduce((sum, [_, count]) => sum + count, 0);
          const maxVal = Math.max(...entries.map(([_, count]) => count));
          const colors = ['#e06c75', '#50fa7b', '#61afef', '#d19a66', '#c678dd', '#56b6c2', '#e5c07b', '#abb2bf'];
          
          entries.forEach(([key, count], i) => {
            const pct = (count / (totalCount || 1)) * 100;
            const barPct = (count / (maxVal || 1)) * 100;
            html += `<div class="stats-bar">
              <div class="stats-bar-header">
                <span class="stats-bar-label" title="${key}">${key}</span>
                <span class="stats-bar-value">${count.toLocaleString()} (${pct.toFixed(1)}%)</span>
              </div>
              <div class="stats-bar-track">
                <div class="stats-bar-fill" style="width:${barPct}%;background:${colors[i % colors.length]}"></div>
              </div>
            </div>`;
          });
          html += '</div>';
        }
        else if (msg && msg.includes("Columns for layer")) {
          html += `<div class="stats-summary-header">
            <span class="summary-title">${msg}</span>
          </div>`;
          
          html += '<table class="stats-table">';
          html += '<thead><tr><th>Column Name</th><th>Data Type</th></tr></thead><tbody>';
          Object.entries(d).forEach(([col, dtype]) => {
            html += `<tr>
              <td class="stat-col-name">${col}</td>
              <td class="stat-col-type">${dtype}</td>
            </tr>`;
          });
          html += '</tbody></table>';
        }
        else if (d.columns && d.geometry_types) {
          html += `<div class="stats-summary-header">
            <span class="summary-title">${msg}</span>
          </div>`;
          
          html += '<div class="stat-meta-grid">';
          html += `<div class="stat-meta-item"><span class="label">Total Features</span><span class="value">${(d.row_count || 0).toLocaleString()}</span></div>`;
          if (d.total_area_hectares) {
            html += `<div class="stat-meta-item"><span class="label">Total Area</span><span class="value">${d.total_area_hectares.toFixed(2)} ha</span></div>`;
          }
          html += `<div class="stat-meta-item"><span class="label">Geometry Types</span><span class="value">${d.geometry_types.join(', ')}</span></div>`;
          html += '</div>';
          
          html += '<div class="stat-section-title">Categorical Columns Summary</div>';
          if (d.categorical_unique_values) {
            Object.entries(d.categorical_unique_values).forEach(([col, valCounts]) => {
              html += `<details class="stat-details">
                <summary>${col} (${Object.keys(valCounts).length} unique)</summary>
                <div class="details-content">`;
              Object.entries(valCounts).slice(0, 10).forEach(([k, v]) => {
                html += `<div class="details-row"><span>${k}</span><span>${v}</span></div>`;
              });
              html += `</div></details>`;
            });
          }
        }
        else if (d.sample || d.affected_sample) {
          const sample = d.sample || d.affected_sample;
          html += `<div class="stats-summary-header">
            <span class="summary-title">${msg}</span>
          </div>`;
          
          if (d.affected_count !== undefined) {
            html += `<div class="stat-meta-grid">
              <div class="stat-meta-item"><span class="label">Target Count</span><span class="value">${d.target_count}</span></div>
              <div class="stat-meta-item"><span class="label">Affected Count</span><span class="value">${d.affected_count}</span></div>
              <div class="stat-meta-item"><span class="label">Buffer Distance</span><span class="value">${d.buffer_meters}m</span></div>
            </div>`;
          } else if (d.count !== undefined) {
            html += `<div class="stat-meta-grid">
              <div class="stat-meta-item"><span class="label">Features Count</span><span class="value">${d.count}</span></div>`;
            if (d.area_stats && d.area_stats.total_hectares) {
              html += `<div class="stat-meta-item"><span class="label">Total Area</span><span class="value">${d.area_stats.total_hectares.toFixed(2)} ha</span></div>`;
            }
            html += `</div>`;
          }
          
          if (sample && sample.length > 0) {
            html += '<div class="stat-section-title">Sample Attribute Table (Top 10)</div>';
            html += '<div class="table-responsive"><table class="stats-table">';
            const headers = Object.keys(sample[0]);
            html += '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
            sample.forEach(row => {
              html += '<tr>' + headers.map(h => `<td>${row[h] !== null ? row[h] : ''}</td>`).join('') + '</tr>';
            });
            html += '</tbody></table></div>';
          }
        }
        else {
          html += `<div class="stats-summary-header"><span class="summary-title">${msg}</span></div>`;
          html += '<table class="stats-table"><tbody>';
          Object.entries(d).forEach(([k, v]) => {
            if (typeof v !== 'object') {
              html += `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`;
            } else {
              html += `<tr><td><strong>${k}</strong></td><td><pre style="margin:0;font-size:9px;">${JSON.stringify(v)}</pre></td></tr>`;
            }
          });
          html += '</tbody></table>';
        }
      } else {
        html = `<div style="padding:16px;text-align:center;color:var(--fg);">${msg}</div>`;
      }
    }

    if (!html) {
      if (typeof data === 'string') {
        html = `<div style="white-space:pre-wrap;font-size:11px;">${data}</div>`;
      } else {
        html = `<pre style="font-size:10px;white-space:pre-wrap;word-break:break-all">${JSON.stringify(data, null, 2)}</pre>`;
      }
    }

    panel.innerHTML = html;
  }

  async function processMapAction(action) {
    if (!action || !map) return;

    try {
      if (action.target_center) {
        const [lat, lng] = action.target_center;
        const zoom = action.zoom_level || 14;
        map.flyTo([lat, lng], zoom, { duration: 1.2, easeLinearity: 0.25 });
      }

      const meta = action.highlight_geometries;
      if (meta && meta.bounding_box && meta.bounding_box.length === 4) {
        map.flyToBounds([[meta.bounding_box[0], meta.bounding_box[1]], [meta.bounding_box[2], meta.bounding_box[3]]], {
          padding: [40, 40],
          duration: 1.2,
          maxZoom: 16
        });
      } else if (action.bounding_box && action.bounding_box.length === 4) {
        map.flyToBounds([[action.bounding_box[0], action.bounding_box[1]], [action.bounding_box[2], action.bounding_box[3]]], {
          padding: [40, 40],
          duration: 1.2,
          maxZoom: 16
        });
      }

      if (meta && meta.layer) {
        const layerName = meta.layer;
        const attr = meta.filter_attribute;
        const val = meta.filter_value;
        
        // Auto-load layer if not active
        if (!activeLayers[layerName]) {
          await loadLayerToMap(layerName);
        }
        const activeLayer = activeLayers[layerName];

        if (activeLayer) {
          if (attr && val) {
            let matchCount = 0;
            const filterLayer = (featureLayer) => {
              if (featureLayer.feature && featureLayer.feature.properties) {
                const propVal = featureLayer.feature.properties[attr];
                if (propVal && String(propVal).toLowerCase().includes(String(val).toLowerCase())) {
                  matchCount++;
                  const ecoHighlight = '#22c55e'; // Green highlight for Eco Green theme
                  if (featureLayer.feature.geometry.type === 'LineString' || featureLayer.feature.geometry.type === 'MultiLineString') {
                    featureLayer.setStyle({
                      color: ecoHighlight,
                      weight: 4,
                      opacity: 1
                    });
                  } else {
                    featureLayer.setStyle({
                      fillColor: ecoHighlight,
                      color: '#E6F4EA',
                      weight: 1.5,
                      fillOpacity: 0.8,
                      opacity: 1
                    });
                  }
                  if (featureLayer.bringToFront) featureLayer.bringToFront();
                } else {
                  const mutedColor = '#1e2228';
                  if (featureLayer.feature.geometry.type === 'LineString' || featureLayer.feature.geometry.type === 'MultiLineString') {
                    featureLayer.setStyle({
                      color: mutedColor,
                      weight: 1,
                      opacity: 0.3
                    });
                  } else {
                    featureLayer.setStyle({
                      fillColor: mutedColor,
                      color: mutedColor,
                      weight: 0.5,
                      fillOpacity: 0.15,
                      opacity: 0.2
                    });
                  }
                }
              } else if (featureLayer.eachLayer) {
                featureLayer.eachLayer(filterLayer);
              }
            };

            activeLayer.eachLayer(filterLayer);
            
            if (matchCount > 0) {
              $('#featureCount').textContent = matchCount.toLocaleString();
              return;
            }
          } else {
            // No filter attribute
            return;
          }
        }
      }

      if (action.geojson) {
        renderGeoJSON(action.geojson, action.highlight_geometries);
      }
    } catch (e) {
      console.error('Map action error:', e);
    }
  }

  function renderGeoJSON(geojson, meta) {
    if (!geojson || !geojson.features || geojson.features.length === 0) return;

    let layerName = (meta && meta.layer) || 'result';
    const geoLayer = createStyledGeoJSON(geojson, layerName);
    
    geoLayer.setStyle(function (feature) {
      const color = getFeatureColor(layerName, feature.properties);
      const gt = feature.geometry.type;
      if (gt === 'LineString' || gt === 'MultiLineString') {
        return { color: '#ff4444', weight: 4, opacity: 0.95 };
      }
      return {
        fillColor: color,
        fillOpacity: 0.45,
        color: '#ffffff',
        weight: 2,
        opacity: 0.9
      };
    });

    highlightLayer.addLayer(geoLayer);

    try {
      const bounds = geoLayer.getBounds();
      if (bounds.isValid()) {
        map.flyToBounds(bounds, { padding: [40, 40], duration: 1.2, maxZoom: 16 });
      }
    } catch (e) {}

    $('#featureCount').textContent = geojson.features.length.toLocaleString();
  }

  async function loadLayerToMap(layerName) {
    if (dynamicLayers.includes(layerName)) {
      if (!activeLayers[layerName]) {
        activeLayers[layerName] = L.layerGroup().addTo(baseLayerGroup);
      }
      
      const sidebarItem = document.querySelector(`.sidebar-item[data-layer="${layerName}"]`);
      if (sidebarItem) sidebarItem.classList.add('active');
      
      await loadLayerViewport(layerName);
      return;
    }

    try {
      setStatus(`Loading ${layerName}...`, 'var(--warn)');
      const res = await fetch(`${API_BASE}/api/layer/${layerName}/geojson`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.status === 'success' && data.geojson) {
        const geoLayer = createStyledGeoJSON(data.geojson, layerName);

        if (activeLayers[layerName]) {
          baseLayerGroup.removeLayer(activeLayers[layerName]);
        }
        activeLayers[layerName] = geoLayer;
        baseLayerGroup.addLayer(geoLayer);

        updateLayerControls();

        const sidebarItem = document.querySelector(`.sidebar-item[data-layer="${layerName}"]`);
        if (sidebarItem) sidebarItem.classList.add('active');

        showNotification(`Loaded ${layerName} layer`, 'success');
        
        if (layerName === 'zoning') {
          const bounds = geoLayer.getBounds();
          if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [20, 20] });
          }
        }
      }
      setStatus('Ready', 'var(--green)');
    } catch (e) {
      showNotification(`Failed to load ${layerName}: ${e.message}`, 'error');
      setStatus('Ready', 'var(--green)');
    }
  }

  function updateLayerControls() {
    const container = $('#layerControls');
    container.innerHTML = '';

    Object.entries(activeLayers).forEach(([name, layer]) => {
      const div = document.createElement('div');
      div.className = 'layer-toggle active';
      div.innerHTML = `<div class="layer-color" style="background:${layerColors[name] || '#abb2bf'}"></div>${name}`;
      div.addEventListener('click', () => {
        const sidebarItem = document.querySelector(`.sidebar-item[data-layer="${name}"]`);
        if (map.hasLayer(layer)) {
          baseLayerGroup.removeLayer(layer);
          div.classList.remove('active');
          if (sidebarItem) sidebarItem.classList.remove('active');
          loadedBounds[name] = null; // Clear bounds cache when deactivated!
          cachedGeoJSON[name] = null;
          loadedZoom[name] = null;
        } else {
          baseLayerGroup.addLayer(layer);
          div.classList.add('active');
          if (sidebarItem) sidebarItem.classList.add('active');
        }
        updateLegend();
      });
      container.appendChild(div);
    });
    updateLegend();
  }

  function updateLegend() {
    const legendEl = $('#mapLegend');
    if (!legendEl) return;

    let html = '';
    let hasActiveLayers = false;

    const legendData = {
      building: {
        title: 'Buildings',
        items: [
          { color: '#e06c75', label: 'Residential' },
          { color: '#61afef', label: 'Commercial & Retail' },
          { color: '#e5c07b', label: 'Educational' },
          { color: '#c678dd', label: 'Religious' },
          { color: '#d19a66', label: 'Industrial' },
          { color: '#56b6c2', label: 'Institutional / Gov' },
          { color: '#888888', label: 'Other' }
        ]
      },
      land_use: {
        title: 'Land Use',
        items: [
          { color: '#e06c75', label: 'Residential' },
          { color: '#61afef', label: 'Commercial' },
          { color: '#50fa7b', label: 'Open Space / Park' },
          { color: '#56b6c2', label: 'Water Bodies' },
          { color: '#d19a66', label: 'Industrial' },
          { color: '#abb2bf', label: 'Road / Rail' },
          { color: '#888888', label: 'Other' }
        ]
      },
      zoning: {
        title: 'Zoning',
        items: [
          { color: '#e06c75', label: 'Residential' },
          { color: '#61afef', label: 'Commercial' },
          { color: '#c678dd', label: 'Mixed Use' },
          { color: '#d19a66', label: 'Industrial' },
          { color: '#50fa7b', label: 'Open Space / Recreation' },
          { color: '#888888', label: 'Other' }
        ]
      },
      road: {
        title: 'Roads',
        items: [
          { color: '#ff4444', label: 'Primary (Class A / Motorway / Trunk)' },
          { color: '#ffad44', label: 'Secondary / Tertiary (Class B)' },
          { color: '#abb2bf', label: 'Local / Other' }
        ]
      }
    };

    html += '<div class="legend-title">Map Legend</div>';

    Object.entries(activeLayers).forEach(([name, layer]) => {
      if (layer && map.hasLayer(layer) && legendData[name]) {
        hasActiveLayers = true;
        html += `<div class="legend-group">`;
        html += `<div class="legend-group-title">${legendData[name].title}</div>`;
        legendData[name].items.forEach(item => {
          html += `
            <div class="legend-item">
              <div class="legend-color-box" style="background:${item.color};"></div>
              <span>${item.label}</span>
            </div>
          `;
        });
        html += `</div>`;
      }
    });

    if (hasActiveLayers) {
      legendEl.innerHTML = html;
      legendEl.style.display = 'flex';
    } else {
      legendEl.style.display = 'none';
    }
  }

  async function sendMessage(message) {
    if (isStreaming || !message.trim()) return;

    isStreaming = true;
    const sendBtn = $('#sendBtn');
    const stopBtn = $('#stopBtn');
    
    sendBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');
    
    setStatus('Processing', 'var(--warn)');

    highlightLayer.clearLayers();
    resetAllNativeStyles();
    clearGisData();

    addMessage('user', message);

    chatHistory.push({ role: 'user', content: message });

    showTypingIndicator();

    let currentTextMsg = null;
    let accumulatedText = '';
    let _renderTimer = null;
    let statusIndicator = null;
    let thinkingBubble = null;

    const toolFriendlyNames = {
      'get_overview': 'Fetching spatial layers overview...',
      'get_layer_summary': 'Gathering layer metadata...',
      'get_layer_columns': 'Inspecting attribute schemas...',
      'get_unique_values': 'Querying unique attribute values...',
      'filter_features': 'Filtering spatial features...',
      'calculate_area_by_category': 'Calculating area by categories...',
      'proximity_analysis': 'Computing proximity buffer...',
      'spatial_intersection': 'Overlaying layer intersections...',
      'nearest_features': 'Locating nearest features...',
      'get_network_isochrone': 'Computing walking isochrones...',
      'get_walking_route': 'Calculating walking routes...',
      'zoning_compliance_check': 'Evaluating zoning compliance...'
    };

    function updateStatusIndicator(text) {
      removeTypingIndicator();
      if (!statusIndicator) {
        statusIndicator = document.createElement('div');
        statusIndicator.className = 'msg msg-status-indicator';
        statusIndicator.innerHTML = '<span class="pulse-dot"></span><span class="status-text"></span>';
        $('#chatMessages').appendChild(statusIndicator);
      }
      statusIndicator.querySelector('.status-text').textContent = text;
      scrollToBottom();
    }

    function removeStatusIndicator() {
      if (statusIndicator) {
        statusIndicator.remove();
        statusIndicator = null;
      }
    }

    try {
      chatAbortController = new AbortController();
      const signal = chatAbortController.signal;

      const provider = $('#providerSelect') ? $('#providerSelect').value : 'gemma-4-31b-it';
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history: chatHistory.slice(-10), provider }),
        signal: signal
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      removeTypingIndicator();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr);

            switch (event.type) {
              case 'thinking':
                removeTypingIndicator();
                removeStatusIndicator();
                if (!thinkingBubble) {
                  thinkingBubble = document.createElement('div');
                  thinkingBubble.className = 'msg-thinking-stream';
                  thinkingBubble.innerHTML = `
                    <div class="thinking-toggle expanded" id="thinkingToggle">
                      <span class="thinking-pulse"></span>
                      <span class="thinking-chevron">▶</span>
                      <span>Thinking...</span>
                    </div>
                    <div class="thinking-body expanded streaming" id="thinkingBody"></div>
                  `;
                  $('#chatMessages').appendChild(thinkingBubble);
                  thinkingBubble.querySelector('.thinking-toggle').addEventListener('click', () => {
                    const toggle = thinkingBubble.querySelector('.thinking-toggle');
                    const body = thinkingBubble.querySelector('.thinking-body');
                    toggle.classList.toggle('expanded');
                    body.classList.toggle('expanded');
                    body.classList.remove('streaming');
                  });
                }
                const thinkBody = thinkingBubble.querySelector('.thinking-body');
                if (thinkBody) {
                  thinkBody.textContent += event.content;
                  thinkBody.scrollTop = thinkBody.scrollHeight;
                }
                debouncedScrollToBottom();
                break;

              case 'tool_call': {
                removeTypingIndicator();
                removeStatusIndicator();
                const tc = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;
                const toolName = tc.name;
                const toolArgs = tc.args || {};
                const friendlyName = toolFriendlyNames[toolName] || `Running: ${toolName}`;
                if (thinkingBubble) {
                  const pulse = thinkingBubble.querySelector('.thinking-pulse');
                  if (pulse) pulse.classList.add('done');
                  const toggle = thinkingBubble.querySelector('.thinking-toggle');
                  const body = thinkingBubble.querySelector('.thinking-body');
                  if (toggle) toggle.classList.remove('expanded');
                  if (body) {
                    body.classList.remove('expanded');
                    body.classList.remove('streaming');
                  }
                }
                const toolCard = document.createElement('div');
                toolCard.className = 'tool-exec-card';
                const argsStr = Object.entries(toolArgs).map(([k,v]) => `${k}: ${v}`).join(', ');
                toolCard.innerHTML = `<span class="tool-icon"></span><span class="tool-name">${escapeHtml(toolName)}</span><span class="tool-args">${escapeHtml(argsStr)}</span>`;
                $('#chatMessages').appendChild(toolCard);
                debouncedScrollToBottom();
                setStatus(friendlyName, 'var(--warn)');
                break;
              }

              case 'tool_result':
                try {
                  const resultData = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;
                  if (resultData && (resultData.data || resultData.status)) {
                    updateStats(resultData);
                    if (resultData.map_action) {
                      await processMapAction(resultData.map_action);
                    }
                  }
                } catch (e) {}
                break;

              case 'text':
                removeStatusIndicator();
                if (thinkingBubble) {
                  const pulse = thinkingBubble.querySelector('.thinking-pulse');
                  if (pulse) pulse.classList.add('done');
                  const toggle = thinkingBubble.querySelector('.thinking-toggle');
                  const body = thinkingBubble.querySelector('.thinking-body');
                  if (toggle) toggle.classList.remove('expanded');
                  if (body) {
                    body.classList.remove('expanded');
                    body.classList.remove('streaming');
                  }
                  thinkingBubble = null;
                }
                if (!currentTextMsg) {
                  currentTextMsg = createStreamingMessage('text');
                }
                accumulatedText += event.content;
                if (!_renderTimer) {
                  const msgEl = currentTextMsg;
                  _renderTimer = requestAnimationFrame(() => {
                    _renderTimer = null;
                    if (!msgEl) return;
                    try {
                      msgEl.innerHTML = DOMPurify.sanitize(marked.parse(accumulatedText, { breaks: true, gfm: true }));
                    } catch {
                      msgEl.textContent = accumulatedText;
                    }
                  });
                }
                debouncedScrollToBottom();
                break;

              case 'map_action': {
                const mapAction = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;
                await processMapAction(mapAction);
                break;
              }

              case 'error':
                removeStatusIndicator();
                addMessage('error', event.content);
                break;

              case 'done':
                removeStatusIndicator();
                // Flush any pending render so final text is visible
                if (_renderTimer) {
                  cancelAnimationFrame(_renderTimer);
                  _renderTimer = null;
                }
                if (currentTextMsg && accumulatedText) {
                  try {
                    currentTextMsg.innerHTML = DOMPurify.sanitize(marked.parse(accumulatedText, { breaks: true, gfm: true }));
                  } catch {
                    currentTextMsg.textContent = accumulatedText;
                  }
                }
                if (thinkingBubble) {
                  const pulse = thinkingBubble.querySelector('.thinking-pulse');
                  if (pulse) pulse.classList.add('done');
                  const body = thinkingBubble.querySelector('.thinking-body');
                  if (body) {
                    body.classList.remove('streaming');
                  }
                  thinkingBubble = null;
                }
                scrollToBottom();
                break;
            }
          } catch (e) {
            console.warn('SSE parse error:', e, jsonStr);
          }
        }
      }
    } catch (e) {
      removeTypingIndicator();
      removeStatusIndicator();
      if (e.name === 'AbortError' || (chatAbortController && chatAbortController.signal.aborted)) {
        addMessage('error', 'Generation stopped by user.');
        showNotification('Generation stopped', 'info');
      } else {
        addMessage('error', `Connection error: ${e.message}`);
        showNotification('Failed to connect to server', 'error');
      }
    } finally {
      isStreaming = false;
      sendBtn.disabled = false;
      sendBtn.classList.remove('hidden');
      if (stopBtn) stopBtn.classList.add('hidden');
      setStatus('Ready', 'var(--green)');
      removeStatusIndicator();
      if (accumulatedText) {
        chatHistory.push({ role: 'assistant', content: accumulatedText });
      }
    }
  }

  function initEventHandlers() {
    const chatInput = $('#chatInput');
    const sendBtn = $('#sendBtn');
    const stopBtn = $('#stopBtn');

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        if (chatAbortController) {
          chatAbortController.abort();
        }
      });
    }

    sendBtn.addEventListener('click', () => {
      const msg = chatInput.value.trim();
      if (msg) {
        sendMessage(msg);
        chatInput.value = '';
        autoResize(chatInput);
      }
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    chatInput.addEventListener('input', () => autoResize(chatInput));

    $$('.welcome-prompt').forEach(el => {
      el.addEventListener('click', () => {
        const prompt = el.dataset.prompt;
        if (prompt) {
          chatInput.value = prompt;
          sendBtn.click();
        }
      });
    });

    $$('.quick-action-btn').forEach(el => {
      el.addEventListener('click', () => {
        const prompt = el.dataset.prompt;
        if (prompt) {
          chatInput.value = prompt;
          sendBtn.click();
        }
      });
    });

    $('#btnClearChat').addEventListener('click', () => {
      chatHistory = [];
      const msgs = $('#chatMessages');
      msgs.innerHTML = '';
      highlightLayer.clearLayers();
      clearGisData();
      showNotification('Chat cleared', 'info');
    });

    $('#btnLoadLayers').addEventListener('click', async () => {
      showNotification('Loading all layers...', 'info');
      setStatus('Loading', 'var(--warn)');
      for (const name of ['building', 'land_use', 'zoning', 'road']) {
        await loadLayerToMap(name);
      }
      setStatus('Ready', 'var(--green)');
    });

    $('#btnResetView').addEventListener('click', () => {
      map.flyTo([6.92, 79.865], 13, { duration: 1 });
      highlightLayer.clearLayers();
      showNotification('Map view reset', 'info');
    });

    $$('.sidebar-item[data-layer]').forEach(item => {
      item.addEventListener('click', () => {
        const layerName = item.dataset.layer;
        if (activeLayers[layerName]) {
          if (map.hasLayer(activeLayers[layerName])) {
            baseLayerGroup.removeLayer(activeLayers[layerName]);
            delete activeLayers[layerName];
            loadedBounds[layerName] = null; // Clear bounds cache when deactivated!
            cachedGeoJSON[layerName] = null;
            loadedZoom[layerName] = null;
            item.classList.remove('active');
            updateLayerControls();
            showNotification(`Removed ${layerName} layer`, 'info');
          } else {
            baseLayerGroup.addLayer(activeLayers[layerName]);
            item.classList.add('active');
            updateLayerControls();
          }
        } else {
          loadLayerToMap(layerName);
        }
      });
    });

    // GIS controls event handlers
    const btn3D = $('#btnGIS3D');
    if (btn3D) {
      btn3D.addEventListener('click', () => {
        enable3DBuildings = !enable3DBuildings;
        btn3D.classList.toggle('active', enable3DBuildings);
        showNotification(enable3DBuildings ? '3D Buildings Extrusion Enabled' : '3D Buildings Extrusion Disabled', 'info');
        
        if (enable3DBuildings) {
          if (!activeLayers['building']) {
            loadLayerToMap('building');
          } else {
            loadLayerViewport('building');
          }
          if (map && map.getZoom() < 16) {
            map.setZoom(16);
            showNotification('Zoomed in to level 16 to render 3D structures', 'info');
          }
        } else {
          if (activeLayers['building']) {
            loadLayerViewport('building');
          }
        }
      });
    }

    const btnRoute = $('#btnGISRoute');
    if (btnRoute) {
      btnRoute.addEventListener('click', () => {
        if (activeGisTool === 'route') {
          activeGisTool = null;
          btnRoute.classList.remove('active');
          $('#map').style.cursor = '';
        } else {
          activeGisTool = 'route';
          $$('.gis-btn').forEach(b => b.id !== 'btnGIS3D' && b.classList.remove('active'));
          btnRoute.classList.add('active');
          $('#map').style.cursor = 'crosshair';
          clearGisData();
          showNotification('Click start point for walking route', 'info');
        }
      });
    }

    const btnIso = $('#btnGISIsochrone');
    if (btnIso) {
      btnIso.addEventListener('click', () => {
        if (activeGisTool === 'isochrone') {
          activeGisTool = null;
          btnIso.classList.remove('active');
          $('#map').style.cursor = '';
        } else {
          activeGisTool = 'isochrone';
          $$('.gis-btn').forEach(b => b.id !== 'btnGIS3D' && b.classList.remove('active'));
          btnIso.classList.add('active');
          $('#map').style.cursor = 'crosshair';
          clearGisData();
          showNotification('Click center point to calculate reachability isochrone', 'info');
        }
      });
    }

    const btnClear = $('#btnGISClear');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        clearGisData();
        activeGisTool = null;
        $$('.gis-btn').forEach(b => b.id !== 'btnGIS3D' && b.classList.remove('active'));
        $('#map').style.cursor = '';
        showNotification('GIS layers cleared', 'info');
      });
    }

    const btnDownload = $('#btnGISDownload');
    if (btnDownload) {
      btnDownload.addEventListener('click', async () => {
        let features = [];
        const extractGeoJSON = (layer) => {
          if (layer.toGeoJSON) {
            let gj = layer.toGeoJSON();
            if (gj.type === 'FeatureCollection') {
              features.push(...gj.features);
            } else if (gj.type === 'Feature') {
              features.push(gj);
            }
          }
        };

        highlightLayer.eachLayer(layer => {
          if (layer.eachLayer) layer.eachLayer(extractGeoJSON);
          else extractGeoJSON(layer);
        });

        gisLayers.eachLayer(layer => {
          if (layer.eachLayer) layer.eachLayer(extractGeoJSON);
          else extractGeoJSON(layer);
        });

        if (features.length === 0) {
          showNotification('No active spatial queries on map to download.', 'error');
          return;
        }

        showNotification('Preparing shapefile download...', 'info');
        setStatus('Exporting...', 'var(--warn)');
        
        try {
          const res = await fetch(`${API_BASE}/api/download_shp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geojson: { type: 'FeatureCollection', features: features } })
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'aether_export.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);
          showNotification('Download complete', 'success');
        } catch (e) {
          showNotification(`Export failed: ${e.message}`, 'error');
        } finally {
          setStatus('Ready', 'var(--green)');
        }
      });
    }

    // Isochrone modal handlers
    const isoConfirm = $('#isochroneConfirm');
    const isoCancel = $('#isochroneCancel');
    if (isoConfirm) {
      isoConfirm.addEventListener('click', () => {
        const modal = $('#isochroneModal');
        const input = $('#isochroneMinutes');
        const minutes = parseInt(input ? input.value : '10', 10);
        if (modal) modal.classList.add('hidden');
        if (isNaN(minutes) || minutes <= 0 || minutes > 60) {
          showNotification('Invalid walk time (1-60 minutes)', 'warning');
          return;
        }
        if (pendingIsochroneLatLng) {
          calculateIsochrone(pendingIsochroneLatLng, minutes);
          pendingIsochroneLatLng = null;
        }
      });
    }
    if (isoCancel) {
      isoCancel.addEventListener('click', () => {
        const modal = $('#isochroneModal');
        if (modal) modal.classList.add('hidden');
        pendingIsochroneLatLng = null;
      });
    }
  }

  function animateLoader() {
    const el = $('#loader-wave');
    if (!el) return;
    const frames = ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▅', '▆▅▄', '▅▄▃', '▄▃▂', '▃▂▁'];
    let i = 0;
    const interval = setInterval(() => {
      const loader = $('#app-loader');
      if (!loader) {
        clearInterval(interval);
        return;
      }
      el.textContent = frames[i % frames.length];
      i++;
    }, 150);
  }

  function initSidebarControls() {
    const hamburger = $('#hamburger-btn');
    const sidebar = $('#sidebar');
    
    if (hamburger && sidebar) {
      hamburger.addEventListener('click', () => {
        sidebar.classList.toggle('hidden');
        setTimeout(() => {
          if (map) map.invalidateSize();
        }, 300);
      });
    }

    const railButtons = {
      'rail-chats': 'panel-chats-content',
      'rail-layers': 'panel-layers-content'
    };

    Object.entries(railButtons).forEach(([btnId, panelId]) => {
      const btn = $(`#${btnId}`);
      if (btn) {
        btn.addEventListener('click', () => {
          if (sidebar && sidebar.classList.contains('hidden')) {
            sidebar.classList.remove('hidden');
            setTimeout(() => {
              if (map) map.invalidateSize();
            }, 300);
          }

          $$('.icon-rail-btn').forEach(b => b.classList.remove('active-section'));
          btn.classList.add('active-section');

          $$('.sidebar-panel-content').forEach(p => {
            p.classList.remove('active');
            p.classList.add('hidden');
          });
          const targetPanel = $(`#${panelId}`);
          if (targetPanel) {
            targetPanel.classList.add('active');
            targetPanel.classList.remove('hidden');
          }
        });
      }
    });

    const searchBtn = $('#rail-search-btn') || $('#rail-search');
    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        showNotification('Search is simulated', 'info');
      });
    }

    const newChatBtn = $('#rail-new-chat');
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        const btnClear = $('#btnClearChat');
        if (btnClear) btnClear.click();
      });
    }

    const resetViewBtn = $('#rail-reset-view');
    if (resetViewBtn) {
      resetViewBtn.addEventListener('click', () => {
        const btnReset = $('#btnResetView');
        if (btnReset) btnReset.click();
      });
    }
    
    const settingsBtn = $('#rail-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        showNotification('Settings panel is simulated', 'info');
      });
    }
  }

  function initApp() {
    animateLoader();
    initMap();
    initResizeHandle();
    initEventHandlers();
    initSidebarControls();

    setTimeout(() => {
      const loader = $('#app-loader');
      if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 300);
      }
    }, 1200);

    fetch(`${API_BASE}/api/layers`)
      .then(r => r.json())
      .then(async data => {
        if (data.status === 'success' && data.data) {
          let totalFeatures = 0;
          if (data.data.layers_list) {
            data.data.layers_list.forEach(l => { totalFeatures += l.count || 0; });
          }
          if (totalFeatures > 0) {
            $('#featureCount').textContent = totalFeatures.toLocaleString();
          }
          if (data.data.center && Array.isArray(data.data.center)) {
            map.setView(data.data.center, 15);
          }
        }
        // Load default layers (building and road) on startup
        await loadLayerToMap('building');
        await loadLayerToMap('road');
      })
      .catch(async () => {
        // Fallback if layers api fails
        await loadLayerToMap('building');
        await loadLayerToMap('road');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
