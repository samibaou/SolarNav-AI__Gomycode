"""Prédit l'angle optimal du panneau dans le terminal.

python scripts/predict_angle.py --live 25544 --dust 30              # ISS en direct
python scripts/predict_angle.py --elevation 40 --dust 90 --temp 30  # scénario inventé
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.modules.data_twin.ephemeris import sun_from_earth_orbit
from backend.app.modules.data_twin.satellite_source import get_satellite_position
from backend.app.modules.intelligence.angle_physics import compute_optimal_angle, simulate_surface_temp
from backend.app.modules.intelligence.angle_predictor import predict_with_confidence


def _live_inputs(norad_id: int) -> tuple[float, float, bool, float]:
    """Position réelle du satellite (N2YO) -> soleil (Skyfield) -> température estimée."""
    position = get_satellite_position(norad_id)
    sun = sun_from_earth_orbit(position)
    elevation, azimuth, sunlit = sun.elevation_deg, sun.azimuth_deg, sun.sunlit
    temp = float(simulate_surface_temp(elevation, sunlit))
    print(f"Satellite {norad_id} : lat {position.lat_deg:.2f}°, lon {position.lon_deg:.2f}°, "
          f"altitude {position.alt_km:.0f} km")
    print(f"Soleil : élévation {elevation:.1f}°, azimut {azimuth:.1f}°, "
          f"{'éclairé' if sunlit else 'dans l ombre'}, surface estimée {temp:.0f} °C")
    return elevation, azimuth, sunlit, temp


parser = argparse.ArgumentParser(description="Prédit l'angle optimal du panneau solaire.")
parser.add_argument("--live", type=int, metavar="NORAD_ID",
                    help="utiliser la position réelle d'un satellite (ex. 25544 = ISS)")
parser.add_argument("--elevation", type=float, default=40.0, help="élévation du soleil (°)")
parser.add_argument("--azimuth", type=float, default=180.0, help="azimut du soleil (°)")
parser.add_argument("--shadow", action="store_true", help="satellite dans l'ombre")
parser.add_argument("--dust", type=float, default=20.0, help="poussière (0-100 %%)")
parser.add_argument("--temp", type=float, default=60.0, help="température de surface (°C)")
args = parser.parse_args()

if args.live:
    elevation, azimuth, sunlit, temp = _live_inputs(args.live)
else:
    elevation, azimuth, sunlit, temp = args.elevation, args.azimuth, not args.shadow, args.temp

result = predict_with_confidence(elevation, azimuth, sunlit, args.dust, temp)
expected = compute_optimal_angle(elevation, sunlit, args.dust, temp)[0]
print(f"\nEntrées : élévation {elevation:.1f}°, azimut {azimuth:.1f}°, "
      f"{'soleil' if sunlit else 'ombre'}, poussière {args.dust:.0f} %, {temp:.0f} °C")
print(f"Angle optimal prédit par l'IA : {result['angle']:.1f}° ± {result['uncertainty']:.1f}"
      f"{'' if result['confident'] else '  (confiance faible)'}")
print(f"Formule physique (référence)  : {expected:.1f}°")
