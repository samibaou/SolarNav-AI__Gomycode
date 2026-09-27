# Jumeau numérique 3D ↔ backend — contrat v1.1

Le **contrat unique** de l'équipe est `backend/app/core/contracts.py` (`TwinState`, `Decision`, …) exposé par l'API FastAPI `/api/v1` (voir `docs/API_CONTRACT.md`). Le jumeau 3D (`frontend/digital_twin/`) ne parle au backend que par **HTTP/JSON, en URL relative** : la page est servie par uvicorn (`http://127.0.0.1:8000/digital_twin/index.html`). Le backend est la seule source des décisions « IA » ; le twin garde une politique locale de **secours** (§5).

Ce document décrit : les routes appelées (§1), l'adaptateur (§2), le format interne des décisions du twin (§3–4), la porte de validation (§6), les scénarios météo (§7) et les sources de données (§8).

## 1. Routes appelées

| Route | Module | Usage |
|---|---|---|
| `POST /api/v1/agent/decision` (sans corps) | [js/backend.js](js/backend.js) | Mode « API IA » : décision du backend sur **son** `TwinState` |
| `GET /api/v1/analysis` | [js/backend.js](js/backend.js) | Physique + ML + diagnostic : drapeaux `PHYSICS_ML_MISMATCH`, `DIAGNOSTIC_ALERT`, incertitude = 1 − confiance ML |
| `GET /api/v1/data/live?mode=earth\|moon` | [js/datasource.js](js/datasource.js) | Source de données « Live » (§8) |

Timeout 5 s (décision) / 12 s (live) ; aucune requête si la page est ouverte en `file://`. Toute erreur (timeout, HTTP ≠ 2xx, réponse invalide, backend injoignable) ⇒ **repli local**, erreur affichée dans la section « Pilotage ».

**La décision du backend n'est appliquée qu'en source Live** : elle porte sur l'état du backend, pas sur la simulation ou le replay affichés. Hors Live, le twin n'appelle pas le backend et affiche l'avertissement « Décision du backend ignorée … → repli local ». Une réponse est valable 15 s ; le backend est interrogé toutes les 5 s.

## 2. Adaptateur `js/backend.js`

Seul endroit où les formats se rencontrent :

| Backend (`contracts.py`) | Twin |
|---|---|
| `Decision` (une pour la station) : `action`, `target_tilt_deg`, `target_azimuth_deg`, `reason`, `explanation_source` | une décision **par panneau** (4), mêmes cibles ; `reason` affiché dans le popup et la section Pilotage |
| Puissances en **W**, énergies en **Wh** | kW **uniquement pour l'affichage** (`twinStateView`) |
| `environment.dust_factor` (1 = propre) | `dustPct = (1 − dust_factor) × 100` |
| `STOW` : `target_tilt_deg` = inclinaison de sécurité, azimut conservé | `STOW` |

La réponse est validée (`validateBackendDecision`) : `action` ∈ `MOVE|HOLD|STOW`, cibles numériques finies ; sinon elle est rejetée (repli local).

## 3. Conventions

| Grandeur | Convention (identique à `PanelState` dans `contracts.py`) |
|---|---|
| Azimut | degrés **boussole** de la normale du panneau, 0 = Nord, 90 = Est, 180 = Sud, 270 = Ouest, dans `[0, 360)` |
| Inclinaison | degrés depuis l'horizontale : 0 = à plat, 90 = vertical (bornée par le twin à `[0, 85]`) |
| Élévation solaire | degrés au-dessus de l'horizon |
| Heure | `simTimeHours` ∈ `[0, 24)` et `datetime` `YYYY-MM-DDTHH:MM` en heure solaire locale ; `null` en simulation |
| Unités | backend : W, Wh ; twin (affichage) : kW, kWh ; irradiances W/m², °C, m/s, % |
| Valeurs absentes | `null` |

## 4. État et décision internes du twin

`buildDecisionState()` ([index.html](index.html)) produit l'état passé à la politique locale (`schemaVersion` `"1.1"`) :
`simTimeHours`, `datetime`, `site`, `dataSource {mode, status}`, `sun {elevationDeg, azimuthDeg}`,
`weather {ghiWm2, dniWm2, dhiWm2, albedo, ghiClearWm2, ambientC, windMs, cloudFactor, condition, hail}`,
`station {tracking, azimuthOffsetDeg, totalKW, battery {socPct, capacityKWh, loadKW, flowKW}}`,
`panels[] {panelId, capacityKW, manual, tiltDeg, azimuthDeg, incidence, poaWm2, cellTempC, dustPct, snowPct, powerKW}`,
`sensors[] {id, panelId, unit, value, status, note}`, `constraints {tiltMinDeg, tiltMaxDeg, stowTiltDeg, windStowMs, minSunElevDeg}`,
`model {noctC, tempCoefPerC, dustMaxLoss, thermalLosses}`, `spaceWeather {level, riskFlags, recommendedAction, reasons} | null`.

