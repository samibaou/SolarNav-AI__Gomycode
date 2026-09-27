// SolarNav — porte de validation des décisions, 3 modes d'autonomie (valables sur Terre et sur la Lune).
//   manual : toute décision (MOVE / HOLD / STOW) passe par la file de validation ;
//   semi   : seulement les décisions portant un drapeau de risque (GATE_RISK_FLAGS) ;
//   full   : tout s'applique directement.
// Sans réponse en 30 s : un MOVE (ou HOLD) devient HOLD, un STOW est appliqué (la position de sécurité est l'action sûre).
// La station reste immobile (HOLD) tant qu'une décision attend. Reprise manuelle possible dans tous les modes (suivi coupé).
//
// gate.process(proposals, ctx) → décisions à appliquer, appelé à chaque image avec les propositions du fournisseur.
//   ctx = { panels: [{panelId, tiltDeg, azimuthDeg, manual}], socPct, simTime (h), site }

const AUTONOMY_MODES = ['manual', 'semi', 'full'];
const AUTONOMY_LABEL = { manual: 'Manuel', semi: 'Semi-auto', full: 'Full auto' };
const GATE_RISK_FLAGS = ['ROTATION_45', 'LOW_BATTERY', 'HIGH_UNCERTAINTY', 'PHYSICS_ML_MISMATCH', 'DIAGNOSTIC_ALERT',
  'SPACE_WEATHER', 'HAIL', 'HIGH_WIND', 'STOW'];
const GATE_TIMEOUT_MS = 30000;
const GATE_MIN_CARD_INTERVAL_MS = 3000;   // au plus une nouvelle carte toutes les 3 s
const GATE_CHANGE_DEG = 5;                // une proposition est « nouvelle » si l'action change ou la cible bouge de plus de 5°
const GATE_ROTATION_DEG = 45, GATE_LOW_BATTERY_PCT = 20, GATE_HIGH_UNCERTAINTY = 0.25;
const GATE_LOG_MAX = 100;

// Angle (°) entre deux normales de panneau données par (inclinaison, azimut boussole).
function normalAngleDeg(tiltA, azA, tiltB, azB) {
  const r = Math.PI / 180, n = (t, a) => [Math.sin(t * r) * Math.sin(a * r), Math.cos(t * r), Math.sin(t * r) * Math.cos(a * r)];
  const u = n(tiltA, azA), v = n(tiltB, azB);
  return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) / r;
}

// Drapeaux qui imposent une validation humaine en semi-auto (sous-ensemble de GATE_RISK_FLAGS).
function gateFlags(d, panelNow, ctx) {
  const flags = new Set(d.riskFlags.filter(f => GATE_RISK_FLAGS.includes(f)));
  if (d.action === 'STOW') flags.add('STOW');
  if (d.action === 'MOVE' && panelNow && normalAngleDeg(panelNow.tiltDeg, panelNow.azimuthDeg, d.targetTilt, d.targetAzimuth) > GATE_ROTATION_DEG) flags.add('ROTATION_45');
  if (ctx.socPct < GATE_LOW_BATTERY_PCT) flags.add('LOW_BATTERY');
  if (typeof d.uncertainty === 'number' && d.uncertainty > GATE_HIGH_UNCERTAINTY) flags.add('HIGH_UNCERTAINTY');
  return [...flags];
}

