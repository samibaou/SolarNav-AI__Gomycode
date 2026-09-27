/* =========================================================================
   log.js — journal partage entre le tableau de bord et la page Journal

   Le stockage local est le seul canal disponible entre deux pages sans
   serveur. Il est volontairement borne : un journal qui grossit sans fin
   finirait par depasser le quota et faire echouer toutes les ecritures.
   ========================================================================= */

export const LOG_KEY = 'solarnav.log';
export const LOG_MAX = 500;

/** Lit le journal. Renvoie toujours un tableau, meme si le stockage est bloque. */
export function readLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Ajoute un evenement et renvoie le journal complet. */
export function appendLog(entry) {
  const list = readLog();
  list.push(entry);
  if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list));
  } catch {
    // quota atteint ou stockage refuse : le journal reste en memoire vive
  }
  return list;
}

/** Vide le journal — appele au demarrage d'une nouvelle session. */
export function resetLog() {
  try { localStorage.removeItem(LOG_KEY); } catch { }
}