`weather.condition` ∈ `sand|rain|hail|snow|heat|fog|solar|null` (scénario simulé, §7). `constraints.minSunElevDeg` dépend du site (§5).

Décision (une par panneau) :

```json
{ "panelId": 0, "action": "STOW", "targetTilt": 85, "targetAzimuth": 180, "expectedGainKW": -1.2, "uncertainty": 0.28,
  "riskFlags": ["HAIL"], "reason": "Grêle : inclinaison maximale 85° pour protéger le verre des impacts.", "source": "fallback" }
```

`source` : `ai` (backend), `fallback` (politique locale), `override` (suivi coupé ou panneau manuel), `gate` (maintien en attente de validation, §6).

| Action | Effet |
|---|---|
| `MOVE` | le panneau prend `targetTilt` / `targetAzimuth` |
| `HOLD` | orientation conservée |
| `STOW` | mise en sécurité : `targetTilt` (0 = à plat ; 85 = inclinaison max contre la grêle), azimut conservé |

Drapeaux : `NIGHT`, `HIGH_WIND`, `HAIL`, `SPACE_WEATHER`, `SNOW`, `HIGH_TEMP`, `DUSTY`, `SENSOR_FAULT`, `PHYSICS_ML_MISMATCH`, `DIAGNOSTIC_ALERT`.

## 5. Politique locale (secours) et modèle physique

[js/decision.js](js/decision.js), `decideLocal(state)` ; chaque décision a un `reason` en français. Priorité :

