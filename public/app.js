// =====================================================
// AppCarro — Frontend 100% estático (sin backend)
// - Proyectos múltiples (localStorage) + export/import JSON
// - Calibra (ΔAH promedio circular + ΔAV promedio)
// - Calcula puntos, exporta TXT/CSV/GeoJSON
// - Mini-mapa: (1) extents (sin mapa), (2) imagen+worldfile, (3) KMZ GroundOverlay
// - CRS por defecto: EPSG:32719
// =====================================================

const $ = (id) => document.getElementById(id);

// ---------- LocalStorage keys ----------
const LS_PROJECTS = "appcarro_projects_v1";
const LS_ACTIVE = "appcarro_active_project_v1";

// ---------- App state ----------
const state = {
  projects: [],          // list of project objects (raw, storage friendly)
  activeId: null,        // active project id
  config: null,          // normalized config for current project
  calibration: null,     // calibration for current project
  points: [],            // points for current project
  nextId: 1,             // next ID for points
  crs: "EPSG:32719",     // coordinate system for points
  map: {                 // map state
    mode: "extents",     // "extents" | "image_wld" | "kmz"
    imageUrl: null,      // ObjectURL for background image (kmz/img)
    bbox4326: null,      // for kmz: {north,south,east,west} WGS84
    world: null,         // for worldfile: {A,D,B,E,C,F}
    imgSize: null,       // {w,h} intrinsic image size
    fit: true,
  },
};

// ---------- UI helpers ----------
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function parseNum(str) {
  if (str === null || str === undefined) return NaN;
  return Number(String(str).trim().replace(",", "."));
}

function fmt(n, d = 3) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return n.toFixed(d);
}

function fmtSigned(n, d = 4) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(d) + "°";
}

function isoNow() {
  return new Date().toISOString();
}

