/**
 * The project used to be called RideX. Carry its browser data (sign-in token, settings,
 * ship, personal bests) over to the new keys, once. Imported before anything reads storage.
 */
try {
  const old: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('ridex:')) old.push(k);
  }
  for (const k of old) {
    const next = `songsurf:${k.slice('ridex:'.length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k)!);
    localStorage.removeItem(k);
  }
} catch {
  /* storage unavailable: nothing to migrate */
}
