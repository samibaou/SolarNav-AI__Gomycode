from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.app.api.router import api_router
from backend.app.core.config import settings

app = FastAPI(
    title="SolarNav AI",
    version="1.0.0",
    description="Digital Twin and solar-panel orientation optimization API.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(api_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


frontend_dir: Path = settings.frontend_dir
if frontend_dir.exists():
    app.mount("/assets", StaticFiles(directory=frontend_dir / "assets"), name="assets")
    app.mount("/css", StaticFiles(directory=frontend_dir / "css"), name="css")
    app.mount("/js", StaticFiles(directory=frontend_dir / "js"), name="js")
    app.mount("/digital_twin", StaticFiles(directory=frontend_dir / "digital_twin"), name="digital_twin")

    @app.get("/", include_in_schema=False)
    def frontend() -> FileResponse:
        return FileResponse(frontend_dir / "index.html")