function uid(prefix = "prj") {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}_${r}`;
}

// =====================================================
// Geomensura core (JS)
// Convención: 0°=Norte(+Y), 90°=Este(+X)
// AV: inclinación respecto a horizontal (+ arriba)
// =====================================================
const d2r = (deg) => deg * Math.PI / 180;
const r2d = (rad) => rad * 180 / Math.PI;
const wrap360 = (a) => ((a % 360) + 360) % 360;
const wrap180 = (a) => ((a + 180) % 360) - 180;

function meanAngleDeg(anglesDeg) {
  let s = 0, c = 0;
  for (const a of anglesDeg) {
    const ar = d2r(a);
    s += Math.sin(ar);
    c += Math.cos(ar);
  }
  if (Math.abs(s) < 1e-12 && Math.abs(c) < 1e-12) return 0;
  return wrap360(r2d(Math.atan2(s, c)));
}

function azimutXY(cam, pt) {
  const dx = pt.X - cam.X;
  const dy = pt.Y - cam.Y;
  return wrap360(r2d(Math.atan2(dx, dy)));
}

function inclinacion(cam, pt) {
  const dx = pt.X - cam.X;
  const dy = pt.Y - cam.Y;
  const dz = pt.Z - cam.Z;
  const dh = Math.hypot(dx, dy);
  return r2d(Math.atan2(dz, dh));
}

function calcXYZ(cam, ahDeg, avDeg, dist) {
  const ah = d2r(ahDeg);
  const av = d2r(avDeg);
  const dh = dist * Math.cos(av);
  const dz = dist * Math.sin(av);
  const dx = dh * Math.sin(ah); // Este
  const dy = dh * Math.cos(ah); // Norte
  return { X: cam.X + dx, Y: cam.Y + dy, Z: cam.Z + dz };
}

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("Config inválida");

  const cam = cfg.camera || {};
  const camera = { X: parseNum(cam.X), Y: parseNum(cam.Y), Z: parseNum(cam.Z) };
  if (![camera.X, camera.Y, camera.Z].every(Number.isFinite)) {
    throw new Error("Cámara inválida (X/Y/Z)");
  }

  const ptsIn = Array.isArray(cfg.collimation_points) ? cfg.collimation_points : [];
  if (ptsIn.length < 2) throw new Error("Se requieren al menos 2 puntos de colimación.");

  const collimation_points = ptsIn.map((p, i) => {
    const out = {
      name: String(p.name ?? `PT${i + 1}`),
      X: parseNum(p.X),
      Y: parseNum(p.Y),
      Z: parseNum(p.Z),
      AH_obs: parseNum(p.AH_obs),
      AV_obs: parseNum(p.AV_obs),
      D_obs: Number.isFinite(parseNum(p.D_obs)) ? parseNum(p.D_obs) : 0,
    };
    const ok = [out.X, out.Y, out.Z, out.AH_obs, out.AV_obs].every(Number.isFinite);
    if (!ok) throw new Error(`Punto colimación inválido: ${out.name}`);
    return out;
  });

  return { camera, collimation_points };
}

function calibrate(cfg) {
  const cam = cfg.camera;
  const pts = cfg.collimation_points;

  const deltasAh = [];
  const deltasAv = [];
  const diagnostics = [];

  for (const p of pts) {
    const ahReal = azimutXY(cam, p);
    const avReal = inclinacion(cam, p);

    const dAH = wrap180(ahReal - p.AH_obs);
    const dAV = avReal - p.AV_obs;

    deltasAh.push(dAH);
    deltasAv.push(dAV);

    const dx = p.X - cam.X, dy = p.Y - cam.Y, dz = p.Z - cam.Z;
    const distGeom = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const distRes = distGeom - (p.D_obs ?? 0);

    diagnostics.push({ name: p.name, dAH, dAV, Dist_res: distRes });
  }

  // Promedio circular para ΔAH
  const deltas0360 = deltasAh.map(wrap360);
  let ajusteAh = meanAngleDeg(deltas0360);
  ajusteAh = wrap180(ajusteAh);

  // Promedio simple para ΔAV
  const ajusteAv = deltasAv.reduce((a, b) => a + b, 0) / deltasAv.length;

  return { ajuste_ah: ajusteAh, ajuste_av: ajusteAv, diagnostics, n_points: pts.length };
}

function computePoint(cfg, cal, AH_obs, AV_obs, D_obs) {
  const ahCorr = wrap360(AH_obs + cal.ajuste_ah);
  const avCorr = AV_obs + cal.ajuste_av;
  const xyz = calcXYZ(cfg.camera, ahCorr, avCorr, D_obs);

  return {
    X: xyz.X, Y: xyz.Y, Z: xyz.Z,
    AH_obs, AV_obs, D_obs,
    AH_corr: ahCorr, AV_corr: avCorr
  };
}

// =====================================================
// CRS & reprojection (UTM->WGS84)
// Requires proj4 loaded in index.html
// =====================================================
function ensureProjDefs() {
  if (typeof proj4 === "undefined") return;
  // Define EPSG:32719 explicitly (safe)
  if (!proj4.defs["EPSG:32719"]) {
    proj4.defs("EPSG:32719", "+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs");
  }
  if (!proj4.defs["EPSG:32718"]) {
    proj4.defs("EPSG:32718", "+proj=utm +zone=18 +south +datum=WGS84 +units=m +no_defs");
  }
  if (!proj4.defs["EPSG:4326"]) {
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");
  }
}

function toLonLat(x, y, crs) {
  if (crs === "EPSG:4326") return { lon: x, lat: y };
  ensureProjDefs();
  if (typeof proj4 === "undefined") throw new Error("proj4 no cargado (reproyección KMZ).");
  const [lon, lat] = proj4(crs, "EPSG:4326", [x, y]);
  return { lon, lat };
}

// =====================================================
// Render UI (calibration, points, projects, map)
// =====================================================
function setStatusError(msg) {
  $("badgeStatus").textContent = "Error";
  $("badgeStatus").style.color = "rgba(255,255,255,.92)";
  $("badgeStatus").style.borderColor = "rgba(255,107,107,.35)";
  $("badgeStatus").style.background = "rgba(255,107,107,.10)";
  $("kpiAh").textContent = "—";
  $("kpiAv").textContent = "—";
  $("cameraBox").innerHTML = "";
  $("diagTable").querySelector("tbody").innerHTML = "";
  if (msg) toast(msg);
}

function renderCalibration() {
  const cal = state.calibration;
  if (!cal) return;

  $("kpiAh").textContent = fmtSigned(cal.ajuste_ah, 4);
  $("kpiAv").textContent = fmtSigned(cal.ajuste_av, 4);

  $("badgeStatus").textContent = `OK • ${cal.n_points || 0} pts`;
  $("badgeStatus").style.color = "rgba(255,255,255,.86)";
  $("badgeStatus").style.borderColor = "rgba(69,212,131,.35)";
  $("badgeStatus").style.background = "rgba(69,212,131,.10)";

  const cam = state.config?.camera;
  if (cam) {
    $("cameraBox").innerHTML = `
      <div class="pill"><div class="k">X (Este)</div><div class="v">${fmt(cam.X, 4)}</div></div>
      <div class="pill"><div class="k">Y (Norte)</div><div class="v">${fmt(cam.Y, 3)}</div></div>
      <div class="pill"><div class="k">Z</div><div class="v">${fmt(cam.Z, 4)}</div></div>
    `;
  }

  const tbody = $("diagTable").querySelector("tbody");
  tbody.innerHTML = "";
  (cal.diagnostics || []).forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${d.name}</td>
      <td class="mono">${fmt(d.dAH, 3)}</td>
      <td class="mono">${fmt(d.dAV, 3)}</td>
      <td class="mono">${fmt(d.Dist_res, 3)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPoints() {
  const tbody = $("pointsTable").querySelector("tbody");
  tbody.innerHTML = "";

  state.points.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${p.ID}</td>
      <td class="mono">${fmt(p.X, 3)}</td>
      <td class="mono">${fmt(p.Y, 3)}</td>
      <td class="mono">${fmt(p.Z, 3)}</td>
      <td class="mono">${fmt(p.AH_corr, 4)}</td>
      <td class="mono">${fmt(p.AV_corr, 4)}</td>
      <td class="mono">${fmt(p.D_obs, 3)}</td>
      <td><button class="icon-btn" title="Eliminar" data-del="${p.ID}">🗑</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-del"));
      state.points = state.points.filter((x) => x.ID !== id);
      persistActiveProject();
      renderPoints();
      drawMap();
    });
  });
}

function renderProjectsSelect() {
  const sel = $("selProject");
  sel.innerHTML = "";
  state.projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    if (p.id === state.activeId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// =====================================================
// Map rendering
// - extents view (UTM coords)
// - image + worldfile (UTM coords)
// - kmz overlay (WGS84 bbox, reproject points to lon/lat)
// =====================================================
function canvas() {
  return $("mapCanvas");
}

function clearCanvas(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
}

function lonLatToPixel(lon, lat, bbox, w, h) {
  const { west, east, north, south } = bbox;
  const x = (lon - west) / (east - west) * w;
  const y = (north - lat) / (north - south) * h;
  return { x, y };
}

// World file model: Xgeo = A*col + B*row + C ; Ygeo = D*col + E*row + F
// Typically B=D=0, A=pixelSizeX, E=-pixelSizeY, C=xCenterTopLeft, F=yCenterTopLeft
function worldToPixel(x, y, wld) {
  const { A, B, C, D, E, F } = wld;
  // Solve:
  // x = A*col + B*row + C
  // y = D*col + E*row + F
  // Inverse 2x2:
  const det = A * E - B * D;
  if (Math.abs(det) < 1e-12) return null;
  const col = (E * (x - C) - B * (y - F)) / det;
  const row = (-D * (x - C) + A * (y - F)) / det;
  return { col, row };
}

async function drawBackgroundImage(ctx, imgUrl, w, h) {
  if (!imgUrl) return null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = imgUrl;
  await img.decode();
  ctx.drawImage(img, 0, 0, w, h);
  return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
}

function drawPointsAndLine(ctx, pixPts) {
  if (pixPts.length === 0) return;

  // polyline (orden ingreso)
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  pixPts.forEach((q, i) => {
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;

  // points
  pixPts.forEach((q) => {
    ctx.beginPath();
    ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawExtents(ctx, w, h) {
  const pts = state.points;
  clearCanvas(ctx, w, h);

  // Grid light
  ctx.globalAlpha = 0.18;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath(); ctx.moveTo(i * w / 10, 0); ctx.lineTo(i * w / 10, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * h / 10); ctx.lineTo(w, i * h / 10); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (!pts.length) return;

  const xs = pts.map(p => p.X), ys = pts.map(p => p.Y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const pad = 0.08;
  const dx = (maxX - minX) || 1;
  const dy = (maxY - minY) || 1;

  const x0 = minX - dx * pad, x1 = maxX + dx * pad;
  const y0 = minY - dy * pad, y1 = maxY + dy * pad;

  const toPix = (x, y) => ({
    x: (x - x0) / (x1 - x0) * w,
    y: (y1 - y) / (y1 - y0) * h
  });

  const pixPts = pts.map(p => toPix(p.X, p.Y));
  drawPointsAndLine(ctx, pixPts);
}

async function drawKmz(ctx, w, h) {
  clearCanvas(ctx, w, h);
  const m = state.map;
  if (!m.imageUrl || !m.bbox4326) {
    drawExtents(ctx, w, h);
    return;
  }

  await drawBackgroundImage(ctx, m.imageUrl, w, h);

  if (!state.points.length) return;

  const pixPts = [];
  for (const p of state.points) {
    const { lon, lat } = toLonLat(p.X, p.Y, state.crs);
    const q = lonLatToPixel(lon, lat, m.bbox4326, w, h);
    pixPts.push(q);
  }

  drawPointsAndLine(ctx, pixPts);
}

async function drawImageWorld(ctx, w, h) {
  clearCanvas(ctx, w, h);
  const m = state.map;

  // draw background if present
  if (m.imageUrl) {
    const imgSz = await drawBackgroundImage(ctx, m.imageUrl, w, h);
    if (imgSz) m.imgSize = imgSz;
  } else {
    drawExtents(ctx, w, h);
    return;
  }

  // without worldfile, just show extents overlay (approx)
  if (!m.world) {
    drawExtents(ctx, w, h);
    return;
  }

  // With worldfile: convert (X,Y) -> (col,row) -> to canvas pixels
  // We map image pixel space to canvas space linearly.
  const imgW = (m.imgSize?.w) || w;
  const imgH = (m.imgSize?.h) || h;

  const pixPts = [];
  for (const p of state.points) {
    const pr = worldToPixel(p.X, p.Y, m.world);
    if (!pr) continue;
    // pr.col/pr.row are in image pixel coords
    const x = (pr.col / imgW) * w;
    const y = (pr.row / imgH) * h;
    pixPts.push({ x, y });
  }
  drawPointsAndLine(ctx, pixPts);
}

async function drawMap() {
  const c = canvas();
  if (!c) return;
  const ctx = c.getContext("2d");
  // Basic style (inherits CSS colors if any)
  ctx.lineWidth = 2;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "rgba(255,255,255,0.65)";

  const w = c.width, h = c.height;

  try {
    if (state.map.mode === "kmz") await drawKmz(ctx, w, h);
    else if (state.map.mode === "image_wld") await drawImageWorld(ctx, w, h);
    else drawExtents(ctx, w, h);
  } catch (e) {
    console.error(e);
    drawExtents(ctx, w, h);
  }
}

// =====================================================
// Projects (multi)
// Each project stores: name, configRaw, points, nextId, crs, mapMeta
// =====================================================
function defaultProjectFromConfig(configRaw) {
  const id = uid("prj");
  return {
    id,
    name: `Proyecto ${new Date().toLocaleString()}`,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    crs: "EPSG:32719",
    configRaw, // raw JSON (for editor/export)
    points: [],
    nextId: 1,
    mapMeta: { mode: "extents", kmz: null, image: null, world: null }, // metadata only (no object urls)
  };
}

function loadProjectsFromLS() {
  try {
    const raw = localStorage.getItem(LS_PROJECTS);
    const active = localStorage.getItem(LS_ACTIVE);
    const list = raw ? JSON.parse(raw) : [];
    state.projects = Array.isArray(list) ? list : [];
    state.activeId = active || (state.projects[0]?.id ?? null);
  } catch {
    state.projects = [];
    state.activeId = null;
  }
}

function saveProjectsToLS() {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(state.projects));
  if (state.activeId) localStorage.setItem(LS_ACTIVE, state.activeId);
}

function getActiveProject() {
  return state.projects.find(p => p.id === state.activeId) || null;
}

function setActiveProject(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p) return;
  state.activeId = id;
  saveProjectsToLS();
  hydrateFromProject(p);
  renderProjectsSelect();
  toast(`Proyecto activo: ${p.name}`);
}

function persistActiveProject() {
  const p = getActiveProject();
  if (!p) return;

  p.updatedAt = isoNow();
  p.crs = state.crs;

  // keep raw config for editing/export
  // (if user edited config in modal, we store it there too)
  // state.config is normalized, so we store the last raw in p.configRaw if possible
  if (p.configRaw && typeof p.configRaw === "object") {
    // ok
  } else if (state.config) {
    // reconstruct minimal raw
    p.configRaw = {
      camera: { ...state.config.camera },
      collimation_points: state.config.collimation_points.map(x => ({ ...x }))
    };
  }

  p.points = state.points.map(x => ({ ...x }));
  p.nextId = state.nextId;

  // map metadata (no blob URLs)
  p.mapMeta = p.mapMeta || { mode: "extents", kmz: null, image: null, world: null };
  p.mapMeta.mode = state.map.mode;
  p.mapMeta.world = state.map.world ? { ...state.map.world } : null;

  saveProjectsToLS();
}

function hydrateFromProject(p) {
  try {
    state.crs = p.crs || "EPSG:32719";
    if ($("selCrs")) $("selCrs").value = state.crs;

    state.points = Array.isArray(p.points) ? p.points.map(x => ({ ...x })) : [];
    state.nextId = Number.isFinite(p.nextId) ? p.nextId : (state.points.length + 1);

    // normalize config from raw
    state.config = normalizeConfig(p.configRaw);
    state.calibration = calibrate(state.config);

    renderCalibration();
    renderPoints();

    // reset map runtime urls (must be reloaded by user)
    state.map.mode = (p.mapMeta?.mode) || "extents";
    state.map.world = p.mapMeta?.world ? { ...p.mapMeta.world } : null;
    state.map.imageUrl = null;
    state.map.bbox4326 = null;
    state.map.imgSize = null;

    drawMap();
  } catch (e) {
    console.error(e);
    setStatusError("Proyecto inválido. Revisa Config.");
  }
}

// =====================================================
// Static config.json bootstrap (creates first project)
// =====================================================
async function fetchConfigJson() {
  const r = await fetch("./config.json", { cache: "no-store" });
  if (!r.ok) throw new Error("No se pudo cargar config.json");
  return await r.json();
}

async function bootstrap() {
  try {
    // Load projects from LS
    loadProjectsFromLS();

    // If no projects, create one from config.json
    if (!state.projects.length) {
      const cfg = await fetchConfigJson();
      const prj = defaultProjectFromConfig(cfg);
      state.projects = [prj];
      state.activeId = prj.id;
      saveProjectsToLS();
    }

    renderProjectsSelect();

    // Hydrate active project
    const active = getActiveProject() || state.projects[0];
    state.activeId = active.id;
    saveProjectsToLS();
    hydrateFromProject(active);

    toast("Listo: proyecto cargado.");
  } catch (e) {
    console.error(e);
    setStatusError("No se pudo iniciar. Revisa public/config.json");
  }
}

// =====================================================
// Actions (calibration, add point, exports)
// =====================================================
function calibrateNow() {
  try {
    if (!state.config) throw new Error("Sin config");
    state.calibration = calibrate(state.config);
    renderCalibration();
    persistActiveProject();
    toast("Recalibración OK.");
  } catch (e) {
    console.error(e);
    setStatusError("Error recalibrando. Revisa puntos de colimación.");
  }
}

function addPoint() {
  const ah = parseNum($("inAh").value);
  const av = parseNum($("inAv").value);
  const d = parseNum($("inD").value);

  if (![ah, av, d].every(Number.isFinite)) {
    toast("Revisa AH/AV/Distancia (números válidos).");
    return;
  }
  if (!state.config || !state.calibration) {
    toast("No hay calibración. Revisa Config.");
    return;
  }

  try {
    const r = computePoint(state.config, state.calibration, ah, av, d);
    const p = {
      ID: state.nextId++,
      X: r.X, Y: r.Y, Z: r.Z,
      AH_obs: r.AH_obs, AV_obs: r.AV_obs, D_obs: r.D_obs,
      AH_corr: r.AH_corr, AV_corr: r.AV_corr
    };
    state.points.push(p);
    persistActiveProject();
    renderPoints();
    drawMap();
    toast(`Punto ${p.ID} agregado.`);
  } catch (e) {
    console.error(e);
    toast("No se pudo calcular el punto.");
  }
}

function exportTxt() {
  if (state.points.length === 0) return toast("No hay puntos para exportar.");

  const sepRaw = $("selSep").value;
  const sep = (sepRaw === "\\t") ? "\t" : sepRaw;
  const dec = $("selDec").value;
  const fnameIn = ($("inFile").value || "puntos_calculados.txt").trim();
  const fname = fnameIn.toLowerCase().endsWith(".txt") ? fnameIn : (fnameIn + ".txt");

  const headers = ["ID", "X", "Y", "Z", "AH_obs", "AV_obs", "D_obs", "AH_corr", "AV_corr"];

  const fmtDec = (num, nd) => {
    const s = Number(num).toFixed(nd);
    return dec === "," ? s.replace(".", ",") : s;
  };

  const lines = [headers.join(sep)];
  for (const p of state.points) {
    lines.push([
      String(p.ID),
      fmtDec(p.X, 3),
      fmtDec(p.Y, 3),
      fmtDec(p.Z, 3),
      fmtDec(p.AH_obs, 4),
      fmtDec(p.AV_obs, 4),
      fmtDec(p.D_obs, 3),
      fmtDec(p.AH_corr, 4),
      fmtDec(p.AV_corr, 4),
    ].join(sep));
  }

  downloadText(lines.join("\n") + "\n", fname, "text/plain;charset=utf-8");
  toast("TXT exportado.");
}

function exportCSV() {
  if (state.points.length === 0) return toast("No hay puntos para exportar.");
  // Uses same separator selection for Excel friendliness
  const sepRaw = $("selSep").value;
  const sep = (sepRaw === "\\t") ? "\t" : sepRaw;
  const dec = $("selDec").value;
  const fnameIn = ($("inFile").value || "puntos_calculados").trim().replace(/\.txt$/i, "");
  const fname = fnameIn.toLowerCase().endsWith(".csv") ? fnameIn : (fnameIn + ".csv");

  const headers = ["ID", "X", "Y", "Z", "AH_obs", "AV_obs", "D_obs", "AH_corr", "AV_corr"];

  const fmtDec = (num, nd) => {
    const s = Number(num).toFixed(nd);
    return dec === "," ? s.replace(".", ",") : s;
  };

  const lines = [headers.join(sep)];
  for (const p of state.points) {
    lines.push([
      String(p.ID),
      fmtDec(p.X, 3),
      fmtDec(p.Y, 3),
      fmtDec(p.Z, 3),
      fmtDec(p.AH_obs, 4),
      fmtDec(p.AV_obs, 4),
      fmtDec(p.D_obs, 3),
      fmtDec(p.AH_corr, 4),
      fmtDec(p.AV_corr, 4),
    ].join(sep));
  }

  downloadText(lines.join("\n") + "\n", fname, "text/csv;charset=utf-8");
  toast("CSV exportado.");
}

function exportGeoJSON() {
  if (state.points.length === 0) return toast("No hay puntos para exportar.");

  const fnameIn = ($("inFile").value || "puntos").trim().replace(/\.(txt|csv)$/i, "");
  const fname = fnameIn.toLowerCase().endsWith(".geojson") ? fnameIn : (fnameIn + ".geojson");

  // NOTE: Geometry is in your working CRS (UTM 19S by default). QGIS/ArcGIS can assign CRS on import.
  const fc = {
    type: "FeatureCollection",
    name: fname.replace(/\.geojson$/i, ""),
    crs: { type: "name", properties: { name: state.crs } },
    features: state.points.map(p => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.X, p.Y] },
      properties: {
        ID: p.ID,
        Z: p.Z,
        AH_obs: p.AH_obs,
        AV_obs: p.AV_obs,
        D_obs: p.D_obs,
        AH_corr: p.AH_corr,
        AV_corr: p.AV_corr
      }
    }))
  };

  downloadText(JSON.stringify(fc, null, 2), fname, "application/geo+json;charset=utf-8");
  toast("GeoJSON exportado.");
}

function clearPoints() {
  state.points = [];
  state.nextId = 1;
  persistActiveProject();
  renderPoints();
  drawMap();
  toast("Lista limpiada.");
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// =====================================================
// Modal Config (edits active project's configRaw)
// =====================================================
function openConfig() {
  $("modalConfig").classList.add("show");
  $("modalConfig").setAttribute("aria-hidden", "false");

  const p = getActiveProject();
  const raw = p?.configRaw ?? {
    camera: state.config?.camera ?? {},
    collimation_points: state.config?.collimation_points ?? []
  };

  $("configEditor").value = JSON.stringify(raw, null, 2);
}

function closeConfig() {
  $("modalConfig").classList.remove("show");
  $("modalConfig").setAttribute("aria-hidden", "true");
}

function saveConfig() {
  try {
    const txt = $("configEditor").value;
    const cfgRaw = JSON.parse(txt);
    const cfg = normalizeConfig(cfgRaw);

    // Save into active project
    const p = getActiveProject();
    if (!p) throw new Error("No hay proyecto activo");
    p.configRaw = cfgRaw;
    p.updatedAt = isoNow();

    // Hydrate state
    state.config = cfg;
    state.calibration = calibrate(state.config);

    saveProjectsToLS();
    renderCalibration();
    toast("Config guardada en el proyecto y recalibrada.");
    closeConfig();
  } catch (e) {
    console.error(e);
    toast("Config inválida. Revisa JSON y números.");
  }
}

async function reloadConfig() {
  try {
    const p = getActiveProject();
    if (!p) throw new Error("No hay proyecto activo");
    $("configEditor").value = JSON.stringify(p.configRaw, null, 2);
    toast("Config recargada desde el proyecto.");
  } catch (e) {
    console.error(e);
    toast("No se pudo recargar config.");
  }
}

// =====================================================
// Projects UI actions (new/save/export/import/select)
// =====================================================
function openProjectModal() {
  const p = getActiveProject();
  if (!p) return;
  $("modalProject").classList.add("show");
  $("modalProject").setAttribute("aria-hidden", "false");
  $("inProjectName").value = p.name || "";
}

function closeProjectModal() {
  $("modalProject").classList.remove("show");
  $("modalProject").setAttribute("aria-hidden", "true");
}

function newProject() {
  try {
    // Create from current config (keeps camera/collimation), points empty by default
    const pActive = getActiveProject();
    const rawCfg = pActive?.configRaw
      ?? { camera: state.config.camera, collimation_points: state.config.collimation_points };

    const prj = defaultProjectFromConfig(rawCfg);
    prj.name = `Nuevo proyecto — ${new Date().toLocaleString()}`;
    prj.crs = state.crs;

    state.projects.unshift(prj);
    state.activeId = prj.id;
    saveProjectsToLS();

    renderProjectsSelect();
    hydrateFromProject(prj);
    toast("Nuevo proyecto creado.");
    openProjectModal();
  } catch (e) {
    console.error(e);
    toast("No se pudo crear proyecto.");
  }
}

function saveProject() {
  persistActiveProject();
  toast("Proyecto guardado.");
}

function exportProject() {
  const p = getActiveProject();
  if (!p) return toast("No hay proyecto activo.");

  // build export payload with current runtime state
  persistActiveProject();
  const fresh = getActiveProject();

  const safe = JSON.parse(JSON.stringify(fresh));
  const nameSafe = (safe.name || "proyecto").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_");
  const fname = `${nameSafe || "AppCarro_proyecto"}.json`;

  downloadText(JSON.stringify(safe, null, 2), fname, "application/json;charset=utf-8");
  toast("Proyecto exportado.");
}

async function importProjectFromFile(file) {
  try {
    const txt = await file.text();
    const obj = JSON.parse(txt);

    if (!obj || typeof obj !== "object") throw new Error("JSON inválido");
    if (!obj.id) obj.id = uid("prj");
    if (!obj.name) obj.name = `Importado — ${new Date().toLocaleString()}`;
    if (!obj.configRaw) throw new Error("Proyecto sin configRaw.");
    // validate config
    normalizeConfig(obj.configRaw);

    // ensure fields
    obj.createdAt = obj.createdAt || isoNow();
    obj.updatedAt = isoNow();
    obj.points = Array.isArray(obj.points) ? obj.points : [];
    obj.nextId = Number.isFinite(obj.nextId) ? obj.nextId : (obj.points.length + 1);
    obj.crs = obj.crs || "EPSG:32719";
    obj.mapMeta = obj.mapMeta || { mode: "extents", kmz: null, image: null, world: null };

    // add to list (avoid id collision)
    if (state.projects.some(p => p.id === obj.id)) obj.id = uid("prj");

    state.projects.unshift(obj);
    state.activeId = obj.id;
    saveProjectsToLS();

    renderProjectsSelect();
    hydrateFromProject(obj);
    toast("Proyecto importado y activado.");
  } catch (e) {
    console.error(e);
    toast("Error importando proyecto.");
  }
}

// =====================================================
// KMZ + image/worldfile loaders
// Requires JSZip loaded in index.html
// =====================================================
async function loadKmzOverlay(file) {
  if (typeof JSZip === "undefined") throw new Error("JSZip no cargado (KMZ).");

  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const kmlCandidates = zip.file(/\.kml$/i);
  if (!kmlCandidates || !kmlCandidates.length) throw new Error("KMZ sin KML (.kml).");

  // Prefer doc.kml if present
  let kmlEntry = kmlCandidates.find(f => /doc\.kml$/i.test(f.name)) || kmlCandidates[0];
  const kmlText = await kmlEntry.async("text");

  const parser = new DOMParser();
  const xml = parser.parseFromString(kmlText, "application/xml");

  const ground = xml.querySelector("GroundOverlay");
  if (!ground) throw new Error("KMZ no trae GroundOverlay (necesito LatLonBox).");

  const href = ground.querySelector("Icon > href")?.textContent?.trim();
  if (!href) throw new Error("GroundOverlay sin Icon/href.");

  const north = parseFloat(ground.querySelector("LatLonBox > north")?.textContent);
  const south = parseFloat(ground.querySelector("LatLonBox > south")?.textContent);
  const east = parseFloat(ground.querySelector("LatLonBox > east")?.textContent);
  const west = parseFloat(ground.querySelector("LatLonBox > west")?.textContent);

  if (![north, south, east, west].every(Number.isFinite)) {
    throw new Error("LatLonBox incompleto (north/south/east/west).");
  }

  // Resolve image entry
  const hrefClean = href.replace(/^\.?\//, "");
  const imgEntry =
    zip.file(href) ||
    zip.file(hrefClean) ||
    zip.file(new RegExp(hrefClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"))?.[0];

  if (!imgEntry) throw new Error("No encontré la imagen referenciada por href dentro del KMZ.");

  const imgBlob = await imgEntry.async("blob");
  const imgUrl = URL.createObjectURL(imgBlob);

  return {
    type: "kmz",
    imageUrl: imgUrl,
    bbox4326: { north, south, east, west }
  };
}

async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  return { type: "image", imageUrl: url };
}

function parseWorldFileText(txt) {
  // Accept 6 lines: A, D, B, E, C, F
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 6) throw new Error("World file inválido (se requieren 6 líneas).");
  const vals = lines.slice(0, 6).map(parseNum);
  if (!vals.every(Number.isFinite)) throw new Error("World file inválido (números).");
  const [A, D, B, E, C, F] = vals;
  return { A, D, B, E, C, F };
}

async function loadWorldFile(file) {
  const txt = await file.text();
  return parseWorldFileText(txt);
}

// =====================================================
// Wire up
// =====================================================
window.addEventListener("DOMContentLoaded", () => {
  // base defaults
  ensureProjDefs();
  if ($("selCrs")) $("selCrs").value = state.crs;

  bootstrap();

  // Calibration / point ops
  $("btnCalibrate").addEventListener("click", calibrateNow);
  $("btnAddPoint").addEventListener("click", addPoint);
  $("btnExport").addEventListener("click", exportTxt);
  $("btnClear").addEventListener("click", clearPoints);

  // Export GIS
  $("btnExportGeoJSON")?.addEventListener("click", exportGeoJSON);
  $("btnExportCSV")?.addEventListener("click", exportCSV);

  // Config modal
  $("btnOpenConfig").addEventListener("click", openConfig);
  $("btnCloseConfig").addEventListener("click", closeConfig);
  $("btnSaveConfig").addEventListener("click", saveConfig);
  $("btnReloadConfig").addEventListener("click", reloadConfig);

  $("modalConfig").addEventListener("click", (ev) => {
    if (ev.target && ev.target.getAttribute("data-close") === "1") closeConfig();
  });

  // Projects: select + buttons
  $("selProject").addEventListener("change", (e) => setActiveProject(e.target.value));
  $("btnNewProject").addEventListener("click", newProject);
  $("btnSaveProject").addEventListener("click", saveProject);
  $("btnExportProject").addEventListener("click", exportProject);

  $("btnImportProject").addEventListener("click", () => $("fileImportProject").click());
  $("fileImportProject").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (f) await importProjectFromFile(f);
    e.target.value = "";
  });

  // Project modal open/close
  // (Open by clicking project select label? We'll use double-click on selector)
  $("selProject").addEventListener("dblclick", openProjectModal);
  $("btnCloseProject")?.addEventListener("click", closeProjectModal);
  $("btnCancelProject")?.addEventListener("click", closeProjectModal);

  $("modalProject")?.addEventListener("click", (ev) => {
    if (ev.target && ev.target.getAttribute("data-close") === "1") closeProjectModal();
  });

  $("btnSaveProjectName")?.addEventListener("click", () => {
    const p = getActiveProject();
    if (!p) return;
    p.name = ($("inProjectName").value || p.name || "Proyecto").trim();
    p.updatedAt = isoNow();
    saveProjectsToLS();
    renderProjectsSelect();
    toast("Nombre guardado.");
    closeProjectModal();
  });

  $("btnDuplicateProject")?.addEventListener("click", () => {
    const p = getActiveProject();
    if (!p) return;
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = uid("prj");
    copy.name = (p.name ? (p.name + " — copia") : "Copia");
    copy.createdAt = isoNow();
    copy.updatedAt = isoNow();
    state.projects.unshift(copy);
    state.activeId = copy.id;
    saveProjectsToLS();
    renderProjectsSelect();
    hydrateFromProject(copy);
    toast("Proyecto duplicado.");
    closeProjectModal();
    openProjectModal();
  });

  $("btnDeleteProject")?.addEventListener("click", () => {
    const p = getActiveProject();
    if (!p) return;
    if (!confirm(`¿Eliminar "${p.name}"?`)) return;

    state.projects = state.projects.filter(x => x.id !== p.id);
    if (!state.projects.length) {
      // keep at least one: recreate from config.json on next load
      localStorage.removeItem(LS_PROJECTS);
      localStorage.removeItem(LS_ACTIVE);
      location.reload();
      return;
    }

    state.activeId = state.projects[0].id;
    saveProjectsToLS();
    renderProjectsSelect();
    hydrateFromProject(getActiveProject());
    toast("Proyecto eliminado.");
    closeProjectModal();
  });

  // CRS selection affects kmz overlay reprojection
  $("selCrs")?.addEventListener("change", (e) => {
    state.crs = e.target.value;
    persistActiveProject();
    drawMap();
    toast(`CRS: ${state.crs}`);
  });

  // Map: load KMZ / image / world file / fit
  $("btnLoadKmz")?.addEventListener("click", () => $("fileKmz").click());
  $("fileKmz")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      // cleanup previous urls
      if (state.map.imageUrl) URL.revokeObjectURL(state.map.imageUrl);

      const ov = await loadKmzOverlay(f);
      state.map.mode = "kmz";
      state.map.imageUrl = ov.imageUrl;
      state.map.bbox4326 = ov.bbox4326;
      state.map.world = null;
      state.map.imgSize = null;
      persistActiveProject();
      await drawMap();
      toast("KMZ cargado (GroundOverlay).");
    } catch (err) {
      console.error(err);
      toast("No pude cargar KMZ (necesito GroundOverlay).");
    } finally {
      e.target.value = "";
    }
  });

  $("btnLoadImg")?.addEventListener("click", () => $("fileImg").click());
  $("fileImg")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (state.map.imageUrl) URL.revokeObjectURL(state.map.imageUrl);
      const img = await loadImageFile(f);
      state.map.mode = "image_wld";
      state.map.imageUrl = img.imageUrl;
      state.map.bbox4326 = null;
      state.map.imgSize = null;
      persistActiveProject();
      await drawMap();
      toast("Imagen cargada.");
    } catch (err) {
      console.error(err);
      toast("No pude cargar imagen.");
    } finally {
      e.target.value = "";
    }
  });

  $("btnLoadWld")?.addEventListener("click", () => $("fileWld").click());
  $("fileWld")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const wld = await loadWorldFile(f);
      state.map.mode = "image_wld";
      state.map.world = wld;
      persistActiveProject();
      await drawMap();
      toast("World file cargado.");
    } catch (err) {
      console.error(err);
      toast("World file inválido.");
    } finally {
      e.target.value = "";
    }
  });

  $("btnFitMap")?.addEventListener("click", async () => {
    // For now, fit just redraws; in extents it’s automatic.
    await drawMap();
    toast("Fit aplicado.");
  });

  // Enter para calcular (cuando estás en inputs)
  ["inAh", "inAv", "inD"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") addPoint();
    });
  });
});
