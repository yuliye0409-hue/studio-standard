const DB = 'studio-standard-v2';
function database() {
  return new Promise((resolve, reject) => { const req = indexedDB.open(DB, 1); req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'id' }); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
export async function saveProject(project) {
  const db = await database();
  try { await new Promise((resolve, reject) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put(structuredClone(project)); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
}
export async function listProjects() {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const req = db.transaction('projects').objectStore('projects').getAll(); req.onsuccess = () => resolve(req.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); req.onerror = () => reject(req.error); }); } finally { db.close(); }
}
