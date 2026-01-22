from __future__ import annotations
import json
import math
import os
from datetime import datetime
from typing import Any, Dict, List

from flask import Flask, jsonify, request, send_file
from io import BytesIO

APP_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

app = Flask(__name__, static_folder=APP_ROOT, static_url_path="")

# ---------------------------
# Geomensura utils
# ---------------------------
def d2r(deg: float) -> float:
    return deg * math.pi / 180.0

def r2d(rad: float) -> float:
    return rad * 180.0 / math.pi

def wrap360(a: float) -> float:
    a = a % 360.0
    return a if a >= 0 else a + 360.0

def wrap180(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0

def mean_angle_deg(angles_deg: List[float]) -> float:
    s = 0.0
    c = 0.0
    for a in angles_deg:
        ar = d2r(a)
        s += math.sin(ar)
        c += math.cos(ar)
    if abs(s) < 1e-12 and abs(c) < 1e-12:
        return 0.0
    return wrap360(r2d(math.atan2(s, c)))

def parse_num(v: Any) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        raise ValueError("Valor numérico vacío")
    return float(str(v).strip().replace(",", "."))

def azimut_xy(cam: Dict[str, float], pt: Dict[str, float]) -> float:
    # Convención: 0° = Norte (+Y), 90° = Este (+X)
    dx = pt["X"] - cam["X"]
    dy = pt["Y"] - cam["Y"]
    return wrap360(r2d(math.atan2(dx, dy)))

def inclinacion(cam: Dict[str, float], pt: Dict[str, float]) -> float:
    dx = pt["X"] - cam["X"]
    dy = pt["Y"] - cam["Y"]
    dz = pt["Z"] - cam["Z"]
    dh = math.hypot(dx, dy)
    return r2d(math.atan2(dz, dh))

def calc_xyz_from_angles(cam: Dict[str, float], ah_deg: float, av_deg: float, dist: float):
    ah_r = d2r(ah_deg)
    av_r = d2r(av_deg)

    dh = dist * math.cos(av_r)
    dz = dist * math.sin(av_r)

    dx = dh * math.sin(ah_r)  # Este
    dy = dh * math.cos(ah_r)  # Norte

    x = cam["X"] + dx
    y = cam["Y"] + dy
    z = cam["Z"] + dz
    return x, y, z

# ---------------------------
# Config handling
# ---------------------------
def load_config() -> Dict[str, Any]:
    if not os.path.exists(CONFIG_PATH):
        raise FileNotFoundError(f"No existe config.json en: {CONFIG_PATH}")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    cam = cfg.get("camera", {})
    cam_n = {"X": parse_num(cam["X"]), "Y": parse_num(cam["Y"]), "Z": parse_num(cam["Z"])}

    pts = cfg.get("collimation_points", [])
    pts_n = []
    for p in pts:
        pts_n.append({
            "name": str(p.get("name", "")).strip() or "PT",
            "X": parse_num(p["X"]),
            "Y": parse_num(p["Y"]),
            "Z": parse_num(p["Z"]),
            "AH_obs": parse_num(p["AH_obs"]),
            "AV_obs": parse_num(p["AV_obs"]),
            "D_obs": parse_num(p.get("D_obs", 0.0)),
        })

    return {"camera": cam_n, "collimation_points": pts_n}

def save_config(cfg: Dict[str, Any]) -> None:
    # Normaliza a floats
    cam = cfg.get("camera", {})
    pts = cfg.get("collimation_points", [])
    out = {
        "camera": {
            "X": parse_num(cam["X"]),
            "Y": parse_num(cam["Y"]),
            "Z": parse_num(cam["Z"]),
        },
        "collimation_points": []
    }
    for p in pts:
        out["collimation_points"].append({
            "name": str(p.get("name", "")).strip() or "PT",
            "X": parse_num(p["X"]),
            "Y": parse_num(p["Y"]),
            "Z": parse_num(p["Z"]),
            "AH_obs": parse_num(p["AH_obs"]),
            "AV_obs": parse_num(p["AV_obs"]),
            "D_obs": parse_num(p.get("D_obs", 0.0)),
        })

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

# ---------------------------
# Calibration core
# ---------------------------
def calibrate(cfg: Dict[str, Any]) -> Dict[str, Any]:
    cam = cfg["camera"]
    pts = cfg["collimation_points"]
    if len(pts) < 2:
        raise ValueError("Se requieren al menos 2 puntos de colimación para calibrar.")

    deltas_ah = []
    deltas_av = []
    diagnostics = []

    for pt in pts:
        ah_real = azimut_xy(cam, pt)
        av_real = inclinacion(cam, pt)

        delta_ah = wrap180(ah_real - pt["AH_obs"])
        delta_av = av_real - pt["AV_obs"]

        deltas_ah.append(delta_ah)
        deltas_av.append(delta_av)

        dx = pt["X"] - cam["X"]
        dy = pt["Y"] - cam["Y"]
        dz = pt["Z"] - cam["Z"]
        dist_geom = math.sqrt(dx*dx + dy*dy + dz*dz)
        dist_res = dist_geom - float(pt.get("D_obs", 0.0))

        diagnostics.append({
            "name": pt["name"],
            "AH_real": ah_real,
            "AV_real": av_real,
            "AH_obs": pt["AH_obs"],
            "AV_obs": pt["AV_obs"],
            "dAH": delta_ah,
            "dAV": delta_av,
            "Dist_geom": dist_geom,
            "Dist_obs": float(pt.get("D_obs", 0.0)),
            "Dist_res": dist_res
        })

    # promedio circular para deltas (pasar a 0..360 para promediar)
    deltas_ah_0360 = [wrap360(d) for d in deltas_ah]
    ajuste_ah = mean_angle_deg(deltas_ah_0360)
    ajuste_ah = wrap180(ajuste_ah)  # forma intuitiva (-180..180]

    ajuste_av = sum(deltas_av) / len(deltas_av)

    return {
        "ajuste_ah": ajuste_ah,
        "ajuste_av": ajuste_av,
        "diagnostics": diagnostics,
        "n_points": len(pts)
    }

# Cache simple en memoria (se recalcula al iniciar / calibrar)
STATE = {"ajuste_ah": 0.0, "ajuste_av": 0.0, "diagnostics": [], "loaded": False}

def ensure_state():
    if not STATE["loaded"]:
        cfg = load_config()
        cal = calibrate(cfg)
        STATE.update(cal)
        STATE["loaded"] = True

# ---------------------------
# Routes
# ---------------------------
@app.get("/")
def root():
    # Servir el index.html del root del proyecto
    return app.send_static_file("index.html")

@app.get("/api/config")
def api_get_config():
    cfg = load_config()
    ensure_state()
    return jsonify({"ok": True, "config": cfg, "calibration": {
        "ajuste_ah": STATE["ajuste_ah"],
        "ajuste_av": STATE["ajuste_av"],
        "diagnostics": STATE["diagnostics"],
        "n_points": STATE.get("n_points", 0)
    }})

@app.post("/api/config")
def api_set_config():
    payload = request.get_json(force=True)
    save_config(payload)
    # recalibrar
    cfg = load_config()
    cal = calibrate(cfg)
    STATE.update(cal)
    STATE["loaded"] = True
    return jsonify({"ok": True, "message": "Config guardada y recalibrada.", "calibration": cal})

@app.post("/api/calibrate")
def api_calibrate():
    cfg = load_config()
    cal = calibrate(cfg)
    STATE.update(cal)
    STATE["loaded"] = True
    return jsonify({"ok": True, "calibration": cal})

@app.post("/api/compute")
def api_compute_point():
    ensure_state()
    cfg = load_config()
    cam = cfg["camera"]

    payload = request.get_json(force=True)
    ah_obs = parse_num(payload.get("AH_obs"))
    av_obs = parse_num(payload.get("AV_obs"))
    dist = parse_num(payload.get("D_obs"))

    ah_corr = wrap360(ah_obs + float(STATE["ajuste_ah"]))
    av_corr = av_obs + float(STATE["ajuste_av"])

    x, y, z = calc_xyz_from_angles(cam, ah_corr, av_corr, dist)

    return jsonify({
        "ok": True,
        "result": {
            "X": x, "Y": y, "Z": z,
            "AH_obs": ah_obs, "AV_obs": av_obs, "D_obs": dist,
            "AH_corr": ah_corr, "AV_corr": av_corr
        },
        "calibration": {"ajuste_ah": STATE["ajuste_ah"], "ajuste_av": STATE["ajuste_av"]}
    })

@app.post("/api/export")
def api_export_txt():
    """
    Recibe lista de puntos calculados y devuelve un .txt descargable.
    """
    payload = request.get_json(force=True)
    points = payload.get("points", [])
    sep = payload.get("sep", ";")
    decimal = payload.get("decimal", ".")
    filename = payload.get("filename", "puntos_calculados.txt")

    def fmt(v, nd=3):
        s = f"{float(v):.{nd}f}"
        return s.replace(".", decimal) if decimal != "." else s

    headers = ["ID", "X", "Y", "Z", "AH_obs", "AV_obs", "D_obs", "AH_corr", "AV_corr"]

    lines = [sep.join(headers)]
    for p in points:
        lines.append(sep.join([
            str(p.get("ID", "")),
            fmt(p.get("X", 0), 3),
            fmt(p.get("Y", 0), 3),
            fmt(p.get("Z", 0), 3),
            fmt(p.get("AH_obs", 0), 4),
            fmt(p.get("AV_obs", 0), 4),
            fmt(p.get("D_obs", 0), 3),
            fmt(p.get("AH_corr", 0), 4),
            fmt(p.get("AV_corr", 0), 4),
        ]))

    content = "\n".join(lines) + "\n"

    bio = BytesIO()
    bio.write(content.encode("utf-8"))
    bio.seek(0)

    # Garantiza .txt
    if not filename.lower().endswith(".txt"):
        filename += ".txt"

    return send_file(
        bio,
        mimetype="text/plain",
        as_attachment=True,
        download_name=filename
    )

if __name__ == "__main__":
    ensure_state()
    # http://127.0.0.1:5000
    app.run(host="127.0.0.1", port=5000, debug=True)
