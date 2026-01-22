// =====================================================
// AppCarro — Frontend 100% estático (sin backend)
// - Carga config desde /config.json o desde localStorage
// - Calibra (ΔAH circular + ΔAV promedio)
// - Calcula puntos y exporta TXT local
// - Permite editar Config (se guarda en localStorage)
// =====================================================

const $ = (id) => document.getElementById(id);

const LS_KEY = "appcarro_config_v1";

const state = {
  config: null,
  calibration: null,
  points: [],
  nextId: 1,
};

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
  const camera = {
    X: parseNum(cam.X),
    Y: parseNum(cam.Y),
    Z: parseNum(cam.Z),
  };
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

    diagnostics.push({
      name: p.name,
      dAH,
      dAV,
      Dist_res: distRes
    });
  }

  // promedio circular para deltas AH
  const deltas0360 = deltasAh.map(wrap360);
  let ajusteAh = meanAngleDeg(deltas0360);
  ajusteAh = wrap180(ajusteAh);

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
// Render UI
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
      renderPoints();
    });
  });
}

// =====================================================
// Config load/save (static hosting compatible)
// - Primero intenta localStorage
// - Si no existe, carga /config.json (archivo estático)
// =====================================================
function getLocalConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setLocalConfig(cfg) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

async function fetchConfigJson() {
  const r = await fetch("./config.json", { cache: "no-store" });
  if (!r.ok) throw new Error("No se pudo cargar config.json");
  return await r.json();
}

async function loadAll() {
  try {
    $("badgeStatus").textContent = "Cargando…";

    // 1) localStorage
    const localCfg = getLocalConfig();
    const baseCfg = localCfg ?? (await fetchConfigJson());

    state.config = normalizeConfig(baseCfg);
    state.calibration = calibrate(state.config);

    renderCalibration();
    toast(localCfg ? "Config local cargada." : "Config cargada desde config.json");
  } catch (e) {
    console.error(e);
    setStatusError("Error cargando config. Revisa config.json o Config local.");
  }
}

// =====================================================
// Actions
// =====================================================
function calibrateNow() {
  try {
    if (!state.config) throw new Error("Sin config");
    state.calibration = calibrate(state.config);
    renderCalibration();
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

  if (![ah, av, d].every((v) => Number.isFinite(v))) {
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
    renderPoints();
    toast(`Punto ${p.ID} agregado.`);
  } catch (e) {
    console.error(e);
    toast("No se pudo calcular el punto.");
  }
}

function exportTxt() {
  if (state.points.length === 0) {
    toast("No hay puntos para exportar.");
    return;
  }

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

  const content = lines.join("\n") + "\n";
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
  toast("TXT exportado.");
}

function clearPoints() {
  state.points = [];
  state.nextId = 1;
  renderPoints();
  toast("Lista limpiada.");
}

// ---------------- Modal Config ----------------
function openConfig() {
  $("modalConfig").classList.add("show");
  $("modalConfig").setAttribute("aria-hidden", "false");
  $("configEditor").value = JSON.stringify(state.config, null, 2);
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

    // Guardar localmente (para Vercel / estático)
    setLocalConfig(cfgRaw);

    state.config = cfg;
    state.calibration = calibrate(state.config);

    renderCalibration();
    toast("Config guardada localmente y recalibrada.");
    closeConfig();
  } catch (e) {
    console.error(e);
    toast("Config inválida. Revisa JSON y números.");
  }
}

async function reloadConfig() {
  try {
    // Preferencia: localStorage si existe
    const localCfg = getLocalConfig();
    const baseCfg = localCfg ?? (await fetchConfigJson());

    state.config = normalizeConfig(baseCfg);
    state.calibration = calibrate(state.config);

    $("configEditor").value = JSON.stringify(state.config, null, 2);
    renderCalibration();
    toast(localCfg ? "Config local recargada." : "Config recargada desde config.json");
  } catch (e) {
    console.error(e);
    toast("No se pudo recargar config.");
  }
}

// =====================================================
// Wire up
// =====================================================
window.addEventListener("DOMContentLoaded", () => {
  loadAll();

  $("btnCalibrate").addEventListener("click", calibrateNow);
  $("btnAddPoint").addEventListener("click", addPoint);
  $("btnExport").addEventListener("click", exportTxt);
  $("btnClear").addEventListener("click", clearPoints);

  $("btnOpenConfig").addEventListener("click", openConfig);
  $("btnCloseConfig").addEventListener("click", closeConfig);
  $("btnSaveConfig").addEventListener("click", saveConfig);
  $("btnReloadConfig").addEventListener("click", reloadConfig);

  $("modalConfig").addEventListener("click", (ev) => {
    if (ev.target && ev.target.getAttribute("data-close") === "1") closeConfig();
  });

  // Enter para calcular (cuando estás en inputs)
  ["inAh", "inAv", "inD"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") addPoint();
    });
  });
});
