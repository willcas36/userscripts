// ==UserScript==
// @name         Tatoeba - Flashcards (Sentence Mining)
// @namespace    https://tatoeba.org/
// @version      4.95
// @description  Flashcards tipo Anki sobre la búsqueda filtrada de Tatoeba (mobile + teclado)
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tatoeba.org
// @match        https://tatoeba.org/*/sentences/search*
// @homepageURL  https://github.com/willcas36/userscripts/tree/main/tatoeba-flashcards
// @updateURL    https://raw.githubusercontent.com/willcas36/userscripts/main/tatoeba-flashcards/tatoeba-flashcards.user.js
// @downloadURL  https://raw.githubusercontent.com/willcas36/userscripts/main/tatoeba-flashcards/tatoeba-flashcards.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT_VERSION = '4.95';

  /* ============ STORAGE (backend local: GM_setValue, con fallback a localStorage) ============ */
  // Acá NO hay sync entre dispositivos: esto es solo el guardado LOCAL. El sync cruzado lo hace el Gist (más abajo).
  const GMget = typeof GM_getValue === 'function' ? GM_getValue : null;
  const GMset = typeof GM_setValue === 'function' ? GM_setValue : null;
  const GMdel = typeof GM_deleteValue === 'function' ? GM_deleteValue : null;
  const LS = {
    get: (k) => {
      if (GMget) {
        const v = GMget(k);
        return v === undefined ? null : v;
      }
      return localStorage.getItem(k);
    },
    set: (k, v) => {
      if (GMset) GMset(k, v);
      else localStorage.setItem(k, v);
      if (SYNC_KEYS.includes(k) && k !== 'sm-fc-open') gistPushDebounced(); // cambió config -> empujá al gist (sm-fc-open es efímero)
    },
    del: (k) => {
      if (GMdel) GMdel(k);
      else localStorage.removeItem(k);
    },
  };
  // FUENTE ÚNICA: la config de estudio vive SOLO en los perfiles. Esto es lo que se sincroniza:
  const SYNC_KEYS = [
    'sm-fc-profiles', // todos los perfiles (cada uno con su config completa)
    'sm-fc-active', // qué perfil está activo
    'sm-fc-dark', // modo oscuro (preferencia global sincronizada)
    'sm-fc-keys', // atajos de teclado (global)
    'sm-fc-gestures', // gestos mobile (global)
    'sm-fc-desktop-auto', // toggle "Auto" del modo ordenador (global, sincronizado; el modo manual NO se sincroniza)
  ];
  // Migración única: pasa la config que estaba en localStorage al storage GM (el backend local del script).
  (function migrateStorage() {
    try {
      if (!GMget || GMget('sm-fc-migrated') === '1') return;
      for (const k of SYNC_KEYS) {
        const v = localStorage.getItem(k);
        if (v != null && GMget(k) === undefined) GMset(k, v);
      }
      GMset('sm-fc-migrated', '1');
    } catch (e) {
      /* sin localStorage o sin GM: seguimos */
    }
  })();
  /* ============ AUTO-SYNC (GitHub Gist privado) ============ */
  const SYNC_FILE = 'tatoeba-flashcards-config.json';
  const ghToken = () => LS.get('sm-fc-gh-token') || ''; // token guardado por la UI, local a cada dispositivo (nunca en el repo público)
  let suppressPush = false,
    pushTimer = null;
  function ghReq(method, path, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function')
        return reject(new Error('sin GM_xmlhttpRequest'));
      let url = 'https://api.github.com' + path;
      if (method === 'GET')
        url += (path.includes('?') ? '&' : '?') + '_=' + Date.now(); // cache-bust: GitHub sirve el gist cacheado tras un PATCH
      GM_xmlhttpRequest({
        method,
        url,
        timeout: 15000,
        nocache: true,
        headers: {
          Authorization: 'token ' + ghToken(),
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          try {
            const j = r.responseText ? JSON.parse(r.responseText) : {};
            r.status >= 200 && r.status < 300
              ? resolve(j)
              : reject(new Error('GitHub ' + r.status));
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('error de red')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }
  async function gistFindId() {
    const cached = LS.get('sm-fc-gist-id');
    if (cached) return cached;
    const gists = await ghReq('GET', '/gists?per_page=100');
    const found = (gists || []).find((g) => g.files && g.files[SYNC_FILE]);
    if (found) {
      LS.set('sm-fc-gist-id', found.id);
      return found.id;
    }
    return null;
  }
  async function gistPush() {
    if (!ghToken()) return;
    const payload = { updated: Date.now(), data: {} };
    SYNC_KEYS.forEach((k) => {
      const v = LS.get(k);
      if (v != null) payload.data[k] = v;
    });
    const files = { [SYNC_FILE]: { content: JSON.stringify(payload) } };
    const id = await gistFindId();
    const res = id
      ? await ghReq('PATCH', '/gists/' + id, { files })
      : await ghReq('POST', '/gists', {
          description: 'Tatoeba Flashcards config',
          public: false,
          files,
        });
    if (res && res.id) LS.set('sm-fc-gist-id', res.id);
    LS.set('sm-fc-sync-ts', String(payload.updated)); // no está en SYNC_KEYS -> no re-dispara push
  }
  async function gistPull() {
    if (!ghToken()) return false;
    const id = await gistFindId();
    if (!id) return false;
    const g = await ghReq('GET', '/gists/' + id);
    const file = g.files && g.files[SYNC_FILE];
    if (!file || !file.content) return false;
    const payload = JSON.parse(file.content);
    const localTs = parseInt(LS.get('sm-fc-sync-ts') || '0', 10);
    if (!(payload.updated > localTs)) return false; // nada más nuevo
    // PROTECCIÓN: si hay cambios sin guardar (Aplicar/dirty), avisá antes de pisarlos con lo de la nube.
    if (dirty) {
      const ok = await confirmDialog(
        'Hay config más nueva en la nube, pero tenés cambios SIN GUARDAR. ¿Descartar los tuyos y bajar lo de la nube?',
        'Descartar y bajar',
      );
      if (!ok) return false;
    }
    suppressPush = true;
    try {
      Object.keys(payload.data || {})
        .filter((k) => SYNC_KEYS.includes(k)) // ignorá claves que no se sincronizan (ej. sm-fc-desktop viejo)
        .forEach((k) => LS.set(k, String(payload.data[k])));
    } finally {
      suppressPush = false;
    }
    LS.set('sm-fc-sync-ts', String(payload.updated));
    return true;
  }
  function gistPushDebounced() {
    if (!ghToken() || suppressPush) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      gistPush()
        .then(() => toast('Config sincronizada ☁︎', true))
        .catch((e) => toast('Sync falló: ' + e.message, false));
    }, 1500);
  }

  /* ===== Caché de "Agregadas recientemente" (sincronizado por gist, UN ARCHIVO POR LISTA) =====
     La API de Tatoeba no expone cuándo agregaste una oración a TU lista, así que lo
     registramos nosotros al agregar por la app. Cada entrada tiene la forma de un objeto
     de la API (id/lang/text/owner/translations) + ts, así el render reusa buildListRow.
     Local: un solo blob {listId:{sid:entry}}. Gist: un archivo por lista (push más chico,
     y el límite de 1MB de GitHub aplica por archivo, no al total entre listas). */
  const OLD_SYNC_FILE_CACHE = 'tatoeba-flashcards-listcache.json'; // formato viejo (un solo archivo) -> se migra al leer
  const LIST_CACHE_KEY = 'sm-fc-listcache';
  const cacheFileName = (lid) => `tatoeba-flashcards-list-${lid}.json`;
  const CACHE_FILE_RE = /^tatoeba-flashcards-list-(.+)\.json$/;
  let cachePushTimer = null;
  const cacheDirtyLists = new Set();

  function loadListCache() {
    try {
      return JSON.parse(LS.get(LIST_CACHE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveListCache(obj) {
    LS.set(LIST_CACHE_KEY, JSON.stringify(obj)); // local-only: no está en SYNC_KEYS -> no auto-push de config
  }
  // Fusiona un mapa {sid:entry} dentro del caché local de una lista (unión; gana el ts más nuevo).
  function mergeListInto(merged, lid, remote) {
    const into = (merged[lid] = merged[lid] || {});
    for (const sid of Object.keys(remote || {})) {
      const a = into[sid],
        b = remote[sid];
      if (!a || (b && (b.ts || 0) > (a.ts || 0))) into[sid] = b;
    }
  }
  function cacheAdd(listId, c) {
    const cache = loadListCache();
    const byId = (cache[listId] = cache[listId] || {});
    byId[String(c.id)] = {
      ts: Date.now(),
      id: c.id,
      lang: c.lang,
      text: c.text,
      owner: c.owner,
      translations: (c.translations || []).map((t) => ({
        lang: t.lang,
        text: t.text,
        id: t.id,
        owner: t.owner,
      })),
    };
    saveListCache(cache);
    gistPushCacheDebounced(listId);
  }
  function cacheRemove(listId, id) {
    const cache = loadListCache();
    if (cache[listId] && cache[listId][String(id)]) {
      delete cache[listId][String(id)];
      saveListCache(cache);
      gistPushCacheDebounced(listId);
    }
  }
  // Sube SOLO los archivos de las listas que cambiaron (un archivo por lista).
  async function flushCachePush(listIds) {
    if (!ghToken() || !listIds.length) return;
    const id = await gistFindId();
    if (!id) return; // el gist lo crea el archivo de config; el caché se suma si ya existe
    const cache = loadListCache();
    const files = {};
    for (const lid of listIds) {
      files[cacheFileName(lid)] = {
        content: JSON.stringify({
          updated: Date.now(),
          listId: lid,
          cache: cache[lid] || {},
        }),
      };
    }
    await ghReq('PATCH', '/gists/' + id, { files });
  }
  function gistPushCacheDebounced(listId) {
    if (!ghToken()) return;
    cacheDirtyLists.add(String(listId));
    clearTimeout(cachePushTimer);
    cachePushTimer = setTimeout(() => {
      const lists = [...cacheDirtyLists];
      cacheDirtyLists.clear();
      flushCachePush(lists).catch(() => {}); // best-effort: el local ya quedó bien; el próximo pull reconcilia
    }, 1500);
  }
  // Empuja todas las listas locales (lo usa el botón Sync manual).
  function gistPushCacheAll() {
    return flushCachePush(Object.keys(loadListCache()));
  }
  // Trae TODOS los archivos de caché del gist (un solo GET) y los fusiona con el local.
  async function gistPullCache() {
    if (!ghToken()) return;
    const id = await gistFindId();
    if (!id) return;
    const g = await ghReq('GET', '/gists/' + id);
    const files = g.files || {};
    const merged = loadListCache();
    // Migración: si quedó el archivo viejo combinado, fusionalo (formato {listId:{sid:entry}}).
    const oldFile = files[OLD_SYNC_FILE_CACHE];
    if (oldFile && oldFile.content) {
      try {
        const oldCache = (JSON.parse(oldFile.content) || {}).cache || {};
        for (const lid of Object.keys(oldCache))
          mergeListInto(merged, lid, oldCache[lid]);
      } catch (e) {
        /* archivo viejo corrupto: ignorar */
      }
    }
    // Formato nuevo: un archivo por lista.
    for (const fname of Object.keys(files)) {
      const m = fname.match(CACHE_FILE_RE);
      if (!m) continue;
      const f = files[fname];
      if (!f || !f.content) continue;
      try {
        const payload = JSON.parse(f.content) || {};
        mergeListInto(merged, payload.listId || m[1], payload.cache || {});
      } catch (e) {
        /* archivo corrupto: seguir con los demás */
      }
    }
    saveListCache(merged);
  }

  /* ============ CONFIGURACIÓN ============ */
  let LIST_ID = LS.get('sm-fc-listid') || '174916'; // lista objetivo (editable en el modal)

  const FETCH_DEFAULTS = {
    query: '',
    from: 'eng',
    word_min: '5',
    word_max: '',
    user: '',
    origin: 'original',
    orphans: 'no',
    unapproved: 'no',
    native: 'yes',
    has_audio: 'yes',
    tags: '',
    list: '',
    trans_to: 'spa',
    trans_link: 'direct',
    trans_user: '',
    trans_orphan: '',
    trans_unapproved: 'no',
    trans_native: '',
    trans_has_audio: '',
    sort: 'random',
    sort_reverse: false,
  };
  const DISPLAY_DEFAULT = { front: 'spa', back: 'eng' };

  // Teclado (valor de event.key): Enter, ' ' (espacio), ';', '/', '.', ',', etc.
  // Acciones disponibles para gestos y atajos (id -> etiqueta).
  const ACTIONS = [
    { id: '', label: 'Ninguno' },
    { id: 'next', label: 'Siguiente' },
    { id: 'prev', label: 'Anterior' },
    { id: 'reveal', label: 'Revelar / Siguiente' },
    { id: 'audio', label: 'Audio (play/stop)' },
    { id: 'addList', label: 'Agregar a la lista' },
    { id: 'removeList', label: 'Quitar de la lista' },
    { id: 'list', label: 'Abrir/cerrar Mi lista' },
    { id: 'history', label: 'Abrir/cerrar Historial' },
    { id: 'config', label: 'Abrir configuración' },
  ];
  const actionLabel = (id) =>
    (ACTIONS.find((a) => a.id === id) || { label: id }).label;
  const KEY_ACTS = [
    'reveal',
    'next',
    'prev',
    'audio',
    'addList',
    'removeList',
    'list',
    'history',
    'config',
  ];
  const keyLabel = (k) => (k === ' ' ? 'Espacio' : k || 'Sin asignar');
  const gestOpts = (sel) =>
    ACTIONS.map(
      (a) =>
        `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${a.label}</option>`,
    ).join('');
  const KEYS_DEFAULT = {
    reveal: 'Enter',
    next: "'",
    prev: ';',
    audio: '/',
    addList: '.',
    removeList: ',',
    list: '[',
    history: ']',
    config: '\\',
  };
  const GESTURES_DEFAULT = {
    up: 'removeList',
    down: 'config',
    left: 'next',
    right: 'prev',
  };
  const loadObj = (k, def) => {
    try {
      return Object.assign({}, def, JSON.parse(LS.get(k) || '{}'));
    } catch (e) {
      return Object.assign({}, def);
    }
  };
  let KEYS = loadObj('sm-fc-keys', KEYS_DEFAULT); // atajos de teclado (sincronizable)
  let GESTURES = loadObj('sm-fc-gestures', GESTURES_DEFAULT); // gestos mobile (sincronizable)

  const TOP_ZONE_PERCENT = 45;
  const SIDE_ZONE_PERCENT = 30;
  const SWIPE_MIN = 55;
  const SWIPE_MAX_TIME = 600;
  const EDGE_GUARD = 30;

  const PREFETCH_AT = 4;
  const DARK_DEFAULT = false;
  let AUDIO_LANG = LS.get('sm-fc-audiolang') || 'eng'; // idioma del audio (editable en el modal)
  // Modo ordenador. "Auto" (global + sincronizado) detecta pantalla chica/móvil; si está OFF,
  // manda el modo MANUAL (local por dispositivo, no sincronizado). DESKTOP_MODE es el efectivo.
  const smallScreenMQ = window.matchMedia('(max-width: 820px)');
  const detectDesktop = () => !smallScreenMQ.matches; // pantalla grande -> modo ordenador
  let DESKTOP_AUTO = LS.get('sm-fc-desktop-auto') !== '0'; // default: ON
  const effectiveDesktop = () =>
    DESKTOP_AUTO ? detectDesktop() : LS.get('sm-fc-desktop') === '1';
  let DESKTOP_MODE = effectiveDesktop(); // PC: paneles laterales que empujan + atajos [ ]
  let START_REVEALED = LS.get('sm-fc-startrevealed') === '1'; // al navegar, mostrar la carta ya revelada (default: oculta)
  const PROFILE_DEFAULT = 'Predeterminado'; // perfil base, no se puede borrar
  let activeProfile = LS.get('sm-fc-active') || PROFILE_DEFAULT;
  let dirty = false; // hay cambios aplicados (Aplicar) pero NO guardados en el perfil (no subidos)
  const API_BASE = 'https://api.tatoeba.org/v1'; // API oficial ESTABLE y versionada (no /unstable, que cambia)

  const LANGUAGES = [
    { code: 'spa', name: 'Español' },
    { code: 'eng', name: 'Inglés' },
    { code: 'fra', name: 'Francés' },
    { code: 'ita', name: 'Italiano' },
    { code: 'deu', name: 'Alemán' },
    { code: 'por', name: 'Portugués' },
    { code: 'jpn', name: 'Japonés' },
    { code: 'rus', name: 'Ruso' },
    { code: 'cmn', name: 'Chino mandarín' },
    { code: 'kor', name: 'Coreano' },
  ];

  // Idiomas para "Mi lista" (amplio: la lista puede tener oraciones de cualquier idioma). Agregá códigos si te falta alguno.
  const LIST_LANGS =
    'spa,eng,fra,ita,deu,por,jpn,rus,cmn,kor,epo,nld,tur,pol,ukr,heb,ara,fin,hun,ces,swe,ell,ron,lat,cat,ind,vie,dan,nob,lit';

  const LIST_DISPLAY_DEFAULT = { front: 'spa', back: 'eng' };
  // Config de fábrica (la del perfil Predeterminado). Coincide con la URL base de la API.
  const DEFAULT_CONFIG = {
    filters: { ...FETCH_DEFAULTS },
    display: { ...DISPLAY_DEFAULT },
    listDisplay: { ...LIST_DISPLAY_DEFAULT },
    listId: '174916',
    audioLang: 'eng',
    listSort: '-created',
    startRevealed: false,
  };

  const K = {
    filters: 'sm-fc-filters',
    display: 'sm-fc-display',
    listDisplay: 'sm-fc-list-display',
    open: 'sm-fc-open',
    dark: 'sm-fc-dark',
  };
  /* ====================================== */

  let filters = (() => {
    try {
      return Object.assign(
        {},
        FETCH_DEFAULTS,
        JSON.parse(LS.get(K.filters) || '{}'),
      );
    } catch (e) {
      return Object.assign({}, FETCH_DEFAULTS);
    }
  })();

  let DISPLAY = (() => {
    try {
      return Object.assign(
        {},
        DISPLAY_DEFAULT,
        JSON.parse(LS.get(K.display) || '{}'),
      );
    } catch (e) {
      return Object.assign({}, DISPLAY_DEFAULT);
    }
  })();

  let LIST_DISPLAY = (() => {
    try {
      return Object.assign(
        {},
        LIST_DISPLAY_DEFAULT,
        JSON.parse(LS.get(K.listDisplay) || '{}'),
      );
    } catch (e) {
      return Object.assign({}, LIST_DISPLAY_DEFAULT);
    }
  })();
  const saveListDisplay = () => saveActive();
  let listSort = LS.get('sm-fc-listsort') || '-created'; // orden de "Mi lista" (sort de la API)
  // Escribe el estado actual (globals) en el perfil activo y persiste el mapa de perfiles -> dispara el sync.
  function saveActive() {
    const profs = loadProfiles();
    profs[activeProfile] = snapshotFromGlobals();
    saveProfilesMap(profs);
    dirty = false;
    updateId();
  }

  const langSeg = () =>
    (location.pathname.match(/^\/([a-z]{2,3})\//) || [, 'es'])[1];

  function makeIcon(name) {
    const i = document.createElement('span');
    i.className = 'material-icons';
    i.textContent = name;
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  // Toast INTEGRADO (no depende del script de notificaciones), animado y con tema.
  let toastEl, toastTimer;
  const TOAST_ICONS = {
    check:
      '<svg class="fc-toast-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M7 12.4l3.4 3.4L17 8.6"/></svg>',
    x: '<svg class="fc-toast-x" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2"/></svg>',
  };
  function toastBody(iconHtml, message) {
    // icono SVG controlado + texto por textContent (seguro)
    toastEl.innerHTML = iconHtml + '<span class="fc-toast-txt"></span>';
    toastEl.querySelector('.fc-toast-txt').textContent = message;
  }
  // Loader: spinner girando, sin auto-cierre (la operación sigue en curso).
  function toastLoading(message) {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastBody('<span class="fc-toast-spin"></span>', message);
    toastEl.className = 'show loading';
  }
  // Resultado: el spinner se transforma en check/x dibujado y el fondo hace fade; arranca el auto-cierre.
  function toastResult(message, ok) {
    if (!toastEl) return;
    toastBody(ok ? TOAST_ICONS.check : TOAST_ICONS.x, message);
    toastEl.className = ok ? 'show ok' : 'show err';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }
  // Toast simple (sin icono) para el resto de mensajes.
  function toast(message, ok) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = ok ? 'show ok' : 'show err';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // En la API nueva el dueño viene como string `owner` (no `user.username`) y las traducciones son un array PLANO.
  function getTextByLang(card, lang) {
    if (card.lang === lang)
      return {
        text: card.text,
        audios: card.audios || [],
        id: card.id,
        owner: card.owner,
      };
    const t = (card.translations || []).find((x) => x.lang === lang);
    if (t)
      return { text: t.text, audios: t.audios || [], id: t.id, owner: t.owner };
    return null;
  }
  const frontOf = (c) =>
    getTextByLang(c, DISPLAY.front) || {
      text: c.text,
      audios: c.audios || [],
      id: c.id,
      owner: c.owner,
    };
  const backOf = (c) =>
    getTextByLang(c, DISPLAY.back) || {
      text: '(sin traducción)',
      audios: [],
      id: null,
      owner: null,
    };

  /* ============ API (api.tatoeba.org) ============ */

  function wordRange(min, max) {
    min = (min == null ? '' : String(min)).trim();
    max = (max == null ? '' : String(max)).trim();
    return min || max ? `${min}-${max}` : ''; // "2-15", "2-", "-15"
  }

  function buildQuery() {
    const f = filters;
    const p = new URLSearchParams();
    p.set('lang', f.from); // from -> lang
    p.set('sort', (f.sort_reverse ? '-' : '') + (f.sort || 'random')); // sort_reverse -> prefijo '-'
    p.set('showtrans', 'matching'); // mostrar solo las traducciones que matchean trans:lang
    p.set('include', 'audios'); // trae el audio en el mismo payload
    p.set('limit', '20');
    if (f.query) p.set('q', f.query); // query -> q
    if (f.user) p.set('owner', f.user); // user -> owner
    if (f.origin) p.set('origin', f.origin); // original/translation/known/unknown
    if (f.orphans) p.set('is_orphan', f.orphans);
    if (f.unapproved) p.set('is_unapproved', f.unapproved);
    if (f.native) p.set('is_native', f.native);
    if (f.has_audio) p.set('has_audio', f.has_audio);
    if (f.list) p.set('list', f.list);
    if (f.tags)
      f.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((t) => p.append('tag', t));
    const wc = wordRange(f.word_min, f.word_max);
    if (wc) p.set('word_count', wc);
    // --- Traducciones ---
    if (f.trans_to) p.set('trans:lang', f.trans_to); // restringe a oraciones CON traducción en ese idioma
    if (f.trans_link === 'direct') p.set('trans:is_direct', 'yes');
    else if (f.trans_link === 'indirect') p.set('trans:is_direct', 'no');
    if (f.trans_user) p.set('trans:owner', f.trans_user);
    if (f.trans_orphan) p.set('trans:is_orphan', f.trans_orphan);
    if (f.trans_unapproved) p.set('trans:is_unapproved', f.trans_unapproved);
    if (f.trans_native) p.set('trans:is_native', f.trans_native);
    if (f.trans_has_audio) p.set('trans:has_audio', f.trans_has_audio);
    return p.toString();
  }

  // Acepta un query string (lo arma sobre API_BASE) o una URL completa (cursor `paging.next`).
  async function apiSearch(qsOrUrl) {
    const url = /^https?:/.test(qsOrUrl)
      ? qsOrUrl
      : `${API_BASE}/sentences?${qsOrUrl}`;
    const res = await fetch(url, {
      credentials: 'omit',
      signal: currentAbort ? currentAbort.signal : undefined,
    }); // API pública -> sin cookies (evita líos de CORS)
    return res.json();
  }

  /* ============ MAZO + HISTORIAL ============ */

  let cards = [],
    index = -1,
    fetching = false,
    nextUrl = null,
    maxSeen = -1; // maxSeen = índice más alto visitado (el historial no se recorta al retroceder)
  let totalCount = null; // paging.total -> cuántas oraciones matchean los filtros en TODO Tatoeba
  let deckGen = 0,
    currentAbort = null; // anti-race: cada búsqueda nueva incrementa gen y aborta la anterior
  const seenIds = new Set();
  const currentCard = () => cards[index] || null;

  async function fetchBatch() {
    // Primera vez: arma el query (nueva búsqueda random). Después: sigue el cursor `paging.next`.
    const myGen = deckGen;
    const data = await apiSearch(nextUrl || buildQuery());
    if (myGen !== deckGen) return 0; // otra búsqueda más nueva tomó el control -> no contamines el mazo
    if (data.paging && typeof data.paging.total === 'number')
      totalCount = data.paging.total;
    nextUrl = data.paging && data.paging.has_next ? data.paging.next : null;
    let added = 0;
    for (const r of data.data || []) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        cards.push(r);
        added++;
      }
    }
    return added;
  }
  async function ensureBuffer(force) {
    if (!force && cards.length - 1 - index > PREFETCH_AT) return;
    if (fetching) return;
    fetching = true;
    try {
      let n = 0;
      while ((await fetchBatch()) === 0 && n++ < 3) {}
    } catch (e) {
      if (e.name !== 'AbortError') toast('Error trayendo oraciones', false);
    } finally {
      fetching = false;
      updateId();
    }
  }
  async function next() {
    if (index >= cards.length - 1) await ensureBuffer(true);
    if (index < cards.length - 1) {
      index++;
      render();
      ensureBuffer();
    } else toast('Sin más oraciones', false);
  }
  const prev = () => {
    if (index > 0) {
      index--;
      render();
    } else toast('Estás en la primera', false);
  };
  const jumpTo = (i) => {
    if (i >= 0 && i < cards.length) {
      index = i;
      render();
      closePanels();
    }
  };

  /* ============ ACCIONES ============ */

  // El audio (inglés) es spoiler si NO está en el frente -> se gatea hasta revelar.
  const audioGated = () => DISPLAY.front !== AUDIO_LANG && !revealed;

  let currentAudio = null,
    currentAudioUrl = null; // reusa el audio para no re-bajarlo ni superponer

  function setAudioLoading(on) {
    const btn = barEl && barEl.querySelector('[data-act="audio"]');
    if (!btn) return;
    if (on) {
      btn.innerHTML = '<span class="fc-spin"></span>';
    } else {
      btn.innerHTML = '';
      btn.appendChild(makeIcon('play_arrow'));
    }
  }
  function setAudioIcon(name) {
    const btn = barEl && barEl.querySelector('[data-act="audio"]');
    if (!btn) return;
    btn.innerHTML = '';
    btn.appendChild(makeIcon(name)); // 'play_arrow' (parado) o 'stop' (reproduciendo)
  }

  function playAudio() {
    if (audioGated()) return; // inglés en el dorso y sin revelar -> bloqueado (click, teclado y zona)
    const c = currentCard();
    if (!c) return;
    const en = getTextByLang(c, AUDIO_LANG); // SIEMPRE el audio en inglés, sin importar el display
    if (!en || !en.audios || !en.audios.length) {
      const name =
        (LANGUAGES.find((l) => l.code === AUDIO_LANG) || {}).name || AUDIO_LANG;
      toast(`No hay audio en ${name.toLowerCase()}`, false);
      return;
    }
    const url = `${API_BASE}/audios/${en.audios[0].id}/file`; // el download_url de la API viene roto (/audio/ singular -> 404); uso /audios/ (plural)

    // Mismo audio ya cargado -> TOGGLE: si está sonando, cancelar; si está parado, volver a empezar.
    if (currentAudio && currentAudioUrl === url) {
      if (!currentAudio.paused) {
        currentAudio.pause(); // reproduciendo -> cancelar (el evento 'pause' pone el ícono ▶)
        currentAudio.currentTime = 0; // la próxima empieza de cero
      } else {
        currentAudio.currentTime = 0;
        currentAudio.play().catch(() => {}); // parado -> empezar de nuevo (el evento 'playing' pone ■)
      }
      return;
    }

    // Audio distinto -> cortamos el anterior y cargamos el nuevo.
    if (currentAudio) currentAudio.pause();
    const a = new Audio(url);
    currentAudio = a;
    currentAudioUrl = url;

    setAudioLoading(true);
    let loaded = false;
    const clearLoader = () => {
      if (loaded) return;
      loaded = true;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      clearLoader();
      setAudioIcon('play_arrow');
    }, 8000); // red colgada -> liberamos el loader igual
    // Listeners persistentes (no 'once') -> el ícono refleja play/stop en cada toggle.
    a.addEventListener('playing', () => {
      clearLoader();
      setAudioIcon('stop');
    });
    a.addEventListener('pause', () => setAudioIcon('play_arrow'));
    a.addEventListener('ended', () => setAudioIcon('play_arrow'));
    a.addEventListener('error', () => {
      clearLoader();
      setAudioIcon('play_arrow');
      toast('No se pudo reproducir', false);
    });
    a.play().catch(() => {
      clearLoader();
      setAudioIcon('play_arrow');
      toast('No se pudo reproducir', false);
    });
  }
  async function listAction(endpoint, id) {
    // fetch crudo, sin notificar (lo usa el borrado masivo)
    try {
      const r = await fetch(
        `/${langSeg()}/sentences_lists/${endpoint}/${id}/${LIST_ID}`,
        {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        },
      );
      return r.ok;
    } catch (e) {
      return false;
    }
  }
  async function listById(endpoint, id, msg) {
    // El loader ya está visible (toastLoading). Acá lo cerramos transformándolo en el resultado.
    const started = performance.now();
    const ok = await listAction(endpoint, id);
    const elapsed = performance.now() - started;
    // Mínimo de 400ms para que la animación spinner -> check siempre se vea (sin parpadeo).
    if (elapsed < 400)
      await new Promise((r) => setTimeout(r, 400 - elapsed));
    toastResult(ok ? `Oración ${msg}` : 'No se pudo (¿logueado?)', ok);
    return ok;
  }
  const addCurrent = () => {
    const c = currentCard();
    if (!c) return;
    toastLoading('Agregando oración');
    listById('add_sentence_to_list', c.id, 'agregada').then((ok) => {
      if (ok) {
        cacheAdd(LIST_ID, c); // solo si el agregado OFICIAL fue OK -> nunca divergen
        syncListAdd(c);
      }
    });
  };
  const removeCurrent = () => {
    const c = currentCard();
    if (!c) return;
    toastLoading('Quitando oración');
    listById('remove_sentence_from_list', c.id, 'quitada').then((ok) => {
      if (ok) {
        cacheRemove(LIST_ID, c.id);
        listRemoveRow(c.id);
      }
    });
  };

  /* ============ ESTILOS ============ */

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      /* Tema scopeado a MIS raíces (overlay/panel/modal viven en <body>, por eso las vars se definen en los 3). */
      #fc-overlay, .fc-panel, #fc-modal, #fc-confirm, #fc-prompt, #fc-toast { --bg:#fafafa; --fg:#222; --muted:#8a8a8a; --card:#fff; --line:#e6e6e6;
        --btn:#ececec; --btnfg:#444; --accent:#4b8b3b; --back:#2e7d32;
        --rm-bg:#fde7e7; --rm-fg:#c62828; --go-bg:#e8f0e6; --go-fg:#2e7d32; --shadow:rgba(0,0,0,.18); }
      .fc-dark #fc-overlay, .fc-dark .fc-panel, .fc-dark #fc-modal, .fc-dark #fc-confirm, .fc-dark #fc-prompt, .fc-dark #fc-toast { --bg:#16161a; --fg:#ececf0; --muted:#9a9aa3;
        --card:#26262b; --line:#34343b; --btn:#34343b; --btnfg:#e2e2e8; --accent:#6bbf59; --back:#7ecb6a;
        --rm-bg:rgba(229,115,115,.16); --rm-fg:#ef9a9a; --go-bg:rgba(124,203,106,.16); --go-fg:#a5d6a7; --shadow:rgba(0,0,0,.55); }
      #fc-overlay { position:fixed; inset:0; z-index:2147483000; background:var(--bg); color:var(--fg);
        display:flex; flex-direction:column; font-family:sans-serif; transition:padding-right .25s ease; }
      #fc-overlay.panel-push { padding-right:min(88vw,380px); }
      #fc-overlay.hidden { display:none; }
      #fc-overlay .material-icons { line-height:1; font-size:inherit; color:inherit; display:block; }
      #fc-top { display:flex; align-items:flex-start; gap:8px; padding:calc(env(safe-area-inset-top,0px) + 8px) 12px 8px; }
      #fc-id { font-size:12px; color:var(--muted); font-weight:600; line-height:1.2; margin-right:auto; padding-top:1px; }
      #fc-id .fc-prof { color:var(--fg); font-weight:700; font-size:13px; margin-bottom:2px; }
      #fc-id .fc-dirty { color:#e0a000; font-weight:600; font-size:11px; }
      #fc-id .fc-total { color:var(--accent); font-weight:700; margin-bottom:2px; }
      .fc-spin { width:22px; height:22px; border:2.5px solid currentColor; border-top-color:transparent; border-radius:50%; opacity:.7; animation:fc-spin-rot .7s linear infinite; }
      @keyframes fc-spin-rot { to { transform:rotate(360deg); } }
      #fc-top .spacer { flex:1; }
      .fc-icon { width:42px; height:42px; border:none; border-radius:50%; background:var(--btn); color:var(--btnfg);
        cursor:pointer; display:inline-flex; align-items:center; justify-content:center; padding:0; flex:0 0 auto; }
      .fc-icon .material-icons { font-size:23px; }
      #fc-stage { position:relative; flex:1; }
      #fc-card { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
        justify-content:safe center; text-align:center; padding:22px; gap:18px; overflow:hidden;
        font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
      #fc-front { font-size:31px; line-height:1.45; font-weight:700; letter-spacing:.2px; }
      #fc-back { font-size:24px; line-height:1.5; font-weight:500; color:var(--back); border-top:1px solid rgba(128,128,128,.35); padding-top:16px; }
      #fc-back.fc-reveal, #fc-owners.fc-reveal { animation:fc-revealIn .26s cubic-bezier(.2,.7,.3,1) both; }
      #fc-owners.fc-reveal { animation-delay:.07s; }
      @keyframes fc-revealIn { from { opacity:0; transform:translateY(9px); } to { opacity:1; transform:translateY(0); } }
      #fc-owners { font-size:12px; color:var(--muted); min-height:1.3em; position:relative; z-index:5; }
      #fc-owners .fc-owner-link { color:var(--accent); text-decoration:none; cursor:pointer; }
      #fc-hint { font-size:13px; color:var(--muted); opacity:.7; }
      .fc-dots::after { content:'•••'; letter-spacing:2px; animation:fc-blink 1.1s ease-in-out infinite; }
      @keyframes fc-blink { 0%,100%{opacity:.25} 50%{opacity:1} }
      #fc-loading { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:18px; background:var(--bg); }
      #fc-loading.on { display:flex; }
      .fc-load-dots { display:flex; gap:12px; }
      .fc-load-dots span { width:13px; height:13px; border-radius:50%; background:var(--accent); animation:fc-bounce 1s ease-in-out infinite; }
      .fc-load-dots span:nth-child(2) { animation-delay:.16s; }
      .fc-load-dots span:nth-child(3) { animation-delay:.32s; }
      @keyframes fc-bounce { 0%,80%,100% { transform:scale(.5); opacity:.4 } 40% { transform:scale(1); opacity:1 } }
      #fc-loading .lbl { font-size:13px; color:var(--muted); animation:fc-blink 1.4s ease-in-out infinite; }
      #fc-zones { position:absolute; inset:0; display:none; flex-direction:column; }
      #fc-zones.on { display:flex; }
      .fc-zone { border:none; background:transparent; padding:0; cursor:pointer; -webkit-tap-highlight-color:transparent; }
      .fc-zrow { display:flex; flex:1; }
      #fc-bar { display:flex; gap:8px; padding:10px; padding-bottom:calc(env(safe-area-inset-bottom,0px) + 10px);
        background:var(--card); border-top:1px solid var(--line); }
      .fc-btn { flex:1; height:46px; border:none; border-radius:10px; background:var(--btn); color:var(--btnfg);
        cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .fc-btn .material-icons { font-size:26px; }
      .fc-btn:disabled { opacity:.3; }
      .fc-btn.fc-primary { background:var(--accent); color:#fff; }
      #fc-toast { position:fixed; left:50%; bottom:calc(env(safe-area-inset-bottom,0px) + 78px);
        transform:translateX(-50%) translateY(16px); z-index:2147483700; padding:10px 18px; border-radius:22px;
        font-size:14px; color:#fff; box-shadow:0 4px 16px rgba(0,0,0,.35); opacity:0; pointer-events:none;
        max-width:86vw; text-align:center; display:flex; align-items:center; justify-content:center; gap:9px;
        transition:opacity .25s ease, transform .25s ease, left .25s ease, background-color .3s ease; }
      .fc-push #fc-toast { left:calc(50% - min(88vw,380px) / 2); }   /* centrado sobre el contenido (el toast vive en body) */
      #fc-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
      #fc-toast.loading { background:#3a3a42; }
      #fc-toast.ok { background:var(--accent,#4b8b3b); }
      #fc-toast.err { background:#c62828; }
      #fc-toast .fc-toast-txt { flex:0 1 auto; text-align:left; }
      #fc-toast .fc-toast-spin, #fc-toast .fc-toast-check, #fc-toast .fc-toast-x { flex:0 0 auto; }
      #fc-toast .fc-toast-spin { width:18px; height:18px; box-sizing:border-box; border:2.5px solid rgba(255,255,255,.35); border-top-color:#fff; border-radius:50%; animation:fc-spin-rot .6s linear infinite; }
      #fc-toast .fc-toast-check, #fc-toast .fc-toast-x { width:18px; height:18px; display:block; }
      #fc-toast .fc-toast-check circle, #fc-toast .fc-toast-x circle { fill:none; stroke:rgba(255,255,255,.85); stroke-width:2; stroke-dasharray:63; stroke-dashoffset:63; animation:fc-toast-draw .35s ease forwards; }
      #fc-toast .fc-toast-check path { fill:none; stroke:#fff; stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:20; stroke-dashoffset:20; animation:fc-toast-draw .25s .26s ease forwards; }
      #fc-toast .fc-toast-x path { fill:none; stroke:#fff; stroke-width:2.6; stroke-linecap:round; stroke-dasharray:30; stroke-dashoffset:30; animation:fc-toast-draw .22s .26s ease forwards; }
      @keyframes fc-toast-draw { to { stroke-dashoffset:0; } }
      #fc-launcher { position:fixed; right:16px; bottom:calc(env(safe-area-inset-bottom,0px) + 16px); z-index:2147483000;
        width:52px; height:52px; border:none; border-radius:50%; background:#4b8b3b; color:#fff;
        box-shadow:0 3px 10px rgba(0,0,0,.3); cursor:pointer; display:none; align-items:center; justify-content:center; }
      #fc-launcher.show { display:flex; }
      .fc-panel { position:fixed; top:0; right:0; height:100%; width:min(88vw,380px); z-index:2147483500;
        background:var(--bg,#fff); color:var(--fg,#222); transform:translateX(100%); transition:transform .25s ease;
        display:flex; flex-direction:column; box-shadow:-2px 0 18px var(--shadow); }
      .fc-panel.open { transform:translateX(0); }
      .fc-panel-backdrop { position:fixed; inset:0; z-index:2147483499; background:rgba(0,0,0,.35);
        opacity:0; pointer-events:none; transition:opacity .25s ease; }
      .fc-panel-backdrop.open { opacity:1; pointer-events:auto; }
      .fc-panel header { display:flex; align-items:center; gap:8px; padding:calc(env(safe-area-inset-top,0px) + 14px) 14px 14px;
        border-bottom:1px solid var(--line,#eee); font-weight:600; }
      .fc-panel header .spacer { flex:1; }
      .fc-desktop .fc-panel-close { display:none; }   /* en PC se cierra con [ ] o Esc; la X sobra */
      .fc-panel .body { flex:1; overflow:auto; padding:8px 12px; }
      .fc-row { padding:12px 8px; border-bottom:1px solid var(--line); font-size:14px; line-height:1.45; border-radius:8px; transition:background .15s ease; }
      .fc-row:hover { background:var(--btn); }
      .fc-row.current { border-left:3px solid var(--accent); padding-left:9px; background:var(--btn); }
      .fc-row .es { font-weight:600; } .fc-row .en { color:var(--back); font-size:13px; }
      .fc-row .meta { color:var(--muted); font-size:12px; margin-top:2px; }
      .fc-row .acts { display:flex; gap:8px; margin-top:6px; }
      .fc-row .acts button { border:none; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; }
      .fc-row .acts .rm { background:var(--rm-bg); color:var(--rm-fg); } .fc-row .acts .go { background:var(--go-bg); color:var(--go-fg); }
      #fc-list-area .fc-row { display:flex; gap:10px; align-items:flex-start; }
      .fc-row-main { flex:1; min-width:0; }
      .fc-row .sel { margin-top:1px; }
      .fc-bulk { display:flex; align-items:center; gap:8px; padding:6px 4px 10px; border-bottom:1px solid var(--line); margin-bottom:6px; font-size:13px; }
      .fc-bulk .spacer { flex:1; }
      .fc-bulk label { display:flex; align-items:center; gap:8px; color:var(--fg); cursor:pointer; user-select:none; }
      /* Checkbox custom: hereda el tema (claro/oscuro) en vez del nativo blanco */
      .fc-row .sel, .fc-bulk .lb-all { -webkit-appearance:none; appearance:none; width:20px; height:20px; flex:0 0 auto; margin:0;
        border:2px solid var(--line); border-radius:6px; background:var(--card); cursor:pointer; position:relative;
        transition:background .15s ease, border-color .15s ease; }
      .fc-row .sel:hover, .fc-bulk .lb-all:hover { border-color:var(--accent); }
      .fc-row .sel:checked, .fc-bulk .lb-all:checked, .fc-bulk .lb-all:indeterminate { background:var(--accent); border-color:var(--accent); }
      .fc-row .sel:checked::after, .fc-bulk .lb-all:checked::after { content:''; position:absolute; left:50%; top:50%; width:5px; height:10px;
        border:solid #fff; border-width:0 2px 2px 0; transform:translate(-50%,-58%) rotate(45deg); }
      .fc-bulk .lb-all:indeterminate::after { content:''; position:absolute; left:4px; right:4px; top:8px; height:2px; background:#fff; }
      .bulk-del { border:none; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; background:var(--rm-bg); color:var(--rm-fg); font-weight:600; }
      .bulk-del:disabled { opacity:.45; cursor:default; }
      .fc-list-ctrls { display:flex; flex-direction:column; gap:8px; padding:4px 4px 12px; border-bottom:1px solid var(--line); margin-bottom:6px; }
      .fc-list-ctrls label { font-size:12px; color:var(--muted); display:flex; flex-direction:column; gap:3px; }
      .fc-list-ctrls select { padding:7px; border:1px solid var(--line); border-radius:6px; font-size:16px; background:var(--card); color:var(--fg); }
      .fc-list-load { display:flex; flex-direction:column; align-items:center; gap:14px; padding:44px 0; }
      .fc-list-load .lbl { font-size:13px; color:var(--muted); animation:fc-blink 1.4s ease-in-out infinite; }
      .fc-pager { display:flex; align-items:center; justify-content:center; gap:16px; padding:14px; color:var(--muted); font-size:13px; }
      .fc-pager .pg { width:40px; height:40px; border:none; border-radius:50%; background:var(--btn); color:var(--btnfg);
        cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .fc-pager .pg:disabled { opacity:.3; }
      #fc-modal { position:fixed; inset:0; z-index:2147483600; display:flex; align-items:center; justify-content:center; box-sizing:border-box;
        padding:calc(env(safe-area-inset-top,0px) + 3vh) calc(env(safe-area-inset-right,0px) + 7vw) calc(env(safe-area-inset-bottom,0px) + 3vh) calc(env(safe-area-inset-left,0px) + 7vw);
        background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s ease; }
      #fc-modal.open { opacity:1; pointer-events:auto; }
      #fc-modal .box { background:var(--bg,#fff); color:var(--fg,#222); border:1px solid var(--line); border-radius:14px; width:min(100%,480px);
        height:min(100%,820px); overflow:hidden; display:flex; flex-direction:column; font-size:14px; box-shadow:0 16px 48px var(--shadow);
        transform:scale(.94); transition:transform .2s ease; }
      #fc-modal.open .box { transform:scale(1); }
      #fc-modal .fc-profiles { display:flex; flex-direction:column; gap:8px; padding:10px; border-bottom:1px solid var(--line); }
      #fc-modal .fc-prof-row { display:flex; gap:6px; align-items:center; }
      #fc-modal .fc-prof-row select { flex:1; min-width:0; }
      #fc-modal #prof-new { background:var(--accent); color:#fff; border:none; border-radius:6px; width:36px; height:36px; flex:0 0 auto; cursor:pointer; display:flex; align-items:center; justify-content:center; }
      #fc-modal #gh-sync { flex:0 0 auto; height:36px; padding:0 14px; border:1px solid var(--accent); border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; background:transparent; color:var(--accent); }
      #fc-modal #gh-sync:hover { background:var(--accent); color:#fff; }
      #fc-modal .fc-prof-actions { display:flex; gap:6px; align-items:center; }
      #fc-modal #prof-save, #fc-modal #prof-rename { flex:1; height:36px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; }
      #fc-modal #prof-save { background:var(--accent); color:#fff; }
      #fc-modal #prof-rename { background:var(--btn); color:var(--btnfg); }
      #fc-modal .fc-icobtn { background:transparent; color:var(--muted); border:none; border-radius:6px; width:36px; height:36px; cursor:pointer; flex:0 0 auto; display:flex; align-items:center; justify-content:center; transition:color .15s, background .15s; }
      #fc-modal .fc-icobtn:hover { color:var(--fg); background:var(--btn); }
      #fc-modal .fc-del:hover { color:#d33; }
      #fc-modal .fc-icobtn .material-icons { font-size:20px; line-height:1; }
      #fc-modal .fc-icobtn.fc-disabled { opacity:.35; }
      #fc-modal .fc-restore-toggle { max-width:36px; overflow:hidden; transition:max-width .28s cubic-bezier(.2,.85,.3,1), opacity .22s ease, margin-left .28s cubic-bezier(.2,.85,.3,1); }
      #fc-modal .fc-restore-toggle.collapsed { max-width:0; opacity:0; margin-left:-6px; pointer-events:none; }
      #fc-modal .fc-restore-toggle.collapsed.fc-disabled { opacity:0; }
      #fc-modal .fc-icobtn.fc-disabled:hover { color:var(--muted); background:transparent; }
      #fc-modal .fc-ver { text-align:center; font-size:10px; color:var(--muted); opacity:.6; padding:3px 0 0; letter-spacing:.5px; }
      #fc-modal .fc-keyrow { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      #fc-modal .fc-keyrow > span { font-size:14px; }
      #fc-modal .fc-keycap { width:108px; box-sizing:border-box; height:34px; min-height:0; flex:0 0 auto; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; font-size:13px; font-weight:600; padding:0 8px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #fc-modal .fc-keycap.capturing { border-color:var(--accent); color:var(--accent); }
      #fc-modal .fc-keycap.empty { color:var(--muted); font-weight:400; font-style:italic; }
      #fc-modal .fc-restore { width:100%; height:34px; margin-top:4px; border:1px solid var(--line); border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; background:transparent; color:var(--muted); }
      #fc-modal .fc-restore:hover { color:var(--fg); border-color:var(--accent); }
      #fc-modal .fc-sub { margin-left:14px; padding-left:12px; border-left:2px solid var(--line); display:flex; flex-direction:column; gap:6px; transition:opacity .2s ease; }
      #fc-modal .fc-sub.dim { opacity:.4; } /* Auto ON -> el manual queda inactivo */
      #fc-modal .fc-tabs { display:flex; gap:2px; padding:8px 8px 0; border-bottom:1px solid var(--line); }
      #fc-modal .fc-tabs button { flex:1; padding:9px 4px; border:none; background:transparent; color:var(--muted);
        font-size:13px; cursor:pointer; border-bottom:2px solid transparent; border-radius:6px 6px 0 0; }
      #fc-modal .fc-tabs button:hover { color:var(--fg); }
      #fc-modal .fc-tabs button.active { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
      #fc-modal .fc-pane { display:none; flex-direction:column; gap:10px; }
      #fc-modal .fc-pane.active { display:flex; }
      #fc-modal .box-scroll { overflow:auto; flex:1 1 auto; min-height:0; padding:18px; display:flex; flex-direction:column; gap:10px; scrollbar-width:none; -ms-overflow-style:none; }
      #fc-modal .box-scroll::-webkit-scrollbar { width:0; height:0; display:none; }
      #fc-modal h4 { margin:6px 0 0; border-bottom:1px solid var(--line,#eee); padding-bottom:4px; }
      #fc-modal label { display:flex; flex-direction:column; gap:3px; }
      #fc-modal .hint { font-size:11px; color:var(--muted); margin:-3px 0 4px; line-height:1.35; }
      #fc-modal .row { display:flex; align-items:center; gap:8px; }
      #fc-modal select, #fc-modal input { padding:9px 10px; min-height:40px; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; font-size:16px;
        background:var(--card,#fff); color:var(--fg,#222); transition:border-color .15s ease; }
      #fc-modal select { -webkit-appearance:none; appearance:none; padding-right:34px;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
        background-repeat:no-repeat; background-position:right 12px center; }
      #fc-modal select:focus, #fc-modal input:focus { outline:none; border-color:var(--accent); }
      #fc-modal input[type=checkbox] { width:auto; min-height:0; accent-color:var(--accent); }
      #fc-modal .fc-tagbox { display:flex; flex-wrap:wrap; gap:6px; padding:7px; border:1px solid var(--line); border-radius:6px; background:var(--card); min-height:40px; align-items:center; cursor:text; }
      #fc-modal .fc-tagbox:focus-within { border-color:var(--accent); }
      #fc-modal .fc-tagbox input { border:none; outline:none; min-height:0; background:transparent; flex:1; min-width:90px; padding:2px; color:var(--fg); font-size:16px; }
      .fc-tag { display:inline-flex; align-items:center; gap:5px; background:var(--accent); color:#fff; border-radius:6px; padding:3px 5px 3px 9px; font-size:13px; }
      .fc-tag button { border:none; background:transparent; color:#fff; cursor:pointer; font-size:16px; line-height:1; padding:0 2px; opacity:.85; }
      .fc-tag button:hover { opacity:1; }
      #fc-modal .actions { display:flex; gap:8px; padding:10px 18px; border-top:1px solid var(--line); background:var(--bg,#fff); }
      #fc-modal .actions button { flex:1; height:42px; border:none; border-radius:8px; cursor:pointer; font-size:15px; }
      #fc-apply { background:var(--accent,#4b8b3b); color:#fff; font-weight:600; } #fc-cancel { background:var(--btn); color:var(--btnfg); }
      #fc-confirm { position:fixed; inset:0; z-index:2147483800; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .18s ease; }
      #fc-confirm.open { opacity:1; pointer-events:auto; }
      #fc-confirm .cbox { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:14px; width:min(90vw,340px);
        padding:24px 22px 18px; box-shadow:0 16px 48px var(--shadow); transform:scale(.92); transition:transform .18s ease;
        display:flex; flex-direction:column; gap:20px; text-align:center; }
      #fc-confirm.open .cbox { transform:scale(1); }
      #fc-confirm .cmsg { font-size:15px; line-height:1.45; }
      #fc-confirm .cbtns { display:flex; gap:10px; }
      #fc-confirm .cbtns button { flex:1; height:42px; border:none; border-radius:8px; cursor:pointer; font-size:15px; font-weight:600; }
      #fc-confirm .c-cancel { background:var(--btn); color:var(--btnfg); }
      #fc-confirm .c-ok { background:#d33; color:#fff; }
      #fc-prompt { position:fixed; inset:0; z-index:2147483800; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .18s ease; }
      #fc-prompt.open { opacity:1; pointer-events:auto; }
      #fc-prompt .cbox { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:14px; width:min(90vw,340px);
        padding:22px; box-shadow:0 16px 48px var(--shadow); transform:scale(.92); transition:transform .18s ease; display:flex; flex-direction:column; gap:14px; }
      #fc-prompt.open .cbox { transform:scale(1); }
      #fc-prompt .cmsg { font-size:15px; font-weight:600; }
      #fc-prompt .pinput { padding:9px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font-size:16px; }
      #fc-prompt .pinput:focus { outline:none; border-color:var(--accent); }
      #fc-prompt .cbtns { display:flex; gap:10px; }
      #fc-prompt .cbtns button { flex:1; height:40px; border:none; border-radius:8px; cursor:pointer; font-size:15px; font-weight:600; }
      #fc-prompt .c-cancel { background:var(--btn); color:var(--btnfg); }
      #fc-prompt .c-ok { background:var(--accent); color:#fff; }
    `;
    document.head.appendChild(s);
  }

  /* ============ UI PRINCIPAL ============ */

  let overlay,
    frontEl,
    backEl,
    ownersEl,
    hintEl,
    idEl,
    barEl,
    zonesEl,
    launcher;
  let revealed = false,
    lastTouch = 0,
    uiBlocked = false;

  function iconBtn(act, icon, title, cls) {
    const b = document.createElement('button');
    b.className = cls || 'fc-btn';
    b.dataset.act = act;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (icon.trim().startsWith('<svg'))
      b.innerHTML = icon; // ícono SVG propio (para los que la fuente material no tiene)
    else b.appendChild(makeIcon(icon));
    return b;
  }

  function buildUI() {
    overlay = document.createElement('div');
    overlay.id = 'fc-overlay';
    const darkSaved = LS.get(K.dark);
    if (darkSaved === '1' || (darkSaved === null && DARK_DEFAULT)) {
      overlay.classList.add('dark');
      document.documentElement.classList.add('fc-dark');
    }

    const top = document.createElement('div');
    top.id = 'fc-top';
    idEl = document.createElement('div');
    idEl.id = 'fc-id';
    idEl.textContent = '…';
    const sp = document.createElement('div');
    sp.className = 'spacer';
    top.append(
      idEl,
      sp,
      iconBtn('dark', 'brightness_2', 'Modo oscuro', 'fc-icon'),
      iconBtn('history', 'history', 'Historial', 'fc-icon'),
      iconBtn('list', 'list', 'Mi lista', 'fc-icon'),
      iconBtn('filters', 'tune', 'Filtros', 'fc-icon'),
      iconBtn('exit', 'close', 'Salir', 'fc-icon'),
    );

    const stage = document.createElement('div');
    stage.id = 'fc-stage';
    const card = document.createElement('div');
    card.id = 'fc-card';
    frontEl = document.createElement('div');
    frontEl.id = 'fc-front';
    frontEl.textContent = '';
    backEl = document.createElement('div');
    backEl.id = 'fc-back';
    ownersEl = document.createElement('div');
    ownersEl.id = 'fc-owners';
    hintEl = document.createElement('div');
    hintEl.id = 'fc-hint';
    hintEl.textContent = ''; // sin "Tocá para revelar"
    card.append(frontEl, backEl, ownersEl, hintEl);

    zonesEl = document.createElement('div');
    zonesEl.id = 'fc-zones';
    const ztop = document.createElement('button');
    ztop.className = 'fc-zone';
    ztop.dataset.act = 'audio';
    ztop.style.height = TOP_ZONE_PERCENT + '%';
    ztop.title = 'Audio';
    const zrow = document.createElement('div');
    zrow.className = 'fc-zrow';
    const zl = document.createElement('button');
    zl.className = 'fc-zone';
    zl.dataset.act = 'next';
    zl.style.flex = `0 0 ${SIDE_ZONE_PERCENT}%`;
    const zm = document.createElement('button');
    zm.className = 'fc-zone';
    zm.dataset.act = 'add';
    zm.style.flex = '1';
    const zr = document.createElement('button');
    zr.className = 'fc-zone';
    zr.dataset.act = 'next';
    zr.style.flex = `0 0 ${SIDE_ZONE_PERCENT}%`;
    zrow.append(zl, zm, zr);
    zonesEl.append(ztop, zrow);

    const loading = document.createElement('div');
    loading.id = 'fc-loading';
    loading.innerHTML =
      '<div class="fc-load-dots"><span></span><span></span><span></span></div><div class="lbl">Cargando oraciones…</div>';
    stage.append(card, zonesEl, loading);

    barEl = document.createElement('div');
    barEl.id = 'fc-bar';
    barEl.append(
      iconBtn('prev', 'chevron_left', 'Anterior'),
      iconBtn('audio', 'play_arrow', 'Audio'),
      iconBtn('add', 'playlist_add', 'Agregar'),
      iconBtn('remove', 'remove_circle_outline', 'Quitar'),
      iconBtn('next', 'chevron_right', 'Siguiente', 'fc-btn fc-primary'),
    );

    toastEl = document.createElement('div');
    toastEl.id = 'fc-toast';

    overlay.append(top, stage, barEl);
    document.body.appendChild(overlay);
    document.body.appendChild(toastEl); // el toast va al body (no a la overlay) para no quedar atrapado bajo el modal

    if (overlay.classList.contains('dark'))
      overlay.querySelector('[data-act="dark"] .material-icons').textContent =
        'wb_sunny';

    launcher = document.createElement('button');
    launcher.id = 'fc-launcher';
    launcher.title = 'Estudiar';
    launcher.appendChild(makeIcon('style'));
    launcher.addEventListener('click', () => setOpen(true));
    document.body.appendChild(launcher);

    overlay.addEventListener('click', (e) => {
      // Si fue un toque reciente sobre la carta/zonas, ya lo resolvió touchend -> no duplicar.
      const ul = e.target.closest('.fc-owner-link');
      if (ul) {
        openOwner(ul.dataset.user);
        return;
      }
      if (e.target.closest('#fc-stage') && Date.now() - lastTouch < 600) return;
      const b = e.target.closest('button[data-act]');
      if (b) {
        handleAction(b.dataset.act);
        return;
      }
      if (e.target.closest('#fc-card') && !revealed) reveal();
    });

    buildModal();
    buildPanels();
    setupGestures();
    setupKeyboard();
  }

  function handleAction(act) {
    (
      ({
        prev,
        next,
        audio: playAudio,
        add: addCurrent,
        remove: removeCurrent,
        filters: toggleModal,
        history: toggleHistory, // el botón alterna abrir/cerrar (igual que el atajo)
        list: toggleList,
        exit: () => setOpen(false),
        dark: toggleDark,
      })[act] || (() => {})
    )();
  }

  // Dispatcher por id de acción (lo usan gestos y atajos configurables).
  function runAction(id) {
    const map = {
      next,
      prev,
      audio: playAudio,
      addList: addCurrent,
      removeList: removeCurrent,
      list: toggleList,
      history: toggleHistory,
      config: toggleModal,
      reveal: () => {
        if (!revealed) reveal();
        else next();
      },
    };
    if (map[id]) map[id]();
  }
  // keymap: tecla -> acción, reconstruido desde KEYS (que se puede editar/sincronizar).
  let keymap = {};
  function rebuildKeymap() {
    keymap = {};
    Object.keys(KEYS).forEach((a) => {
      if (KEYS[a]) keymap[KEYS[a]] = a;
    });
  }
  rebuildKeymap();

  // Resuelve un tap (zona transparente o carta) sin depender del click sintético, que iOS cancela.
  function handleTap(target) {
    const ul = target.closest && target.closest('.fc-owner-link');
    if (ul) {
      openOwner(ul.dataset.user);
      return;
    }
    const b = target.closest && target.closest('button[data-act]');
    if (b) {
      handleAction(b.dataset.act);
      return;
    }
    if (target.closest && target.closest('#fc-card') && !revealed) reveal();
  }

  const ownerLink = (name) =>
    name && name !== '—'
      ? `<a class="fc-owner-link" data-user="${escHtml(name)}">${escHtml(name)}</a>`
      : '—';

  // Abre el perfil oficial del dueño en una pestaña nueva.
  function openOwner(user) {
    if (user && user !== '—')
      window.open(
        `/${langSeg()}/user/profile/${encodeURIComponent(user)}`,
        '_blank',
      );
  }

  function updateId() {
    if (!idEl) return;
    // 1) nombre del perfil/lista · 2) nº de oraciones · 3) "sin guardar" (último, solo si hay cambios)
    let html = `<div class="fc-prof">${escHtml(activeProfile)}</div>`;
    if (totalCount != null)
      html += `<div class="fc-total">${totalCount.toLocaleString('es')} en Tatoeba</div>`;
    if (dirty) html += `<div class="fc-dirty">• sin guardar</div>`;
    idEl.innerHTML = html;
  }

  function showLoading(on) {
    const el = document.getElementById('fc-loading');
    if (el) el.classList.toggle('on', on);
  }

  // Tamaño de fuente según el largo del texto: corto = base, largo = se achica (raíz cuadrada, con piso).
  function fitFont(text, base, min) {
    const len = (text || '').length;
    if (len <= 60) return base;
    return Math.max(min, Math.round(base * Math.sqrt(60 / len)));
  }
  function render() {
    const c = currentCard();
    if (!c) {
      showLoading(true);
      frontEl.textContent = '';
      backEl.textContent = '';
      ownersEl.textContent = '';
      return;
    }
    showLoading(false);
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } // cortá el audio al cambiar de oración
    if (index > maxSeen) maxSeen = index; // marca de agua: el historial conserva todas las vistas
    revealed = false;
    zonesEl.classList.remove('on');
    const f = frontOf(c),
      b = backOf(c);
    frontEl.textContent = f.text;
    backEl.textContent = b.text;
    // Oraciones largas -> achicar la fuente para que entren cómodas (escala suave por largo).
    frontEl.style.fontSize = fitFont(f.text, 31, 15) + 'px';
    backEl.style.fontSize = fitFont(b.text, 24, 14) + 'px';
    backEl.style.visibility = 'hidden'; // reservado: el reverso no mueve nada al revelar
    ownersEl.textContent = ''; // los dueños aparecen recién AL revelar (junto con la traducción)
    ownersEl.style.transition = '';
    ownersEl.style.transform = ''; // reset de la animación
    hintEl.style.visibility = 'visible';
    updateId();
    updateBar();
    setAudioIcon('play_arrow'); // carta nueva -> ícono de reproducir
    syncHistory(); // historial sigue en vivo a la oración actual
    if (START_REVEALED) reveal(); // modo "ya revelada": mostrá el reverso de entrada
  }

  function reveal() {
    const c = currentCard();
    if (!c || revealed) return;
    revealed = true;
    backEl.style.visibility = 'visible';
    backEl.classList.remove('fc-reveal');
    void backEl.offsetWidth; // reflow para re-disparar la animación
    backEl.classList.add('fc-reveal'); // fade+slide rápido de la traducción
    hintEl.style.visibility = 'hidden';
    zonesEl.classList.add('on');
    updateBar();

    ownersEl.innerHTML = `Oración: ${ownerLink(frontOf(c).owner)} · Traducción: ${ownerLink(backOf(c).owner)}`;
    ownersEl.classList.remove('fc-reveal');
    void ownersEl.offsetWidth;
    ownersEl.classList.add('fc-reveal'); // misma animación que la traducción (con leve retraso por CSS)
  }

  function updateBar() {
    barEl.querySelectorAll('.fc-btn').forEach((x) => {
      // El audio se desactiva sólo si es spoiler (inglés en el dorso sin revelar); el resto siempre activo.
      x.disabled = x.dataset.act === 'audio' && audioGated();
    });
  }

  function toggleDark() {
    const on = !overlay.classList.contains('dark');
    overlay.classList.toggle('dark', on);
    document.documentElement.classList.toggle('fc-dark', on); // habilita el tema oscuro también en paneles/modal (cuelgan de <body>)
    LS.set(K.dark, on ? '1' : '0');
    const ic = overlay.querySelector('[data-act="dark"] .material-icons');
    if (ic) ic.textContent = on ? 'wb_sunny' : 'brightness_2';
  }

  /* ============ PANELES ============ */

  let historyPanel,
    listPanel,
    panelBackdrop,
    listPage = 1,
    listUrls = []; // listUrls[page] = URL (cursor) de cada página
  let listName = '',
    listTotal = null; // nombre + total de miembros de "Mi lista" (para el título)
  function applyListTitle() {
    if (listPanel && listPanel._title)
      listPanel._title.textContent =
        (listName || 'Mi lista') +
        (listTotal != null ? `  ·  ${listTotal.toLocaleString('es')}` : '');
  }
  function buildPanels() {
    historyPanel = makePanel('Historial');
    listPanel = makePanel('Mi lista');
    panelBackdrop = document.createElement('div');
    panelBackdrop.className = 'fc-panel-backdrop';
    panelBackdrop.addEventListener('click', closePanels);
    document.body.appendChild(panelBackdrop);
    document.addEventListener('keydown', (e) => {
      if (
        e.key === 'Escape' &&
        (historyPanel.classList.contains('open') ||
          listPanel.classList.contains('open'))
      )
        closePanels();
    });
  }
  function makePanel(title) {
    const p = document.createElement('div');
    p.className = 'fc-panel';
    const h = document.createElement('header');
    const t = document.createElement('div');
    t.textContent = title;
    const s = document.createElement('div');
    s.className = 'spacer';
    const c = iconBtn('x', 'close', 'Cerrar', 'fc-icon fc-panel-close');
    c.addEventListener('click', closePanels);
    h.append(t, s, c);
    const body = document.createElement('div');
    body.className = 'body';
    p.append(h, body);
    document.body.appendChild(p);
    p._body = body;
    p._title = t;
    return p;
  }
  function closePanels() {
    historyPanel.classList.remove('open');
    listPanel.classList.remove('open');
    if (panelBackdrop) panelBackdrop.classList.remove('open');
    overlay.classList.remove('panel-push');
    document.documentElement.classList.remove('fc-push');
    uiBlocked = false;
  }
  function toggleList() {
    if (listPanel.classList.contains('open')) closePanels();
    else openList();
  }
  function toggleHistory() {
    if (historyPanel.classList.contains('open')) closePanels();
    else openHistory();
  }
  function showPanelChrome() {
    // muestra backdrop (flotante) o empuje (PC), cierra el otro panel
    historyPanel.classList.remove('open');
    listPanel.classList.remove('open');
    uiBlocked = !DESKTOP_MODE;
    document.documentElement.classList.toggle('fc-push', DESKTOP_MODE); // alinea el toast (en body) con el contenido empujado
    if (DESKTOP_MODE) {
      panelBackdrop.classList.remove('open');
      overlay.classList.add('panel-push');
    } else {
      overlay.classList.remove('panel-push');
      panelBackdrop.classList.add('open');
    }
  }
  // Recalcula el modo efectivo y re-aplica el layout sin cerrar paneles (lo usa el listener de pantalla).
  function recomputeDesktop() {
    DESKTOP_MODE = effectiveDesktop();
    document.documentElement.classList.toggle('fc-desktop', DESKTOP_MODE);
    const panelOpen =
      (historyPanel && historyPanel.classList.contains('open')) ||
      (listPanel && listPanel.classList.contains('open'));
    if (panelOpen) {
      uiBlocked = !DESKTOP_MODE;
      document.documentElement.classList.toggle('fc-push', DESKTOP_MODE);
      overlay.classList.toggle('panel-push', DESKTOP_MODE);
      panelBackdrop.classList.toggle('open', !DESKTOP_MODE);
    }
  }

  function renderHistory() {
    const body = historyPanel._body;
    body.innerHTML = '';
    for (let i = maxSeen; i >= 0; i--) {
      const c = cards[i];
      const f = frontOf(c),
        b = backOf(c);
      const row = document.createElement('div');
      row.className = 'fc-row';
      row.style.cursor = 'pointer';
      if (i === index) row.classList.add('current');
      row.innerHTML = `<div class="meta">Oración #${f.id || c.id} · ${f.owner || '—'}</div>
        <div class="es">${f.text}</div>
        <div class="en">${b.text}</div>
        <div class="meta">Traducción #${b.id || '—'} · ${b.owner || '—'}</div>`;
      row.addEventListener('click', () => jumpTo(i));
      body.appendChild(row);
    }
    if (!body.children.length) body.textContent = 'Todavía no viste ninguna.';
  }
  function openHistory() {
    renderHistory();
    showPanelChrome();
    historyPanel.classList.add('open');
  }
  // Sincronización en vivo: refresca el panel abierto sin reabrirlo.
  function syncHistory() {
    if (historyPanel.classList.contains('open')) renderHistory();
  }
  function listArea() {
    return listPanel.classList.contains('open')
      ? listPanel._body.querySelector('#fc-list-area')
      : null;
  }
  function syncListAdd(c) {
    // inserta la oración recién agregada SIN recargar
    const area = listArea();
    if (!area) return;
    if (area.querySelector(`.fc-row[data-sid="${c.id}"]`)) return; // ya visible, no duplicar
    [...area.childNodes].forEach((n) => {
      if (n.nodeType === 3) n.remove();
    }); // saca el cartel "lista vacía"
    const row = buildListRow(c);
    area.insertBefore(
      row,
      area.querySelector('.fc-row') || area.querySelector('.fc-pager'),
    );
    row.style.opacity = '0';
    void row.offsetWidth;
    row.style.transition = 'opacity .25s ease';
    row.style.opacity = '1';
    if (listTotal != null) {
      listTotal += 1;
      applyListTitle();
    } // truco local: +1 sin re-fetch
  }
  function listRemoveRow(id) {
    // saca la fila puntual SIN recargar
    const area = listArea();
    if (!area) return;
    const row = area.querySelector(`.fc-row[data-sid="${id}"]`);
    if (!row) return;
    row.style.transition = 'opacity .2s ease';
    row.style.opacity = '0';
    setTimeout(() => row.remove(), 200);
    if (listTotal != null) {
      listTotal = Math.max(0, listTotal - 1);
      applyListTitle();
    } // truco local: -1 sin re-fetch
  }

  // ===== Selección múltiple + borrado en lote (uno por uno: la API no tiene endpoint bulk) =====
  function makeBulkBar(area) {
    const bar = document.createElement('div');
    bar.className = 'fc-bulk';
    bar.innerHTML = `<label><input type="checkbox" class="lb-all"><span>Seleccionar todo</span></label>
      <span class="spacer"></span>
      <button type="button" class="lb-del bulk-del" disabled>Eliminar</button>`;
    bar.querySelector('.lb-all').addEventListener('change', (e) => {
      area.querySelectorAll('.sel').forEach((cb) => {
        cb.checked = e.target.checked;
      });
      refreshBulk(area, bar);
    });
    bar
      .querySelector('.lb-del')
      .addEventListener('click', () => bulkDelete(area, bar));
    return bar;
  }
  function refreshBulk(area, bar) {
    const sels = [...area.querySelectorAll('.sel')];
    const checked = sels.filter((cb) => cb.checked);
    const del = bar.querySelector('.lb-del');
    del.disabled = !checked.length;
    del.textContent = checked.length
      ? `Eliminar (${checked.length})`
      : 'Eliminar';
    const all = bar.querySelector('.lb-all');
    all.checked = sels.length > 0 && checked.length === sels.length;
    all.indeterminate = checked.length > 0 && checked.length < sels.length;
  }
  function confirmDialog(msg, okLabel) {
    // confirmación temática (reemplaza al confirm() nativo)
    return new Promise((resolve) => {
      let m = document.getElementById('fc-confirm');
      if (!m) {
        m = document.createElement('div');
        m.id = 'fc-confirm';
        m.innerHTML = `<div class="cbox"><div class="cmsg"></div><div class="cbtns"><button class="c-cancel">Cancelar</button><button class="c-ok"></button></div></div>`;
        document.body.appendChild(m);
      }
      m.querySelector('.cmsg').textContent = msg;
      m.querySelector('.c-ok').textContent = okLabel || 'Eliminar';
      const onCancel = () => close(false),
        onOk = () => close(true);
      const onBackdrop = (e) => {
        if (e.target === m) close(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
        else if (e.key === 'Enter') close(true);
      };
      function close(val) {
        m.classList.remove('open');
        m.querySelector('.c-cancel').removeEventListener('click', onCancel);
        m.querySelector('.c-ok').removeEventListener('click', onOk);
        m.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      m.querySelector('.c-cancel').addEventListener('click', onCancel);
      m.querySelector('.c-ok').addEventListener('click', onOk);
      m.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => m.classList.add('open'));
    });
  }
  async function bulkDelete(area, bar) {
    const rows = [...area.querySelectorAll('.fc-row')].filter(
      (r) => r.querySelector('.sel') && r.querySelector('.sel').checked,
    );
    if (!rows.length) return;
    if (
      !(await confirmDialog(
        `¿Quitar ${rows.length} oración(es) de la lista?`,
        'Eliminar',
      ))
    )
      return;
    const del = bar.querySelector('.lb-del');
    del.disabled = true;
    del.textContent = 'Quitando…';
    let ok = 0;
    for (const row of rows) {
      // secuencial: más suave con el servidor que disparar N a la vez
      if (await listAction('remove_sentence_from_list', row.dataset.sid)) {
        ok++;
        cacheRemove(LIST_ID, row.dataset.sid);
        row.remove();
      }
    }
    if (listTotal != null && ok) {
      listTotal = Math.max(0, listTotal - ok);
      applyListTitle();
    } // truco local: -N sin re-fetch
    toast(`✓ ${ok} quitada(s)`, ok > 0);
    bar.querySelector('.lb-all').checked = false;
    bar.querySelector('.lb-all').indeterminate = false;
    refreshBulk(area, bar);
  }

  function listControls() {
    const wrap = document.createElement('div');
    wrap.className = 'fc-list-ctrls';
    const so = (v, t) =>
      `<option value="${v}" ${listSort === v ? 'selected' : ''}>${t}</option>`;
    const sortOpts =
      so('-added', 'Agregadas: recientes primero') +
      so('added', 'Agregadas: viejas primero') +
      so('-created', 'Creación: nuevas primero') +
      so('created', 'Creación: viejas primero') +
      so('-modified', 'Modificación: recientes primero') +
      so('modified', 'Modificación: antiguas primero') +
      so('-words', 'Palabras: más largas primero') +
      so('words', 'Palabras: más cortas primero') +
      so('random', 'Al azar');
    wrap.innerHTML =
      `<label>Oraciones en:<select id="ld-front">${langOpts(LIST_DISPLAY.front)}</select></label>` +
      `<label>Mostrar traducciones en:<select id="ld-back">${langOpts(LIST_DISPLAY.back)}</select></label>` +
      `<label>Ordenar por:<select id="ld-sort">${sortOpts}</select></label>`;
    wrap.querySelector('#ld-front').addEventListener('change', (e) => {
      LIST_DISPLAY.front = e.target.value;
      saveListDisplay();
      listPage = 1;
      listUrls = [];
      loadListPage();
    });
    wrap.querySelector('#ld-back').addEventListener('change', (e) => {
      LIST_DISPLAY.back = e.target.value;
      saveListDisplay();
      listPage = 1;
      listUrls = [];
      loadListPage();
    });
    wrap.querySelector('#ld-sort').addEventListener('change', (e) => {
      listSort = e.target.value;
      saveActive(); // persiste al perfil activo (+ sincroniza)
      listPage = 1;
      listUrls = [];
      loadListPage();
    });
    return wrap;
  }

  function openList() {
    listPage = 1;
    listUrls = [];
    listName = '';
    listTotal = null;
    showPanelChrome();
    listPanel.classList.add('open');
    applyListTitle();
    currentListName().then((n) => {
      listName = n;
      applyListTitle();
    });
    loadListPage();
  }

  function buildListQuery() {
    const p = new URLSearchParams();
    p.set('lang', LIST_LANGS); // amplio -> la lista trae miembros de cualquier idioma (mixta)
    p.set('list', String(LIST_ID));
    p.set('sort', listSort); // orden de la API (selector en "Mi lista")
    p.set('showtrans', 'all'); // todas las traducciones -> el display (LIST_DISPLAY) elige front/back
    p.set('include', 'audios');
    p.set('limit', '30');
    return p.toString();
  }

  async function loadListPage() {
    const body = listPanel._body;
    body.innerHTML = '';
    body.appendChild(listControls());
    const area = document.createElement('div');
    area.id = 'fc-list-area';
    body.appendChild(makeBulkBar(area));
    area.innerHTML =
      '<div class="fc-list-load"><div class="fc-load-dots"><span></span><span></span><span></span></div><div class="lbl">Cargando lista…</div></div>';
    body.appendChild(area);
    // Orden "agregadas": la API no lo soporta -> se resuelve LOCAL desde el caché (instantáneo, offline).
    if (listSort === '-added' || listSort === 'added') {
      renderAddedFromCache(area);
      return;
    }
    try {
      const url =
        listUrls[listPage] || `${API_BASE}/sentences?${buildListQuery()}`;
      const data = await apiSearch(url);
      if (data.paging && typeof data.paging.total === 'number') {
        listTotal = data.paging.total;
        applyListTitle();
      }
      listUrls[listPage] = url;
      const hasNext = !!(data.paging && data.paging.has_next);
      if (hasNext) listUrls[listPage + 1] = data.paging.next; // cursor de la próxima página
      renderListPage(area, data.data || [], hasNext);
    } catch (e) {
      area.textContent = 'Error cargando la lista.';
    }
  }

  function renderAddedFromCache(area) {
    // Orden por fecha de agregado (lo que registramos nosotros). Reusa buildListRow
    // porque cada entrada tiene la forma de un objeto de la API.
    const byId = loadListCache()[LIST_ID] || {};
    const entries = Object.values(byId).sort((a, b) =>
      listSort === '-added'
        ? (b.ts || 0) - (a.ts || 0)
        : (a.ts || 0) - (b.ts || 0),
    );
    listTotal = entries.length;
    applyListTitle();
    renderListPage(area, entries, false); // sin paginación de red: todo local (tope 500)
  }

  function buildListRow(c) {
    const ft = getTextByLang(c, LIST_DISPLAY.front) || {
      text: c.text,
      id: c.id,
      owner: c.owner,
    };
    const bt = getTextByLang(c, LIST_DISPLAY.back) || { text: '', id: null };
    const row = document.createElement('div');
    row.className = 'fc-row';
    row.dataset.sid = String(c.id);
    row.innerHTML = `<input type="checkbox" class="sel" title="Seleccionar">
      <div class="fc-row-main">
      <div class="meta">Oración #${ft.id || '—'} · ${ft.owner || '—'}</div>
      <div class="es">${ft.text}</div>
      <div class="en">${bt.text}</div>
      <div class="meta">Traducción #${bt.id || '—'} · ${bt.owner || '—'}</div>
      <div class="acts"><button class="go">Abrir</button><button class="rm">Quitar</button></div>
      </div>`;
    row
      .querySelector('.go')
      .addEventListener('click', () =>
        window.open(`/${langSeg()}/sentences/show/${c.id}`, '_blank'),
      );
    row.querySelector('.rm').addEventListener('click', async () => {
      if (await listById('remove_sentence_from_list', c.id, 'quitada')) {
        cacheRemove(LIST_ID, c.id);
        listRemoveRow(c.id);
      }
    });
    row.querySelector('.sel').addEventListener('change', () => {
      const a = listArea(),
        b = listPanel._body.querySelector('.fc-bulk');
      if (a && b) refreshBulk(a, b);
    });
    return row;
  }
  function renderListPage(area, all, hasNext) {
    area.innerHTML = '';
    if (!all.length)
      area.textContent =
        listPage === 1 ? 'La lista está vacía.' : 'No hay más oraciones.';
    for (const c of all) area.appendChild(buildListRow(c));
    const pager = document.createElement('div');
    pager.className = 'fc-pager';
    const pb = iconBtn('p-prev', 'chevron_left', 'Anterior', 'pg');
    pb.disabled = listPage <= 1;
    const nb = iconBtn('p-next', 'chevron_right', 'Siguiente', 'pg');
    nb.disabled = !hasNext;
    const from = (listPage - 1) * 30 + 1,
      to = (listPage - 1) * 30 + all.length;
    const info = document.createElement('span');
    info.textContent = all.length ? `${from}–${to}` : `Pág. ${listPage}`;
    pb.addEventListener('click', () => {
      if (listPage > 1) {
        listPage--;
        loadListPage();
      }
    });
    nb.addEventListener('click', () => {
      if (hasNext) {
        listPage++;
        loadListPage();
      }
    });
    pager.append(pb, info, nb);
    area.appendChild(pager);
    listPanel._body.scrollTop = 0;
  }

  /* ============ MODAL DE FILTROS ============ */

  const langOpts = (sel, anyLabel) =>
    (anyLabel ? `<option value="">${anyLabel}</option>` : '') +
    LANGUAGES.map(
      (l) =>
        `<option value="${l.code}" ${l.code === sel ? 'selected' : ''}>${l.name}</option>`,
    ).join('');
  const tri = (id, val) => {
    const o = (v, t) =>
      `<option value="${v}" ${val === v ? 'selected' : ''}>${t}</option>`;
    return `<select id="${id}">${o('', 'Es indistinto')}${o('yes', 'Sí')}${o('no', 'No')}</select>`;
  };

  const escHtml = (s) =>
    String(s == null ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );

  // Trae las listas a las que el usuario puede agregar (propias + colaborativas), vía el sitio (con sesión).
  let myListsCache = null;
  async function fetchMyLists() {
    try {
      const r = await fetch(`/${langSeg()}/sentences_lists/choices`, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!r.ok) return null;
      const d = await r.json();
      const lists = (d && d.lists) || null;
      if (lists) myListsCache = lists;
      return lists;
    } catch (e) {
      return null;
    }
  }
  async function currentListName() {
    const cur = String(LIST_ID);
    const find = () => (myListsCache || []).find((l) => String(l.id) === cur);
    if (!myListsCache) await fetchMyLists();
    const l = find();
    return l ? l.name : `Lista #${cur}`;
  }

  async function populateListSelect() {
    const sel = document.getElementById('f-listid');
    if (!sel) return;
    const lists = ((await fetchMyLists()) || []).filter((l) => l.is_mine); // SOLO las mías
    if (!lists.length) return; // si falla, queda el fallback (lista actual)
    lists.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const cur = String(LIST_ID);
    let html = lists
      .map(
        (l) =>
          `<option value="${l.id}" ${String(l.id) === cur ? 'selected' : ''}>${escHtml(l.name)}</option>`,
      )
      .join('');
    if (!lists.some((l) => String(l.id) === cur))
      html = `<option value="${cur}" selected>(actual #${cur})</option>` + html; // no perder la actual si no está
    sel.innerHTML = html;
  }

  /* ----- Chips de "Palabras" (query con OR via pipe) ----- */
  function parseQueryChips(q) {
    return (q || '')
      .split('|')
      .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
  }
  function tagsToQuery(tags) {
    return tags.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join('|');
  }
  function readTags(box) {
    return [...box.querySelectorAll('.fc-tag')].map((t) => t.dataset.val);
  }
  function addTag(box, input, val) {
    val = (val || '').trim().replace(/^["']+|["']+$/g, '');
    if (
      !val ||
      readTags(box).some((t) => t.toLowerCase() === val.toLowerCase())
    )
      return;
    const tag = document.createElement('span');
    tag.className = 'fc-tag';
    tag.dataset.val = val;
    const lbl = document.createElement('span');
    lbl.textContent = val;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Quitar');
    x.addEventListener('click', () => {
      tag.remove();
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    tag.append(lbl, x);
    box.insertBefore(tag, input);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function initTagBox(box, input, chips) {
    chips.forEach((c) => addTag(box, input, c));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === '|') {
        e.preventDefault();
        addTag(box, input, input.value);
        input.value = '';
      } else if (e.key === 'Backspace' && !input.value) {
        const t = box.querySelectorAll('.fc-tag');
        if (t.length) t[t.length - 1].remove();
      }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) {
        addTag(box, input, input.value);
        input.value = '';
      }
    });
    box.addEventListener('click', () => input.focus());
  }

  /* ----- Config: leer del modal / aplicar / perfiles ----- */
  function readModalConfig(m) {
    const g = (id) => m.querySelector(id);
    return {
      filters: {
        query: tagsToQuery(readTags(g('#f-query-box'))),
        from: g('#f-from').value,
        word_min: g('#f-wmin').value,
        word_max: g('#f-wmax').value,
        user: g('#f-user').value.trim(),
        origin: g('#f-origin').value,
        orphans: g('#f-orphans').value,
        unapproved: g('#f-unapproved').value,
        native: g('#f-native').value,
        has_audio: g('#f-audio').value,
        tags: g('#f-tags').value.trim(),
        list: g('#f-list').value.trim(),
        trans_to: g('#f-tto').value,
        trans_link: g('#f-tlink').value,
        trans_user: g('#f-tuser').value.trim(),
        trans_orphan: g('#f-torphan').value,
        trans_unapproved: g('#f-tunap').value,
        trans_native: g('#f-tnative').value,
        trans_has_audio: g('#f-thas').value,
        sort: g('#f-sort').value,
        sort_reverse: g('#f-reverse').checked,
      },
      display: { front: g('#d-front').value, back: g('#d-back').value },
      listId: g('#f-listid').value.trim() || '174916',
      audioLang: g('#f-audiolang').value,
      startRevealed: g('#f-startrev').checked,
      // 'desktop' NO va en el perfil (es local, no se sincroniza) -> se maneja con applyDesktopPref
    };
  }
  // Modo ordenador: el toggle "Auto" es GLOBAL + sincronizado; el modo MANUAL es local por dispositivo.
  function applyDesktopPref(m, persist) {
    const autoEl = m.querySelector('#f-desktop-auto');
    const manualEl = m.querySelector('#f-desktop');
    DESKTOP_AUTO = autoEl ? autoEl.checked : DESKTOP_AUTO;
    DESKTOP_MODE = DESKTOP_AUTO ? detectDesktop() : !!(manualEl && manualEl.checked);
    document.documentElement.classList.toggle('fc-desktop', DESKTOP_MODE);
    if (manualEl) {
      manualEl.disabled = DESKTOP_AUTO; // en Auto, el manual queda deshabilitado y refleja lo detectado
      if (DESKTOP_AUTO) manualEl.checked = DESKTOP_MODE;
    }
    if (persist) {
      // Solo Guardar persiste -> Cancelar puede revertir.
      LS.set('sm-fc-desktop-auto', DESKTOP_AUTO ? '1' : '0'); // GLOBAL + sync (está en SYNC_KEYS)
      if (!DESKTOP_AUTO) LS.set('sm-fc-desktop', DESKTOP_MODE ? '1' : '0'); // manual: LOCAL; no lo pisamos cuando Auto está ON
    }
  }
  // Lee gestos + atajos del modal y los aplica en vivo. Solo persiste (+ sincroniza) si persist=true.
  function applyControls(m, persist) {
    if (!m.querySelector('#g-up')) return;
    GESTURES = {
      up: m.querySelector('#g-up').value,
      down: m.querySelector('#g-down').value,
      left: m.querySelector('#g-left').value,
      right: m.querySelector('#g-right').value,
    };
    const nk = {};
    m.querySelectorAll('.fc-keycap').forEach((b) => {
      nk[b.dataset.act] = b.dataset.key;
    });
    KEYS = Object.assign({}, KEYS_DEFAULT, nk);
    rebuildKeymap(); // se aplican en vivo (para probar) siempre
    if (persist) {
      LS.set('sm-fc-gestures', JSON.stringify(GESTURES)); // persiste + SINCRONIZA
      LS.set('sm-fc-keys', JSON.stringify(KEYS));
    }
  }
  // Actualiza TODOS los campos del modal desde los globals actuales, SIN reconstruirlo (evita el "pop" y permite animar el botón restaurar).
  function populateModal(m) {
    const g = (id) => m.querySelector(id);
    const setV = (id, v) => {
      const el = g(id);
      if (el) el.value = v == null ? '' : v;
    };
    const setC = (id, v) => {
      const el = g(id);
      if (el) el.checked = !!v;
    };
    const f = filters;
    const box = g('#f-query-box'),
      inp = g('#f-query-input');
    if (box && inp) {
      box.querySelectorAll('.fc-tag').forEach((t) => t.remove());
      inp.value = '';
      parseQueryChips(f.query).forEach((c) => addTag(box, inp, c));
    }
    setV('#f-from', f.from);
    setV('#f-wmin', f.word_min);
    setV('#f-wmax', f.word_max);
    setV('#f-user', f.user);
    setV('#f-origin', f.origin);
    setV('#f-orphans', f.orphans);
    setV('#f-unapproved', f.unapproved);
    setV('#f-native', f.native);
    setV('#f-audio', f.has_audio);
    setV('#f-tags', f.tags);
    setV('#f-list', f.list);
    setV('#f-tto', f.trans_to);
    setV('#f-tlink', f.trans_link);
    setV('#f-tuser', f.trans_user);
    setV('#f-torphan', f.trans_orphan);
    setV('#f-tunap', f.trans_unapproved);
    setV('#f-tnative', f.trans_native);
    setV('#f-thas', f.trans_has_audio);
    setV('#f-sort', f.sort);
    setC('#f-reverse', f.sort_reverse);
    setV('#d-front', DISPLAY.front);
    setV('#d-back', DISPLAY.back);
    setV('#f-audiolang', AUDIO_LANG);
    setC('#f-startrev', START_REVEALED);
    setC('#f-desktop-auto', DESKTOP_AUTO);
    setC('#f-desktop', DESKTOP_MODE);
    const mdEl = g('#f-desktop');
    if (mdEl) mdEl.disabled = DESKTOP_AUTO;
    const subEl = g('#f-desktop-sub');
    if (subEl) subEl.classList.toggle('dim', DESKTOP_AUTO);
    populateListSelect(); // re-puebla "Lista objetivo" y selecciona el LIST_ID actual
    ['up', 'down', 'left', 'right'].forEach((d) =>
      setV('#g-' + d, GESTURES[d]),
    );
    m.querySelectorAll('.fc-keycap').forEach((b) => {
      const k = KEYS[b.dataset.act] || '';
      b.dataset.key = k;
      b.textContent = keyLabel(k);
      b.classList.toggle('empty', !k);
    });
    const rb = g('#prof-restore'); // colapsa/expande con transición
    if (rb) rb.classList.toggle('collapsed', activeProfile !== PROFILE_DEFAULT);
    updateRestoreBtn(m);
  }
  // SOLO carga la config a los globals (working copy). NO persiste: persistir = saveActive() (Guardar).
  // DESKTOP_MODE no se toca acá (es local). Defaults para campos faltantes -> nunca "se pegan" del perfil anterior.
  function applyConfig(cfg) {
    cfg = cfg || {};
    filters = Object.assign({}, FETCH_DEFAULTS, cfg.filters || {});
    DISPLAY = Object.assign({}, DISPLAY_DEFAULT, cfg.display || {});
    LIST_DISPLAY = Object.assign(
      {},
      LIST_DISPLAY_DEFAULT,
      cfg.listDisplay || {},
    );
    LIST_ID = cfg.listId || '174916';
    AUDIO_LANG = cfg.audioLang || 'eng';
    listSort = cfg.listSort || '-created';
    START_REVEALED = !!cfg.startRevealed;
  }
  const PROF_KEY = 'sm-fc-profiles';
  function loadProfiles() {
    try {
      return JSON.parse(LS.get(PROF_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }
  function saveProfilesMap(p) {
    LS.set(PROF_KEY, JSON.stringify(p));
  }
  function refreshProfileSelect(sel) {
    const others = Object.keys(loadProfiles())
      .filter((n) => n !== PROFILE_DEFAULT)
      .sort((a, b) => a.localeCompare(b));
    const ordered = [PROFILE_DEFAULT, ...others]; // Predeterminado SIEMPRE primero, sin placeholder
    sel.innerHTML = ordered
      .map((n) => `<option>${escHtml(n)}</option>`)
      .join('');
  }
  function snapshotFromModal(m) {
    const cfg = readModalConfig(m);
    cfg.listDisplay = { ...LIST_DISPLAY };
    cfg.listSort = listSort;
    return cfg;
  }
  function snapshotFromGlobals() {
    return {
      filters: JSON.parse(JSON.stringify(filters)),
      display: { ...DISPLAY },
      listDisplay: { ...LIST_DISPLAY },
      listId: LIST_ID,
      audioLang: AUDIO_LANG,
      listSort,
      startRevealed: START_REVEALED,
    };
  }
  // Compara una config con los predeterminados, sin depender del orden de claves del nivel superior.
  function isDefaultCfg(cfg) {
    const d = DEFAULT_CONFIG;
    return (
      JSON.stringify(cfg.filters || {}) === JSON.stringify(d.filters) &&
      JSON.stringify(cfg.display || {}) === JSON.stringify(d.display) &&
      JSON.stringify(cfg.listDisplay || {}) === JSON.stringify(d.listDisplay) &&
      (cfg.listId || '174916') === d.listId &&
      (cfg.audioLang || 'eng') === d.audioLang &&
      (cfg.listSort || '-created') === d.listSort &&
      !!cfg.startRevealed === !!d.startRevealed
    );
  }
  // Habilita/inhabilita visualmente el botón Restaurar según si el form difiere de los defaults.
  function updateRestoreBtn(m) {
    const btn = m.querySelector('#prof-restore');
    if (btn)
      btn.classList.toggle('fc-disabled', isDefaultCfg(snapshotFromModal(m)));
  }
  function ensureDefaultProfile() {
    const profs = loadProfiles();
    if (!profs[PROFILE_DEFAULT]) {
      profs[PROFILE_DEFAULT] = snapshotFromGlobals();
      saveProfilesMap(profs);
    }
  }
  function setActiveProfile(name) {
    activeProfile = name;
    LS.set('sm-fc-active', name);
    dirty = false;
    updateId();
  }
  function rebuildModal(keepOpen) {
    const old = document.getElementById('fc-modal');
    if (old) old.remove();
    buildModal();
    if (keepOpen) openModal();
  }
  function promptDialog(title, placeholder, initial) {
    return new Promise((resolve) => {
      let m = document.getElementById('fc-prompt');
      if (!m) {
        m = document.createElement('div');
        m.id = 'fc-prompt';
        m.innerHTML = `<div class="cbox"><div class="cmsg"></div><input type="text" class="pinput"><div class="cbtns"><button type="button" class="c-cancel">Cancelar</button><button type="button" class="c-ok">Aceptar</button></div></div>`;
        document.body.appendChild(m);
      }
      m.querySelector('.cmsg').textContent = title;
      const input = m.querySelector('.pinput');
      input.placeholder = placeholder || '';
      input.value = initial || '';
      const done = (v) => {
        m.classList.remove('open');
        cleanup();
        resolve(v);
      };
      const onCancel = () => done(null);
      const onOk = () => done(input.value.trim() || null);
      const onBackdrop = (e) => {
        if (e.target === m) done(null);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') done(null);
        else if (e.key === 'Enter') onOk();
      };
      function cleanup() {
        m.querySelector('.c-cancel').removeEventListener('click', onCancel);
        m.querySelector('.c-ok').removeEventListener('click', onOk);
        m.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
      }
      m.querySelector('.c-cancel').addEventListener('click', onCancel);
      m.querySelector('.c-ok').addEventListener('click', onOk);
      m.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => {
        m.classList.add('open');
        input.focus();
        input.select();
      });
    });
  }

  function buildModal() {
    const ex = document.getElementById('fc-modal');
    if (ex) ex.remove(); // nunca dejes dos modales (abriría el vacío)
    const m = document.createElement('div');
    m.id = 'fc-modal';
    const f = filters;
    const linkSel = (id, v) => {
      const o = (val, t) =>
        `<option value="${val}" ${v === val ? 'selected' : ''}>${t}</option>`;
      return `<select id="${id}">${o('', 'Es indistinto')}${o('direct', 'Directo')}${o('indirect', 'Indirecto')}</select>`;
    };
    const originSel = (id, v) => {
      const o = (val, t) =>
        `<option value="${val}" ${v === val ? 'selected' : ''}>${t}</option>`;
      return `<select id="${id}">${o('', 'Cualquiera')}${o('original', 'Original')}${o('translation', 'Traducción')}${o('known', 'Conocido')}${o('unknown', 'Desconocido')}</select>`;
    };
    const atDefaults =
      JSON.stringify(snapshotFromGlobals()) === JSON.stringify(DEFAULT_CONFIG); // ¿el perfil ya está en los predeterminados?
    m.innerHTML = `<div class="box">
      <div class="fc-profiles">
        <div class="fc-prof-row">
          <select id="prof-sel"></select>
          <button type="button" id="prof-new" title="Nuevo perfil" aria-label="Nuevo perfil"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
          <button type="button" id="gh-sync" title="Sincronizar con la nube">Sync</button>
        </div>
        <div class="fc-prof-actions">
          <button type="button" id="prof-save">Guardar</button>
          <button type="button" id="prof-rename">Renombrar</button>
          <button type="button" id="prof-restore" class="fc-icobtn fc-restore-toggle${activeProfile === PROFILE_DEFAULT ? '' : ' collapsed'}${atDefaults ? ' fc-disabled' : ''}" title="Restaurar predeterminados" aria-label="Restaurar predeterminados"><span class="material-icons">settings_backup_restore</span></button>
          <button type="button" id="prof-del" class="fc-icobtn fc-del" title="Borrar perfil" aria-label="Borrar perfil"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg></button>
        </div>
      </div>
      <div class="fc-tabs">
        <button type="button" class="active" data-pane="o">Oraciones</button>
        <button type="button" data-pane="t">Traducción</button>
        <button type="button" data-pane="e">Estudio</button>
        <button type="button" data-pane="c">Controles</button>
      </div>
      <div class="box-scroll">
      <div class="fc-pane active" data-pane="o">
      <label>Palabras (Enter agrega cada término):
        <div class="fc-tagbox" id="f-query-box"><input type="text" id="f-query-input" placeholder="palabra o frase…"></div></label>
      <div class="hint">Cada chip es un término; con varios se busca CUALQUIERA (OR). Las frases de varias palabras se citan solas. Vacío = todas.</div>
      <label>Idioma:<select id="f-from">${langOpts(f.from)}</select></label>
      <div class="hint">Idioma de las oraciones que se traen.</div>
      <div class="row"><span>Length:</span> mín <input type="number" id="f-wmin" value="${f.word_min}" style="width:60px"> máx <input type="number" id="f-wmax" value="${f.word_max}" style="width:60px"></div>
      <div class="hint">Cantidad de palabras (o de caracteres en idiomas sin espacios: japonés, chino…).</div>
      <label>Dueño:<input type="text" id="f-user" value="${f.user || ''}" placeholder="nombre de usuario"></label>
      <div class="hint">Usuario que creó la oración.</div>
      <label>Origen:${originSel('f-origin', f.origin)}</label>
      <div class="hint">Original: no es traducción de otra · Traducción: agregada como traducción · Conocido: original o traducción · Desconocido: no se sabe.</div>
      <label>Es huérfana: ${tri('f-orphans', f.orphans)}</label>
      <div class="hint">Sí: sin dueño (más prob. de errores) · No: con dueño.</div>
      <label>Está reprobada: ${tri('f-unapproved', f.unapproved)}</label>
      <div class="hint">Sí: reprobadas (más prob. de errores) · No: las excluye.</div>
      <label>Is owned by a native: ${tri('f-native', f.native)}</label>
      <div class="hint">Sí: dueño es hablante nativo autoidentificado.</div>
      <label>Tiene voz: ${tri('f-audio', f.has_audio)}</label>
      <div class="hint">Sí: tiene al menos una grabación de audio.</div>
      <label>Etiquetas:<input type="text" id="f-tags" value="${f.tags || ''}" placeholder="separadas por comas"></label>
      <div class="hint">Tags EXACTOS, separados por coma. Deben existir o la búsqueda da error.</div>
      <label>Pertenece a la lista (ID, opcional):<input type="text" id="f-list" value="${f.list || ''}" placeholder="Sin especificar"></label>
      <div class="hint">ID numérico de una lista de Tatoeba.</div>
      <h4>Ordenación</h4>
      <label>Orden:<select id="f-sort">
        <option value="random" ${f.sort === 'random' ? 'selected' : ''}>Al azar</option>
        <option value="relevance" ${f.sort === 'relevance' ? 'selected' : ''}>Relevancia (coincidencias exactas primero)</option>
        <option value="words" ${f.sort === 'words' ? 'selected' : ''}>Palabras (más cortas primero)</option>
        <option value="created" ${f.sort === 'created' ? 'selected' : ''}>Fecha de creación (más nuevas primero)</option>
        <option value="modified" ${f.sort === 'modified' ? 'selected' : ''}>Última modificación (modificadas primero)</option></select></label>
      <div class="hint">‘En orden inverso’ da vuelta el elegido (ej. más viejas / más largas primero).</div>
      <div class="row"><input type="checkbox" id="f-reverse" ${f.sort_reverse ? 'checked' : ''}><span>En orden inverso</span></div>
      </div>
      <div class="fc-pane" data-pane="t">
      <label>Idioma:<select id="f-tto">${langOpts(f.trans_to, 'Cualquier idioma')}</select></label>
      <div class="hint">Solo trae oraciones que TIENEN traducción en este idioma (será el reverso).</div>
      <label>Enlace: ${linkSel('f-tlink', f.trans_link)}</label>
      <div class="hint">Directo: traducción directa · Indirecto: vía otra oración puente.</div>
      <label>Dueño:<input type="text" id="f-tuser" value="${f.trans_user || ''}" placeholder="nombre de usuario"></label>
      <div class="hint">Usuario que creó la traducción.</div>
      <label>Es huérfana: ${tri('f-torphan', f.trans_orphan)}</label>
      <label>Está reprobada: ${tri('f-tunap', f.trans_unapproved)}</label>
      <label>Is owned by a native: ${tri('f-tnative', f.trans_native)}</label>
      <label>Tiene voz: ${tri('f-thas', f.trans_has_audio)}</label>
      <div class="hint">Mismos criterios (Sí/No/Indistinto), aplicados a la traducción.</div>
      </div>
      <div class="fc-pane" data-pane="e">
      <label>Lista objetivo:<select id="f-listid"><option value="${LIST_ID}" selected>Cargando tus listas…</option></select></label>
      <div class="hint">Elegí entre tus listas. Define dónde agregás/quitás y qué ves en "Mi lista".</div>
      <label>Idioma del audio:<select id="f-audiolang">${langOpts(AUDIO_LANG)}</select></label>
      <div class="hint">Qué idioma suena al tocar audio. Debe ser uno de los dos que se traen (frente o reverso); si no, no habrá audio.</div>
      <h4>Visualización (app y lista)</h4>
      <label>Mostrar primero (frente):<select id="d-front">${langOpts(DISPLAY.front)}</select></label>
      <div class="hint">Idioma que ves ANTES de revelar.</div>
      <label>Luego (reverso):<select id="d-back">${langOpts(DISPLAY.back)}</select></label>
      <div class="hint">Idioma que se revela (la "respuesta"). El audio siempre es inglés.</div>
      <div class="row"><input type="checkbox" id="f-startrev" ${START_REVEALED ? 'checked' : ''}><span>Mostrar las cartas ya reveladas al navegar</span></div>
      <div class="hint">Por defecto aparecen ocultas (tocás para revelar). Activá esto para verlas reveladas de entrada.</div>
      <h4>Interacción</h4>
      <div class="row"><input type="checkbox" id="f-desktop-auto" ${DESKTOP_AUTO ? 'checked' : ''}><span>Auto: detectar pantalla</span></div>
      <div class="hint">Si está activo, el modo se elige solo: pantalla chica/móvil → flotante, pantalla grande → ordenador. Este toggle es <b>global</b> (todos los perfiles) y se sincroniza.</div>
      <div class="fc-sub${DESKTOP_AUTO ? ' dim' : ''}" id="f-desktop-sub">
        <div class="row"><input type="checkbox" id="f-desktop" ${DESKTOP_MODE ? 'checked' : ''} ${DESKTOP_AUTO ? 'disabled' : ''}><span>Modo ordenador (paneles laterales)</span></div>
        <div class="hint">Selección manual (cuando Auto está apagado). Es <b>local</b> por dispositivo, no se sincroniza. En PC: Historial y Mi lista empujan el contenido. Atajos: <b>[</b> alterna Mi lista, <b>]</b> alterna Historial.</div>
      </div>
      </div>
      <div class="fc-pane" data-pane="c">
      <h4>Gestos (deslizar, mobile)</h4>
      <label>Arriba ↑:<select id="g-up">${gestOpts(GESTURES.up)}</select></label>
      <label>Abajo ↓:<select id="g-down">${gestOpts(GESTURES.down)}</select></label>
      <label>Izquierda ←:<select id="g-left">${gestOpts(GESTURES.left)}</select></label>
      <label>Derecha →:<select id="g-right">${gestOpts(GESTURES.right)}</select></label>
      <div class="hint">Las zonas de tap quedan fijas; acá configurás solo los deslizamientos.</div>
      <h4>Atajos (teclado, escritorio)</h4>
      ${KEY_ACTS.map((a) => `<div class="fc-keyrow"><span>${actionLabel(a)}</span><button type="button" class="fc-keycap${KEYS[a] ? '' : ' empty'}" data-act="${a}" data-key="${escHtml(KEYS[a] || '')}">${escHtml(keyLabel(KEYS[a]))}</button></div>`).join('')}
      <div class="hint">Tocá un atajo y apretá la tecla nueva. <b>Backspace</b> = sin asignar · <b>Esc</b> = cancelar. Las teclas no se repiten (se mueven al nuevo atajo).</div>
      <button type="button" id="ctrl-reset" class="fc-restore">↺ Restaurar controles por defecto</button>
      </div>
      </div>
      <div class="fc-ver">v${SCRIPT_VERSION}</div>
      <div class="actions"><button id="fc-cancel">Cancelar</button><button id="fc-apply">Aplicar</button></div>
    </div>`;
    document.body.appendChild(m);
    initTagBox(
      m.querySelector('#f-query-box'),
      m.querySelector('#f-query-input'),
      parseQueryChips(f.query),
    );
    // El botón Restaurar se habilita/inhabilita en vivo según si el form difiere de los defaults.
    m.addEventListener('input', () => updateRestoreBtn(m));
    m.addEventListener('change', () => updateRestoreBtn(m));
    updateRestoreBtn(m);
    // Captura de tecla para los atajos: tocás el botón y apretás la tecla nueva.
    m.querySelectorAll('.fc-keycap').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.add('capturing');
        btn.textContent = 'apretá…';
        const onKey = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          document.removeEventListener('keydown', onKey, true);
          btn.classList.remove('capturing');
          if (ev.key === 'Escape') {
            btn.textContent = keyLabel(btn.dataset.key); // Esc cancela
            return;
          }
          if (ev.key === 'Backspace' || ev.key === 'Delete') {
            btn.dataset.key = ''; // Backspace/Supr -> sin asignar
            btn.textContent = keyLabel('');
            btn.classList.add('empty');
            return;
          }
          // Sin duplicados: si la tecla ya está en otro atajo, se la saco (la tecla se "mueve" acá).
          m.querySelectorAll('.fc-keycap').forEach((other) => {
            if (other !== btn && other.dataset.key === ev.key) {
              other.dataset.key = '';
              other.textContent = keyLabel('');
              other.classList.add('empty');
            }
          });
          btn.dataset.key = ev.key;
          btn.textContent = keyLabel(ev.key);
          btn.classList.remove('empty');
        };
        document.addEventListener('keydown', onKey, true); // captura: antes del handler global
      });
    });
    // Restaurar controles por defecto (en el form; se guardan al Aplicar/Guardar).
    const ctrlReset = m.querySelector('#ctrl-reset');
    if (ctrlReset)
      ctrlReset.addEventListener('click', () => {
        ['up', 'down', 'left', 'right'].forEach((d) => {
          const sel = m.querySelector('#g-' + d);
          if (sel) sel.value = GESTURES_DEFAULT[d];
        });
        m.querySelectorAll('.fc-keycap').forEach((b) => {
          b.dataset.key = KEYS_DEFAULT[b.dataset.act] || '';
          b.textContent = keyLabel(b.dataset.key);
        });
        toast('Controles por defecto cargados — Guardá para confirmar', true);
      });
    const profSel = m.querySelector('#prof-sel');
    refreshProfileSelect(profSel);
    profSel.value = activeProfile; // reflejá en qué perfil estamos
    profSel.addEventListener('change', (e) => {
      const name = e.target.value;
      if (!name) return;
      const cfg = loadProfiles()[name];
      if (!cfg) return;
      applyConfig(cfg); // carga el perfil a globals (ya está guardado/sincronizado)
      setActiveProfile(name);
      closePanels();
      listUrls = [];
      resetDeck();
      populateModal(m); // actualiza campos EN SU LUGAR (sin pop) -> el botón restaurar anima colapso/expansión
      toast(`Perfil "${name}" cargado`, true);
    });
    m.querySelector('#prof-new').addEventListener('click', async () => {
      const name = await promptDialog('Nuevo perfil', 'nombre del perfil…', '');
      if (!name) return;
      const profs = loadProfiles();
      if (
        profs[name] &&
        !(await confirmDialog(
          `Ya existe "${name}". ¿Sobrescribir?`,
          'Sobrescribir',
        ))
      )
        return;
      applyConfig(snapshotFromModal(m)); // aplica el estado actual del modal a globals
      applyDesktopPref(m, true); // modo ordenador: local, persiste
      applyControls(m, true); // controles: persistir + sincronizar
      setActiveProfile(name); // primero marcá el activo...
      saveActive(); // ...y guardá globals en ese nuevo perfil (persiste + sincroniza)
      refreshProfileSelect(profSel);
      profSel.value = name;
      closePanels();
      listUrls = [];
      resetDeck();
      toast(`Perfil "${name}" creado`, true);
    });
    const restoreBtn = m.querySelector('#prof-restore');
    if (restoreBtn)
      restoreBtn.addEventListener('click', async () => {
        if (isDefaultCfg(snapshotFromModal(m))) {
          toast('Sin cambios — ya estás en los predeterminados', true);
          return;
        }
        if (
          !(await confirmDialog(
            '¿Restaurar la config de fábrica del perfil Predeterminado?',
            'Restaurar',
          ))
        )
          return;
        applyConfig(DEFAULT_CONFIG); // carga defaults a globals (no toca el modo ordenador, que es local)
        setActiveProfile(PROFILE_DEFAULT);
        saveActive(); // guarda los defaults en Predeterminado (+ sincroniza)
        closePanels();
        listUrls = [];
        resetDeck();
        profSel.value = PROFILE_DEFAULT;
        populateModal(m); // refresca el form con los defaults en su lugar
        toast('Predeterminados restaurados', true);
      });
    m.querySelector('#prof-save').addEventListener('click', () => {
      const name = profSel.value;
      applyConfig(snapshotFromModal(m)); // carga el form a globals...
      applyDesktopPref(m, true); // modo ordenador: local, persiste
      applyControls(m, true); // controles: persistir + sincronizar
      setActiveProfile(name);
      saveActive(); // ...y guarda globals en el perfil activo (persiste + SINCRONIZA)
      closePanels();
      listUrls = [];
      resetDeck();
      toast(`"${name}" guardado y sincronizado ☁︎`, true);
    });
    m.querySelector('#prof-rename').addEventListener('click', async () => {
      const old = profSel.value;
      if (old === PROFILE_DEFAULT) {
        toast('No se puede renombrar el predeterminado', false);
        return;
      }
      const name = await promptDialog('Renombrar perfil', 'nuevo nombre…', old);
      if (!name || name === old) return;
      const profs = loadProfiles();
      if (profs[name]) {
        toast('Ya existe un perfil con ese nombre', false);
        return;
      }
      profs[name] = profs[old];
      delete profs[old];
      saveProfilesMap(profs);
      refreshProfileSelect(profSel);
      profSel.value = name;
      setActiveProfile(name);
      toast(`Renombrado a "${name}"`, true);
    });
    m.querySelector('#prof-del').addEventListener('click', async () => {
      const name = profSel.value;
      if (name === PROFILE_DEFAULT) {
        toast('No se puede borrar el perfil predeterminado', false);
        return;
      }
      if (!(await confirmDialog(`¿Borrar el perfil "${name}"?`, 'Borrar')))
        return;
      const profs = loadProfiles();
      delete profs[name];
      saveProfilesMap(profs);
      const wasActive = activeProfile === name;
      refreshProfileSelect(profSel);
      if (wasActive) {
        // pasamos al Predeterminado: cargá su config y actualizá el form en su lugar (el botón restaurar anima su aparición)
        applyConfig(loadProfiles()[PROFILE_DEFAULT] || {});
        setActiveProfile(PROFILE_DEFAULT);
        closePanels();
        listUrls = [];
        resetDeck();
        profSel.value = PROFILE_DEFAULT;
        populateModal(m);
      } else {
        profSel.value = activeProfile;
      }
      toast(`Perfil "${name}" borrado`, true);
    });
    m.querySelector('#gh-sync').addEventListener('click', async () => {
      if (!ghToken()) {
        // Sin token: pedilo con el prompt temático y guardalo SOLO en este dispositivo (no se sube al gist).
        const tok = await promptDialog(
          'Pegá tu GitHub token (se guarda solo en este dispositivo)',
          'ghp_… o github_pat_…',
          '',
        );
        if (!tok) {
          toast('Sync cancelado — falta el token', false);
          return;
        }
        LS.set('sm-fc-gh-token', tok); // clave local-only: no está en SYNC_KEYS
      }
      toast('Sincronizando…', true);
      try {
        if (await gistPull()) {
          toast('Config remota más nueva — recargando…', true);
          setTimeout(() => location.reload(), 800);
          return;
        }
        await gistPush();
        await gistPullCache(); // mezclá los "agregados" remotos...
        await gistPushCacheAll(); // ...y subí el merge (un archivo por lista)
        toast('Sincronizado ✓', true);
      } catch (e) {
        toast('Error de sync: ' + e.message, false);
      }
    });
    // Auto ON -> el modo manual queda deshabilitado (UI en vivo; el efecto real se aplica con Aplicar/Guardar).
    {
      const da = m.querySelector('#f-desktop-auto'),
        md = m.querySelector('#f-desktop'),
        sub = m.querySelector('#f-desktop-sub');
      if (da && md)
        da.addEventListener('change', () => {
          md.disabled = da.checked;
          if (sub) sub.classList.toggle('dim', da.checked);
        });
    }
    m.querySelectorAll('.fc-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        m.querySelectorAll('.fc-tabs button').forEach((x) =>
          x.classList.toggle('active', x === b),
        );
        m.querySelectorAll('.fc-pane').forEach((p) =>
          p.classList.toggle('active', p.dataset.pane === b.dataset.pane),
        );
        m.querySelector('.box-scroll').scrollTop = 0;
      }),
    );
    m.addEventListener('click', (e) => {
      if (e.target === m) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.classList.contains('open')) closeModal();
    });
    m.querySelector('#fc-cancel').addEventListener('click', cancelModal);
    m.querySelector('#fc-apply').addEventListener('click', () => {
      // APLICAR = probar la config en la app, SIN guardar en el perfil ni subir al gist.
      applyConfig(snapshotFromModal(m)); // solo globals (working copy)
      applyDesktopPref(m, false); // modo ordenador: aplicar EN VIVO para probar, sin persistir
      applyControls(m, false); // controles: aplicar EN VIVO para probar, sin persistir ni sincronizar
      dirty = true;
      updateId(); // marca "• sin guardar"
      closePanels();
      listUrls = [];
      closeModal();
      resetDeck();
    });
  }
  const openModal = () => {
    uiBlocked = true;
    const m = document.getElementById('fc-modal');
    if (!m) return;
    m.classList.add('open');
    populateListSelect();
    // Re-sincronizar los chips de Palabras con el query realmente guardado (evita que se vacíen/desincronicen).
    const box = m.querySelector('#f-query-box'),
      input = m.querySelector('#f-query-input');
    if (box && input) {
      box.querySelectorAll('.fc-tag').forEach((t) => t.remove());
      input.value = '';
      parseQueryChips(filters.query).forEach((c) => addTag(box, input, c));
    }
  };
  const closeModal = () => {
    uiBlocked = false;
    document.getElementById('fc-modal').classList.remove('open');
  };
  // Cancelar = descartar lo no guardado y volver TODO a lo guardado (perfil activo + controles + modo ordenador).
  const cancelModal = () => {
    const wasDirty = dirty;
    applyConfig(loadProfiles()[activeProfile] || {}); // config del perfil guardado
    KEYS = loadObj('sm-fc-keys', KEYS_DEFAULT); // atajos guardados
    GESTURES = loadObj('sm-fc-gestures', GESTURES_DEFAULT); // gestos guardados
    rebuildKeymap();
    DESKTOP_AUTO = LS.get('sm-fc-desktop-auto') !== '0'; // toggle Auto guardado
    DESKTOP_MODE = effectiveDesktop(); // modo efectivo (auto-detectado o manual guardado)
    document.documentElement.classList.toggle('fc-desktop', DESKTOP_MODE);
    dirty = false;
    closePanels();
    listUrls = [];
    rebuildModal(false); // reconstruye el modal (cerrado) con los valores guardados
    if (wasDirty) resetDeck(); // solo recargá si había cambios aplicados que revertir
  };
  // El botón/tecla de config alterna abrir/cerrar.
  const toggleModal = () => {
    const m = document.getElementById('fc-modal');
    if (m && m.classList.contains('open')) closeModal();
    else openModal();
  };

  async function resetDeck() {
    const gen = ++deckGen;
    if (currentAbort) currentAbort.abort(); // cortá el fetch anterior (cambio rápido de perfil)
    currentAbort = new AbortController();
    fetching = false; // el viejo quedó abortado -> liberá el guard para que el nuevo arranque
    cards = [];
    index = -1;
    maxSeen = -1;
    nextUrl = null;
    totalCount = null;
    seenIds.clear();
    showLoading(true);
    frontEl.textContent = '';
    backEl.textContent = '';
    ownersEl.textContent = '';
    await ensureBuffer(true);
    if (gen !== deckGen) return; // llegó otra búsqueda más nueva -> no toques UI ni muestres "sin resultados"
    if (cards.length) {
      index = 0;
      render();
      ensureBuffer();
    } else {
      showLoading(false);
      toast('Sin resultados con esos filtros', false);
    }
  }

  /* ============ SALIR / ENTRAR ============ */
  const isOpen = () => LS.get(K.open) !== '0';
  function setOpen(v) {
    LS.set(K.open, v ? '1' : '0');
    overlay.classList.toggle('hidden', !v);
    launcher.classList.toggle('show', !v);
  }

  /* ============ GESTOS ============ */
  function setupGestures() {
    let sx = 0,
      sy = 0,
      st = 0,
      tracking = false;
    window.addEventListener(
      'touchstart',
      (e) => {
        if (uiBlocked || !isOpen() || e.touches.length !== 1) {
          tracking = false;
          return;
        }
        if (!e.target.closest('#fc-stage')) {
          tracking = false;
          return;
        }
        const t = e.touches[0];
        if (
          t.clientX <= EDGE_GUARD ||
          t.clientX >= window.innerWidth - EDGE_GUARD
        ) {
          tracking = false;
          return;
        }
        sx = t.clientX;
        sy = t.clientY;
        st = Date.now();
        tracking = true;
      },
      { passive: true },
    );

    window.addEventListener(
      'touchmove',
      (e) => {
        if (!tracking) return;
        const t = e.touches[0];
        const dx = t.clientX - sx,
          dy = t.clientY - sy;
        const adx = Math.abs(dx),
          ady = Math.abs(dy);
        if (adx < 10 && ady < 10) return; // todavía no es movimiento real (deja pasar el tap)
        if (e.cancelable) e.preventDefault(); // MEDIO (#fc-stage): scroll/refresh totalmente bloqueado -> gestos limpios. El scroll nativo vive en las barras de arriba/abajo (no se trackean); el edge-guard deja los gestos del navegador.
      },
      { passive: false },
    );

    window.addEventListener(
      'touchend',
      (e) => {
        lastTouch = Date.now();
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - sx,
          dy = t.clientY - sy;
        if (Date.now() - st > SWIPE_MAX_TIME) return;
        const adx = Math.abs(dx),
          ady = Math.abs(dy);
        if (adx < SWIPE_MIN && ady < SWIPE_MIN) {
          handleTap(e.target);
          return;
        } // tap -> resuelto acá (iOS)
        // Deslizamientos -> acción configurable (las zonas de tap quedan fijas).
        if (adx > ady) runAction(dx < 0 ? GESTURES.left : GESTURES.right);
        else runAction(dy < 0 ? GESTURES.up : GESTURES.down);
      },
      { passive: true },
    );
  }

  /* ============ TECLADO ============ */
  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!isOpen() || uiBlocked) return;
      const el = document.activeElement;
      if (
        el &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
      )
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const act = keymap[e.key]; // tecla -> acción (configurable)
      if (!act || act === 'list' || act === 'history' || act === 'config')
        return; // list/history/config van en listeners aparte (deben togglear con el modal/panel abierto)
      e.preventDefault();
      runAction(act);
    });

    // Tecla de config: aparte, porque debe ALTERNAR abrir/cerrar (funciona con el modal abierto también).
    document.addEventListener('keydown', (e) => {
      if (!isOpen() || !KEYS.config || e.key !== KEYS.config) return;
      const el = document.activeElement;
      if (
        el &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
      )
        return; // si estás tipeando en un campo, la tecla escribe (no togglea)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      toggleModal();
    });

    // Atajos de panel (modo ordenador): viven aparte porque deben funcionar AUN con el panel abierto, para alternar/cerrar.
    document.addEventListener('keydown', (e) => {
      if (!DESKTOP_MODE || !isOpen()) return;
      const modal = document.getElementById('fc-modal');
      if (modal && modal.classList.contains('open')) return;
      const el = document.activeElement;
      if (
        el &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
      )
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === KEYS.list) {
        e.preventDefault();
        toggleList();
      } else if (e.key === KEYS.history) {
        e.preventDefault();
        toggleHistory();
      }
    });
  }

  /* ============ ARRANQUE ============ */
  injectStyles();
  document.documentElement.classList.toggle('fc-desktop', DESKTOP_MODE);
  ensureDefaultProfile(); // garantiza el perfil base (lo crea desde los globals iniciales si no existe)
  {
    const _p = loadProfiles();
    if (!_p[activeProfile]) activeProfile = PROFILE_DEFAULT; // activo inválido -> default
    applyConfig(_p[activeProfile] || {}); // FUENTE ÚNICA: cargá el perfil activo a los globals
  }
  buildUI();
  setOpen(isOpen());
  resetDeck();
  // Modo "Auto": re-aplicar el modo al cambiar el tamaño/orientación de pantalla.
  smallScreenMQ.addEventListener('change', () => {
    if (DESKTOP_AUTO) recomputeDesktop();
  });
  // Auto-sync: al arrancar, bajá del gist y si hay algo más nuevo, recargá con la config remota.
  if (ghToken())
    gistPull()
      .then((changed) => {
        if (changed) {
          toast('Config remota más nueva — recargando…', true);
          setTimeout(() => location.reload(), 700);
          return;
        }
        return gistPullCache(); // sin recarga: traé/mezclá el caché de "agregadas recientemente"
      })
      .catch(() => {});
})();
