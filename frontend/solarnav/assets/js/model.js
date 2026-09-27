/* =========================================================================
   model.js — contrat du modele, formule de reference et validation

   SolarNav est un tableau de bord : il ne calcule pas l'orientation, il
   affiche ce que le modele predit. Ce fichier ne contient donc que
     - la formule simple qui sert de point de comparaison,
     - le modele d'energie du cosinus, pour chiffrer ce que coute un ecart,
     - les bornes de validite des entrees,
     - les metriques de validation par defaut (remplacables par data/metrics.json).
   ========================================================================= */

export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------- ENTREES DU MODELE */

/**
 * Les cinq variables d'entree, dans l'ordre attendu par le modele entraine.
 * `key` doit correspondre au nom de colonne du dataset.
 */
export const FEATURES = [
  {
    key: 'sun_elevation', label: 'Élévation du soleil', unit: '°',
    min: -90, max: 90, step: 0.5, demo: 42,
    hint: 'Hauteur du soleil au-dessus de l’horizon local.'
  },
  {
    key: 'sun_azimuth', label: 'Azimut du soleil', unit: '°',
    min: 0, max: 360, step: 1, demo: 170,
    hint: 'Direction du soleil, comptée depuis le nord.'
  },
  {
    key: 'is_sunlit', label: 'Exposition', unit: '',
    min: 0, max: 1, step: 1, demo: 1, bool: true,
    hint: 'Au soleil, ou dans l’ombre de la Terre.'
  },
  {
    key: 'dust_level', label: 'Empoussièrement', unit: '%',
    min: 0, max: 100, step: 1, demo: 12,
    hint: 'Dépôt sur la surface. Un panneau à plat se salit plus vite.'
  },
  {
    key: 'surface_temp', label: 'Température de surface', unit: '°C',
    min: -150, max: 160, step: 1, demo: 68,
    hint: 'Au-delà de ~100 °C, le rendement chute et il vaut mieux dépointer.'
  }
];

export const FEATURE_KEYS = FEATURES.map(f => f.key);

/** Valide une trame d'entree. Renvoie la liste des problemes rencontres. */
export function validate(inputs) {
  const issues = [];
  for (const f of FEATURES) {
    const v = inputs[f.key];
    if (v === undefined || v === null || (typeof v !== 'boolean' && !isFinite(v))) {
      issues.push({ key: f.key, kind: 'manquant', label: f.label });
    } else if (!f.bool && (v < f.min || v > f.max)) {
      issues.push({ key: f.key, kind: 'hors domaine', label: f.label, value: v });
    }
  }
  return issues;
}

/* ------------------------------------------------ FORMULE DE REFERENCE */

/**
 * La regle de base : le panneau fait face au soleil.
 * Elle ignore l'ombre, la poussiere et la chaleur — c'est precisement
 * l'ecart que le modele entraine vient corriger.
 */
export function simpleFormula(sunElevation) {
  return clamp(90 - sunElevation, 0, 90);
}

/**
 * Energie relative recuperee par un panneau incline de `tilt` alors que
 * l'optimum est `optimal`. Loi du cosinus : un ecart de 2 degres ne coute
 * que 0,06 % d'energie, un ecart de 30 degres en coute 13 %.
 */
export function energyRatio(tilt, optimal) {
  return Math.max(0, Math.cos((tilt - optimal) * DEG));
}

/* -------------------------------------------- METRIQUES DE VALIDATION */

/**
 * Metriques publiees par l'equipe modele. Elles sont ecrasees au demarrage
 * par `data/metrics.json` si le fichier existe, pour que le tableau de bord
 * affiche toujours les chiffres de la derniere campagne d'evaluation.
 */
export const DEFAULT_METRICS = {
  source: 'valeurs de référence (data/metrics.json absent)',
  model: 'ExtraTrees hybride — 100 arbres',
  dataset: '40 000 exemples · 60 % orbites réelles (ISS, Hubble, NOAA-19) · 40 % simulés',
  headline: {
    mae_deg: 0.45,
    r2: 0.999,
    energy_pct: 99.9,
    speedup_vs_formula: 17
  },
  baseline: {
    mae_deg: 7.9,
    r2: 0.72,
    energy_pct: 96.8
  },
  generalisation: {
    train_mae_deg: 0.36,
    test_mae_deg: 0.45,
    unseen_mae_deg: 0.49,
    shuffled_r2: -0.04,
    theoretical_r2_ceiling: 0.9997
  },
  hard_cases: [
    { case: 'Ombre de la Terre', model: 0.24, baseline: 89.8 },
    { case: 'Poussière forte', model: 0.46, baseline: 11.3 },
    { case: 'Surchauffe', model: 0.77, baseline: 26.9 },
    { case: 'Soleil au zénith', model: 0.55, baseline: 8.9 }
  ],
  checks_passed: 18,
  checks_total: 18
};

/* ----------------------------------------------- ECHELLES COLOREES */

/** Niveaux d'empoussierement : la couleur de la carte suit la mesure. */
export const DUST_LEVELS = [
  { max: 15, key: 'low', label: 'Propre', color: '#3d9a4a', advice: 'Dépôt négligeable : la correction reste inférieure au degré.' },
  { max: 35, key: 'mod', label: 'Modéré', color: '#d9a408', advice: 'Le modèle commence à redresser le panneau pour limiter le dépôt.' },
  { max: 60, key: 'high', label: 'Élevé', color: '#e07b12', advice: 'Compromis net entre visée du soleil et évacuation de la poussière.' },
  { max: 80, key: 'vhigh', label: 'Très élevé', color: '#d63b2f', advice: 'Redressement marqué : la perte par salissure dépasse la perte par dépointage.' },
  { max: Infinity, key: 'extreme', label: 'Critique', color: '#8e44c4', advice: 'Nettoyage requis — le modèle ne peut plus compenser par l’angle seul.' }
];

/** Niveaux thermiques : du froid orbital a la surchauffe. */
export const TEMP_LEVELS = [
  { max: -60, key: 'cold', label: 'Froid extrême', color: '#2a78d6', advice: 'Face à l’ombre : rendement nominal, aucune contrainte thermique.' },
  { max: 40, key: 'nominal', label: 'Nominal', color: '#3d9a4a', advice: 'Plage de fonctionnement idéale pour la cellule.' },
  { max: 85, key: 'warm', label: 'Chaud', color: '#d9a408', advice: 'Le rendement baisse, la correction thermique reste faible.' },
  { max: 110, key: 'hot', label: 'Surchauffe', color: '#e07b12', advice: 'Le modèle dépointe légèrement pour limiter l’échauffement.' },
  { max: Infinity, key: 'critical', label: 'Critique', color: '#d63b2f', advice: 'Dépointage marqué : au-delà de 110 °C la perte thermique domine.' }
];

export const levelOf = (levels, v) => levels.find(l => v <= l.max) || levels[levels.length - 1];

/* --------------------------------------------------------- FORMATAGE */

export const fmt = (v, d = 1) =>
  Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export function clockLabel(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return { time: '—', sub: '' };
  const p = n => String(n).padStart(2, '0');
  return {
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
    sub: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} · UTC`
  };
}
