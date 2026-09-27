"""
SolarNav — serveur applicatif (optionnel).

Il rend trois services :
  1. il sert le tableau de bord statique ;
  2. il expose le modele d'orientation entraine  -> POST /api/predict
  3. il relaie la telemetrie de la simulation    -> GET / POST /api/telemetry

Lancement :
    pip install -r requirements.txt
    python app.py               # http://localhost:8000

Sans backend, le tableau de bord fonctionne seul (`node serve.js`) : il retombe
alors sur la formule simple pour l'angle, en l'indiquant explicitement.
"""

from __future__ import annotations

import json
import math
import os
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

try:  # facultatif : le .env n'est pas obligatoire
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover
    pass

ROOT = Path(__file__).parent

MODEL_PATH = Path(os.getenv("MODEL_PATH", ROOT / "model.joblib"))
FEATURES_PATH = Path(os.getenv("FEATURES_PATH", ROOT / "model_features.json"))

app = FastAPI(title="SolarNav", docs_url="/api/docs", redoc_url=None)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# ---------------------------------------------------------------- MODELE

_model = None
_features: list[str] | None = None
_model_error: str | None = None

# Les cinq entrees du modele, dans l'ordre d'entrainement par defaut.
DEFAULT_FEATURES = [
    "sun_elevation",
    "sun_azimuth",
    "is_sunlit",
    "dust_level",
    "surface_temp",
]

# Domaine de validite : hors de ces bornes, la prediction est refusee plutot
# qu'extrapolee. Le modele doit dire "je ne sais pas", pas inventer un angle.
BOUNDS = {
    "sun_elevation": (-90.0, 90.0),
    "sun_azimuth": (0.0, 360.0),
    "is_sunlit": (0.0, 1.0),
    "dust_level": (0.0, 100.0),
    "surface_temp": (-200.0, 200.0),
}


def load_model() -> None:
    """Charge model.joblib s'il existe. Silencieux si absent : repli physique."""
    global _model, _features, _model_error
    if not MODEL_PATH.exists():
        _model_error = "model.joblib absent"
        return
    try:
        import joblib  # import tardif : inutile sans modele

        _model = joblib.load(MODEL_PATH)
        if FEATURES_PATH.exists():
            _features = json.loads(FEATURES_PATH.read_text(encoding="utf-8"))
        print(
            f"[solarnav] modele charge : {MODEL_PATH.name}"
            + (f" ({len(_features)} variables)" if _features else " (ordre par defaut)")
        )
    except Exception as exc:  # pragma: no cover
        _model_error = f"{type(exc).__name__}: {exc}"
        print(f"[solarnav] echec du chargement du modele — {_model_error}")


load_model()


def simple_formula(elevation: float, is_sunlit: float) -> float:
    """La regle de base : le panneau fait face au soleil, et se replie a l'ombre."""
    if is_sunlit < 0.5:
        return 0.0
    return max(0.0, min(90.0, 90.0 - elevation))


def tree_uncertainty(model, row) -> float | None:
    """
    Ecart-type des predictions individuelles des arbres : quand ils sont
    d'accord le modele est confiant, quand ils divergent la situation est rare.
    """
    try:
        import numpy as np

        estimators = getattr(model, "estimators_", None)
        if not estimators:
            return None
        preds = [float(np.ravel(t.predict(row))[0]) for t in estimators]
        return float(np.std(preds))
    except Exception:
        return None