1. `HIGH_WIND` (vent ≥ `windStowMs` = 11 m/s) → `STOW` à plat ;
2. `HAIL` → `STOW` à l'inclinaison maximale (protège le verre) ;
3. `SPACE_WEATHER` (alerte forte) → `STOW` à plat ;
4. `NIGHT` (élévation ≤ `minSunElevDeg` : **1° sur Terre, −1° sur la Lune**, où le Soleil rase l'horizon à ±1,5° et éclaire sans atmosphère) → `STOW` à plat ;
5. `SNOW` (couverture > 5 %) → `MOVE` à 60° pour évacuer la neige ;
6. lumière surtout diffuse (DHI / GHI > 70 %, brouillard) → `MOVE` presque à plat (≤ 12°), face au ciel ;
7. sinon suivi 2 axes : `targetTilt = min(85, 90 − élévation)`, `targetAzimuth = azimut solaire` (pluie : « suivi maintenu, nettoyage naturel »).

Drapeaux informatifs : `HIGH_TEMP` (cellule > 65 °C, perte thermique indiquée dans le `reason`), `DUSTY` (> 30 %), `SENSOR_FAULT`. `uncertainty = 0.05 + 0.3 × (1 − cloudFactor)`.

En mode « API IA », un danger local (vent, grêle, tempête solaire, nuit, neige) **remplace** la décision du backend pour le panneau ; sinon les drapeaux locaux s'y ajoutent.

Production d'un panneau :

```
cos_i  = normale(tilt, az) · soleil(élévation, azimut)          (≥ 0)
POA    = DNI·cos_i + DHI·(1 + cos tilt)/2 + GHI·albedo·(1 − cos tilt)/2
T_cell = T_amb + (NOCT − 20)/800 · POA · 9.5 / (5.7 + 3.8·vent)
P      = min(capacité, capacité · POA/1000 · (1 + tempCoef·(T_cell − 25)) · (1 − dustMaxLoss·dust/100) · (1 − neige/100))
```

## 6. Porte de validation — 3 modes d'autonomie

[js/gate.js](js/gate.js), section « Pilotage » ; valable sur Terre et sur la Lune. Chaque proposition (locale ou backend) passe par la porte avant d'être appliquée.

| Mode | Ce qui attend une validation humaine |
|---|---|
| **Manuel** | toute décision nouvelle (MOVE / HOLD / STOW) ; un HOLD qui ne change rien n'est pas mis en file |
| **Semi-auto** | seulement les décisions avec un drapeau de risque : rotation > 45°, batterie < 20 %, incertitude > 0,25, désaccord physique/ML, alerte diagnostic, `SPACE_WEATHER`, `HAIL`, `HIGH_WIND`, `STOW` |
| **Full auto** (défaut) | rien : tout s'applique directement |

- Pendant l'attente, la station **reste immobile** (HOLD, source `gate`, badge « Attente »).
- **Sans réponse en 30 s** : un `MOVE` devient `HOLD` ; un `STOW` est **appliqué** (la position de sécurité est l'action sûre).
- File : une carte par décision (action, cible, `reason`, drapeaux, compte à rebours), boutons **Approuver / Refuser**. Une nouvelle proposition remplace les cartes en attente ; un STOW n'est remplacé que par un STOW plus récent. Au plus une nouvelle carte toutes les 3 s ; une proposition est « nouvelle » si l'action change ou si la cible bouge de plus de 5°.
- **Reprise manuelle** possible dans tous les modes (bouton, équivalent à couper le suivi) ; le retour à l'IA est journalisé.
- **Journal** : heure, heure du site, mode, action, cible, drapeaux, validé par (`IA (…)`, `humain (approuvée|refusée)`, `auto (30 s sans réponse : sécurité)`, `expirée (30 s) : MOVE → HOLD`, `remplacée`, `diagnostic`), `reason`.

## 7. Scénarios météo (démo)

[js/weatherfx.js](js/weatherfx.js), section « Scénarios météo ». Un scénario est **simulé** et **prioritaire sur les données** (simulation, replay ou live) ; un bandeau rouge « Scénario simulé … ne reflète pas le réel » et le badge « Scénario » l'indiquent en permanence. Les effets montent en 4 s et redescendent progressivement au retour à « Normal ».

| Scénario | Effets (capteurs virtuels) | Réaction attendue |
|---|---|---|
| Tempête de sable | vent → 16 m/s, irradiance ÷ 3, poussière en forte hausse | `STOW` à plat (`HIGH_WIND`) |
| Pluie | irradiance réduite, poussière en baisse (nettoyage naturel) | suivi maintenu |
| Orage + grêle | vent 9 m/s, `HAIL`, éclairs | `STOW` à 85° |
| Neige | couverture neigeuse par panneau, production proche de 0 | `MOVE` à 60° (évacuation) |
| Canicule | 47 °C, cellules > 65 °C, perte de rendement | suivi, `HIGH_TEMP` |
| Brouillard | > 80 % de rayonnement diffus | presque à plat (≤ 12°) |
| Tempête solaire (Lune) | alerte `SPACE_WEATHER` forte | `STOW` à plat |

Les réactions passent par la porte (§6). **Démo automatique** (60 s, heure fixée à midi) : normal → tempête de sable → calme → diagnostic de nettoyage (journalisé) → pluie (nettoyage) → fin.

## 8. Sources de données

**Replay** (« Charger CSV / JSON »), pas horaire, heure solaire locale :

| Format | Détection | Colonnes / clés |
|---|---|---|
| NASA POWER JSON | `properties.parameter` | `ALLSKY_SFC_SW_DWN`, `T2M`, `WS10M` (ou `WS2M`), optionnel `CLRSKY_SFC_SW_DWN` ; `time-standard=LST` |
| NASA POWER CSV | `-BEGIN HEADER-` | mêmes paramètres, colonnes `YEAR,MO,DY,HR,…` |
| JSON SolarNav | `records` | `{"site":{"name","lat","lon"},"records":[{"date":"YYYY-MM-DD","hour":0-23,"ghi","tempC","windMs","ghiClear"?,"dustPct"?}]}` |
| CSV SolarNav | sinon | `date,hour,ghi,tempC,windMs[,ghiClear][,dustPct]`, lignes `# lat=…`, `# lon=…`, `# name=…` optionnelles |

Valeurs `-999` ou vides ignorées ; interpolation linéaire. Exemple : [data/ouarzazate-2024-06-power.json](data/ouarzazate-2024-06-power.json) (NASA POWER, Noor Ouarzazate, 18–24 juin 2024).

**Live** : `GET /api/v1/data/live?mode=earth|moon` toutes les 30 s (le backend met en cache 5 à 15 min par source). Terre (Ouarzazate) : éphéméride calculée + Open-Meteo ; Lune (pôle Sud) : JPL Horizons, vide (DNI = constante solaire). Chaque bloc porte `source {label, status, updated_at, age_s, error}` ; la page affiche « Open-Meteo · il y a 3 min » avec un badge **Live / Cache / Secours**. Backend injoignable avec un frame encore récent (< 3 min) ⇒ « Cache », puis `no-data` (simulation affichée). Météo spatiale (NASA DONKI, NOAA SWPC) : alerte forte ⇒ `SPACE_WEATHER` ⇒ `STOW` via la porte. Sur la Lune, décor lunaire (sol gris à cratères, ciel noir étoilé) et seuil de nuit à −1°.

## 9. Démarrage rapide

```bash
uvicorn backend.app.main:app --reload          # depuis la racine du dépôt
# ouvrir http://127.0.0.1:8000/digital_twin/index.html
#   Source des données → Live ; Pilotage → API IA ; Autonomie → Manuel / Semi-auto / Full auto
cd frontend && npm run test:twin               # tests du twin (Chrome headless, faux backend /api/v1 inclus)
```