function createGate() {
  return {
    mode: 'full',
    queue: [],            // cartes en attente : { id, createdAt, action, targetTilt, targetAzimuth, reason, flags, decisions, source }
    log: [],              // journal : { at (Date), simTime, mode, action, targetTilt, targetAzimuth, flags, by, reason }
    command: null,        // décisions figées appliquées en attendant la validation (null = suivre les propositions)
    nextId: 1, lastCardAt: -Infinity, lastAuto: null,
    now: () => performance.now(),

    setMode(mode) {
      if (!AUTONOMY_MODES.includes(mode)) throw new Error('mode d’autonomie inconnu : ' + mode);
      if (mode === this.mode) return;
      this.mode = mode; this.lastAuto = null;
      if (mode === 'full') {   // plus rien n'attend : les cartes sont annulées, les propositions s'appliquent directement
        this.queue.forEach(c => this.record(c, 'annulée (passage en Full auto)', this.lastCtx));
        this.queue = []; this.command = null;
      }
    },

    // Résumé station d'une proposition (une décision par panneau) : action du premier panneau piloté, drapeaux réunis.
    summarize(proposals, ctx) {
      const byId = new Map(ctx.panels.map(p => [p.panelId, p]));
      const lead = proposals.find(d => !byId.get(d.panelId)?.manual) || proposals[0];
      const flags = [...new Set(proposals.filter(d => !byId.get(d.panelId)?.manual).flatMap(d => gateFlags(d, byId.get(d.panelId), ctx)))];
      return { action: lead.action, targetTilt: lead.targetTilt, targetAzimuth: lead.targetAzimuth, reason: lead.reason || '',
        source: lead.source, flags, decisions: proposals.map(d => ({ ...d })) };
    },

    same(a, b) {
      if (!a || !b || a.action !== b.action) return false;
      if (a.action === 'HOLD') return true;
      return Math.abs(a.targetTilt - b.targetTilt) <= GATE_CHANGE_DEG && normalAngleDeg(a.targetTilt, a.targetAzimuth, b.targetTilt, b.targetAzimuth) <= GATE_CHANGE_DEG;
    },

    hold(ctx, reason) {
      return ctx.panels.map(p => ({ panelId: p.panelId, action: 'HOLD', targetTilt: p.tiltDeg, targetAzimuth: p.azimuthDeg,
        expectedGainKW: 0, uncertainty: null, riskFlags: [], reason, source: 'gate' }));
    },

    record(card, by, ctx) {
      this.log.unshift({ at: new Date(), simTime: ctx?.simTime ?? null, mode: this.mode, action: card.action,
        targetTilt: card.targetTilt, targetAzimuth: card.targetAzimuth, flags: [...card.flags], by, reason: card.reason });
      if (this.log.length > GATE_LOG_MAX) this.log.length = GATE_LOG_MAX;
    },

    process(proposals, ctx) {
      this.lastCtx = ctx;
      const now = this.now();
      this.expire(now, ctx);
      if (!proposals.length) return proposals;
      const card = this.summarize(proposals, ctx);
      const needsHuman = this.mode === 'manual' || (this.mode === 'semi' && card.flags.length > 0);
      if (!needsHuman) {
        this.command = null;
        if (!this.same(card, this.lastAuto)) { this.record(card, 'IA (' + AUTONOMY_LABEL[this.mode] + ')', ctx); this.lastAuto = card; }
        return proposals;
      }
      this.lastAuto = null;
      if (!this.command) this.command = this.hold(ctx, 'En attente de validation : position maintenue.');
      const applied = this.command[0] && this.command[0].action !== 'HOLD' ? this.summarize(this.command, ctx) : null;
      const latest = this.queue[this.queue.length - 1];
      const alreadyApplied = applied && this.same(card, applied) || !applied && card.action === 'HOLD';
      if (!alreadyApplied && !this.same(card, latest) && now - this.lastCardAt >= GATE_MIN_CARD_INTERVAL_MS) this.enqueue(card, now, ctx);
      return this.command;
    },

    // Une nouvelle proposition remplace les cartes en attente ; un STOW (sécurité) n'est remplacé que par un STOW plus récent.
    enqueue(card, now, ctx) {
      this.queue = this.queue.filter(c => {
        if (c.action === 'STOW' && card.action !== 'STOW') return true;
        this.record(c, 'remplacée', ctx); return false;
      });
      this.queue.push({ ...card, id: this.nextId++, createdAt: now });
      this.lastCardAt = now;
    },

    expire(now, ctx) {
      this.queue = this.queue.filter(c => {
        if (now - c.createdAt < GATE_TIMEOUT_MS) return true;
        if (c.action === 'STOW') { this.command = c.decisions; this.record(c, 'auto (30 s sans réponse : sécurité)', ctx); }
        else this.record({ ...c, action: 'HOLD' }, `expirée (30 s) : ${c.action} → HOLD`, ctx);
        return false;
      });
    },

    approve(id) {
      const c = this.queue.find(x => x.id === id); if (!c) return false;
      this.queue = this.queue.filter(x => x !== c);
      this.command = c.decisions.map(d => ({ ...d, reason: d.reason }));
      this.record(c, 'humain (approuvée)', this.lastCtx);
      return true;
    },
    refuse(id) {
      const c = this.queue.find(x => x.id === id); if (!c) return false;
      this.queue = this.queue.filter(x => x !== c);
      this.record(c, 'humain (refusée)', this.lastCtx);
      return true;
    },
    // Reprise manuelle (suivi coupé) ou retour au pilotage automatique : journalisé.
    takeover(manual) {
      this.record({ action: manual ? 'HOLD' : '—', targetTilt: null, targetAzimuth: null, flags: [],
        reason: manual ? 'Reprise manuelle par l’opérateur.' : 'Pilotage rendu à l’IA.' }, 'humain', this.lastCtx);
      if (!manual) this.command = null;
    },
    remainingMs(card) { return Math.max(0, GATE_TIMEOUT_MS - (this.now() - card.createdAt)); },
  };
}