@app.post("/api/predict")
async def predict(req: Request) -> Any:
    """
    Renvoie l'angle recommande pour un jeu de cinq entrees.

    Entree : {sun_elevation, sun_azimuth, is_sunlit, dust_level, surface_temp}
    Sortie : {tilt, uncertainty, source, confident}
    Refus  : 422 si une entree sort de son domaine physique.
    """
    payload = await req.json()

    values: dict[str, float] = {}
    for name in DEFAULT_FEATURES:
        raw = payload.get(name)
        if isinstance(raw, bool):
            raw = 1.0 if raw else 0.0
        try:
            v = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(422, f"{name} manquant ou non numerique")
        lo, hi = BOUNDS[name]
        if not math.isfinite(v) or v < lo or v > hi:
            raise HTTPException(422, f"{name} = {raw} hors du domaine [{lo}, {hi}]")
        values[name] = v

    fallback = simple_formula(values["sun_elevation"], values["is_sunlit"])

    if _model is None:
        return {
            "tilt": fallback,
            "uncertainty": None,
            "source": "formule simple (modele absent)",
            "confident": False,
            "detail": _model_error,
        }

    try:
        import numpy as np

        names = _features or DEFAULT_FEATURES
        row = np.array([[values.get(n, 0.0) for n in names]], dtype=float)
        tilt = float(np.ravel(_model.predict(row))[0])

        if not math.isfinite(tilt):
            raise ValueError("prediction NaN")
        tilt = max(0.0, min(90.0, tilt))

        sigma = tree_uncertainty(_model, row)
        return {
            "tilt": tilt,
            "uncertainty": sigma,
            "source": MODEL_PATH.name,
            "confident": sigma is None or sigma < 2.0,
        }
    except Exception as exc:
        return {
            "tilt": fallback,
            "uncertainty": None,
            "source": "formule simple (repli)",
            "confident": False,
            "detail": f"{type(exc).__name__}: {exc}",
        }


# ------------------------------------------------------------ TELEMETRIE

# Tampon alimente par la simulation. Elle pousse ses trames en POST, le
# tableau de bord les recupere en GET. Remplacez-le par votre propre source
# si la simulation ecrit ailleurs (fichier, base, bus de messages).
_telemetry: deque[dict] = deque(maxlen=2000)


@app.post("/api/telemetry")
async def push_telemetry(req: Request) -> dict[str, Any]:
    """Recoit une trame, ou une liste de trames, depuis la simulation."""
    body = await req.json()
    frames = body if isinstance(body, list) else body.get("frames", [body])
    for f in frames:
        if isinstance(f, dict):
            _telemetry.append(f)
    return {"stored": len(frames), "buffered": len(_telemetry)}


@app.get("/api/telemetry")
async def get_telemetry(n: int = 1) -> Any:
    """Renvoie les `n` dernieres trames (la plus recente en dernier)."""
    if not _telemetry:
        raise HTTPException(404, "aucune trame en tampon")
    n = max(1, min(int(n), len(_telemetry)))
    return {"frames": list(_telemetry)[-n:]}


@app.get("/api/metrics")
async def metrics() -> Any:
    """Sert data/metrics.json si l'equipe modele l'a depose."""
    p = ROOT / "data" / "metrics.json"
    if not p.exists():
        raise HTTPException(404, "data/metrics.json absent")
    return JSONResponse(json.loads(p.read_text(encoding="utf-8")))


# Prevision a 7 jours : elle vient de la base du projet. Le serveur la garde en
# memoire si la simulation la pousse, sinon il sert le fichier depose.
_forecast: dict | None = None


@app.post("/api/forecast")
async def push_forecast(req: Request) -> dict[str, Any]:
    """Recoit la prevision produite par le modele ou la base."""
    global _forecast
    body = await req.json()
    days = body.get("days") if isinstance(body, dict) else body
    if not isinstance(days, list) or not days:
        raise HTTPException(422, "prevision vide : 'days' attendu")
    _forecast = body if isinstance(body, dict) else {"days": days}
    return {"days": len(days)}


@app.get("/api/forecast")
async def get_forecast() -> Any:
    """Prevision en memoire, a defaut data/forecast.json."""
    if _forecast:
        return JSONResponse(_forecast)
    p = ROOT / "data" / "forecast.json"
    if not p.exists():
        raise HTTPException(404, "aucune prevision disponible")
    return JSONResponse(json.loads(p.read_text(encoding="utf-8")))


@app.get("/api/config")
async def config() -> dict[str, Any]:
    """Indique au frontend ce que le serveur sait faire."""
    return {
        "model_file": _model is not None,
        "model_error": _model_error,
        "telemetry_buffered": len(_telemetry),
    }


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {"status": "ok", "model": _model is not None, "telemetry": len(_telemetry)}
    )


# ----------------------------------------------------------- SITE STATIQUE

app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
if (ROOT / "data").exists():
    app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    print(f"[solarnav] http://localhost:{port}  (modele : {'charge' if _model else 'absent'})")
    uvicorn.run(app, host="0.0.0.0", port=port)
