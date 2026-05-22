(function () {
  "use strict";

  const STORAGE_KEY = "stash-battle-state";
  const CACHE_DB_NAME = "stash-battle-cache";
  const CACHE_DB_VERSION = 1;
  const CACHE_STORE_NAME = "scenes";
  const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes cache expiry

  const RATING_CUSTOM_FIELD_KEY = "battle-rating";
  const BATTLE_COUNT_CUSTOM_FIELD_KEY = "battle-count";
  const DEFAULT_RATING = 1500;
  const RATING_FLOOR = 100;

  let battleTarget = "scenes"; // "scenes" or "performers"

  function getRating(item) {
    if (!item) return null;
    const rating = item.custom_fields?.[RATING_CUSTOM_FIELD_KEY];
    if (rating === undefined || rating === null) return null;
    return Number(rating);
  }

  function setRating(item, rating) {
    if (!item) return;
    if (!item.custom_fields) {
      item.custom_fields = {};
    }
    item.custom_fields[RATING_CUSTOM_FIELD_KEY] = rating;
  }

  function getBattleCount(item) {
    if (!item) return 0;
    const count = item.custom_fields?.[BATTLE_COUNT_CUSTOM_FIELD_KEY];
    if (count === undefined || count === null) return 0;
    return Number(count);
  }

  function setBattleCount(item, count) {
    if (!item) return;
    if (!item.custom_fields) {
      item.custom_fields = {};
    }
    item.custom_fields[BATTLE_COUNT_CUSTOM_FIELD_KEY] = count;
  }

  // Preserve backwards-compatible legacy aliases
  function getSceneRating(scene) { return getRating(scene); }
  function setSceneRating(scene, rating) { setRating(scene, rating); }
  function getSceneBattleCount(scene) { return getBattleCount(scene); }
  function setSceneBattleCount(scene, count) { setBattleCount(scene, count); }

  // Get an item's current 1-based rank and total items in the opponent pool
  function getCurrentRankAndTotal(itemId) {
    if (!itemId) return { rank: null, total: 0 };
    
    const cache = getMemoryCache();
    const allScenes = cache.allScenes || [];
    
    const ratedOnly = allScenes.filter(s => getRating(s) != null);
    const opponentPool = ratedOnly.length >= 1 ? ratedOnly : allScenes;
    
    const idx = opponentPool.findIndex(s => String(s.id) === String(itemId));
    if (idx === -1) {
      return { rank: null, total: opponentPool.length };
    }
    return { rank: idx + 1, total: opponentPool.length };
  }

  // Current comparison pair and mode
  let currentPair = { left: null, right: null };
  let currentRanks = { left: null, right: null };
  let currentMode = "swiss"; // "swiss", "gauntlet", or "champion"
  let gauntletChampion = null; // The scene/performer currently on a winning streak
  let gauntletWins = 0; // Current win streak
  let gauntletChampionRank = 0; // Current rank position (1 = top)
  let gauntletDefeated = []; // IDs of items defeated in current run
  let gauntletFalling = false; // True when champion lost and is finding their floor
  let gauntletFallingScene = null; // The item that's falling to find its position
  let gauntletLow = -1; // Lower bound index of the active binary search
  let gauntletHigh = -1; // Upper bound index of the active binary search
  let totalScenesCount = 0; // Total items for position display
  let disableChoice = false; // Track when inputs should be disabled to prevent multiple events
  let savedFilterParams = ""; // Store URL filter params to detect changes
  let openedFromSceneId = null; // Track scene ID when modal is opened from an individual scene page
  let openedFromPerformerId = null; // Track performer ID when modal is opened from an individual performer page

  // Shuffled pools for both targets (isolated)
  let sessionPools = {
    scenes: {
      shuffledFiltered: [],
      shuffleIndex: 0,
      shuffleFilterKey: null,
      removedIds: new Set()
    },
    performers: {
      shuffledFiltered: [],
      shuffleIndex: 0,
      shuffleFilterKey: null,
      removedIds: new Set()
    }
  };

  function getSessionPool() {
    return sessionPools[battleTarget];
  }

  // In-memory caches for current session
  let scenesMemoryCache = {
    allScenes: null,
    filteredScenes: null,
    filterKey: null,
    timestamp: null
  };

  let performersMemoryCache = {
    allScenes: null,
    filteredScenes: null,
    filterKey: null,
    timestamp: null
  };

  function getMemoryCache() {
    return battleTarget === "scenes" ? scenesMemoryCache : performersMemoryCache;
  }

  const scenesDetailsCache = new Map();
  const performersDetailsCache = new Map();
  function getDetailsCache() {
    return battleTarget === "scenes" ? scenesDetailsCache : performersDetailsCache;
  }

  // Legacy details cache alias for backwards compatibility
  const detailsCache = scenesDetailsCache;

  function getAllCacheKey() {
    return battleTarget === "scenes" ? "all-scenes" : "all-performers";
  }

  function getFilteredCacheKey() {
    return battleTarget === "scenes" ? "filtered-scenes" : "filtered-performers";
  }

  function getStorageKey() {
    return `stash-battle-state-${battleTarget}`;
  }

  // Closure variables mapped to active target to minimize refactoring risk
  let shuffledFilteredScenes = [];
  let shuffleIndex = 0;
  let shuffleFilterKey = null;
  let removedSceneIds = new Set();
  let memoryCache = { allScenes: null, filteredScenes: null, filterKey: null, timestamp: null };

  function syncFromTarget() {
    const pool = sessionPools[battleTarget];
    shuffledFilteredScenes = pool.shuffledFiltered;
    shuffleIndex = pool.shuffleIndex;
    shuffleFilterKey = pool.shuffleFilterKey;
    removedSceneIds = pool.removedIds;
    memoryCache = getMemoryCache();
  }

  function syncToTarget() {
    const pool = sessionPools[battleTarget];
    pool.shuffledFiltered = shuffledFilteredScenes;
    pool.shuffleIndex = shuffleIndex;
    pool.shuffleFilterKey = shuffleFilterKey;
    pool.removedIds = removedSceneIds;
    if (battleTarget === "scenes") {
      scenesMemoryCache = memoryCache;
    } else {
      performersMemoryCache = memoryCache;
    }
  }

  function resetGauntletState() {
    gauntletChampion = null;
    gauntletWins = 0;
    gauntletChampionRank = 0;
    gauntletDefeated = [];
    gauntletFalling = false;
    gauntletFallingScene = null;
    gauntletLow = -1;
    gauntletHigh = -1;
  }

  // Open IndexedDB database
  function openCacheDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
      
      request.onerror = () => {
        console.error("[Stash Battle] IndexedDB error:", request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        resolve(request.result);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.createObjectStore(CACHE_STORE_NAME, { keyPath: "cacheKey" });
        }
      };
    });
  }

  // Get cached scenes from IndexedDB
  async function getCachedScenes(cacheKey) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.get(cacheKey);
        
        request.onsuccess = () => {
          const result = request.result;
          if (result && (Date.now() - result.timestamp) < CACHE_MAX_AGE_MS) {
            resolve(result);
          } else {
            resolve(null); // Cache miss or expired
          }
        };
        
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] Cache read error:", e);
      return null;
    }
  }

  // Store scenes in IndexedDB
  async function setCachedScenes(cacheKey, scenes, count) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        
        const data = {
          cacheKey,
          scenes,
          count,
          timestamp: Date.now()
        };
        
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] Cache write error:", e);
    }
  }

  // Store filtered scenes with filter key for validation
  async function setCachedScenesWithFilter(cacheKey, scenes, count, filterKey) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        
        const data = {
          cacheKey,
          scenes,
          count,
          filterKey,  // Store filter key for validation on read
          timestamp: Date.now()
        };
        
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] Cache write error:", e);
    }
  }

  // Clear all cached scenes/performers (for manual refresh)
  async function clearSceneCache() {
    // Clear in-memory caches synchronously first
    scenesMemoryCache = { allScenes: null, filteredScenes: null, filterKey: null, timestamp: null };
    performersMemoryCache = { allScenes: null, filteredScenes: null, filterKey: null, timestamp: null };
    scenesDetailsCache.clear();
    performersDetailsCache.clear();
    console.log("[Stash Battle] 🗑️ Memory caches cleared synchronously. Clearing IndexedDB...");

    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.clear();
        
        request.onsuccess = () => {
          console.log("[Stash Battle] ✅ All caches cleared (memory + IndexedDB)");
          resolve();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] ❌ IndexedDB clear error:", e);
    }
  }

  // Clear just the active target's filtered cache (for auto-refresh after pool exhaustion)
  async function clearFilteredCache() {
    // Clear filtered memory caches synchronously first
    getMemoryCache().filteredScenes = null;
    getMemoryCache().filterKey = null;

    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.delete(getFilteredCacheKey());
        
        request.onsuccess = () => {
          console.log(`[Stash Battle] 🗑️ Filtered cache (${getFilteredCacheKey()}) cleared (memory + IndexedDB)`);
          resolve();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] ❌ Filtered cache clear error:", e);
    }
  }

  // Background refresh - fetch from network and update caches silently
  async function backgroundRefreshAllScenes() {
    const cacheKey = getAllCacheKey();
    
    try {
      console.log(`[Stash Battle] 🔄 Background refresh started (all ${battleTarget})...`);
      const startTime = Date.now();
      
      const { items, count } = await fetchItems(RATING_SORT_FILTER);
      const fetchTime = Date.now() - startTime;
      
      // Check if count changed (new items added/removed)
      const oldCount = getMemoryCache().allScenes ? getMemoryCache().allScenes.length : 0;
      if (count !== oldCount) {
        console.log(`[Stash Battle] 📊 ${battleTarget} count changed: ${oldCount} → ${count} (${count > oldCount ? '+' : ''}${count - oldCount})`);
      } else {
        console.log(`[Stash Battle] 📊 ${battleTarget} count unchanged: ${count}`);
      }
      
      // Update both caches silently
      getMemoryCache().allScenes = items;
      getMemoryCache().timestamp = Date.now();
      await setCachedScenes(cacheKey, items, count);
      
      console.log(`[Stash Battle] ✅ Background refresh complete: ${items.length} ${battleTarget} in ${fetchTime}ms`);
    } catch (e) {
      console.error(`[Stash Battle] ❌ Background refresh failed for ${battleTarget}:`, e);
    }
  }

  // Get all scenes/performers (uses cache with stale-while-revalidate)
  async function getAllScenesCached() {
    const cacheKey = getAllCacheKey();
    
    // Check memory cache first - return immediately if available
    if (getMemoryCache().allScenes) {
      const cacheAge = Math.round((Date.now() - getMemoryCache().timestamp) / 1000);
      const isStale = (Date.now() - getMemoryCache().timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💾 Memory cache hit (all ${battleTarget}): ${getMemoryCache().allScenes.length} items, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      // If stale, trigger background refresh (but still return cached data)
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshAllScenes(); // Don't await - runs in background
      }
      return { scenes: getMemoryCache().allScenes, count: getMemoryCache().allScenes.length };
    }
    
    // Check IndexedDB cache - return immediately if available
    console.log(`[Stash Battle] 🔍 Memory cache miss, checking IndexedDB for ${battleTarget}...`);
    const cached = await getCachedScenes(cacheKey);
    if (cached) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
      const isStale = (Date.now() - cached.timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💿 IndexedDB cache hit (all ${battleTarget}): ${cached.scenes.length} items, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      getMemoryCache().allScenes = cached.scenes;
      getMemoryCache().timestamp = cached.timestamp;
      
      // If stale, trigger background refresh
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshAllScenes(); // Don't await - runs in background
      }
      return { scenes: cached.scenes, count: cached.count };
    }
    
    // No cache at all - must fetch from network (blocking)
    console.log(`[Stash Battle] 🌐 No cache found, fetching all ${battleTarget} from network (first load)...`);
    const startTime = Date.now();
    
    const { items, count } = await fetchItems(RATING_SORT_FILTER);
    const fetchTime = Date.now() - startTime;
    
    // Store in both caches
    getMemoryCache().allScenes = items;
    getMemoryCache().timestamp = Date.now();
    await setCachedScenes(cacheKey, items, count);
    
    console.log(`[Stash Battle] ✅ Fetched and cached ${items.length} ${battleTarget} in ${fetchTime}ms`);
    return { scenes: items, count };
  }

  // Background refresh for filtered scenes/performers
  async function backgroundRefreshFilteredScenes(searchParams, sceneFilter, filterKey) {
    const cacheKey = getFilteredCacheKey();
    
    try {
      console.log(`[Stash Battle] 🔄 Background refresh started (filtered ${battleTarget})...`);
      const startTime = Date.now();
      
      const { items, count } = await fetchItems(
        getFindFilter(searchParams, RATING_SORT_FILTER),
        sceneFilter
      );
      const fetchTime = Date.now() - startTime;
      
      // Only update if still on same filter
      if (getMemoryCache().filterKey === filterKey) {
        const oldCount = getMemoryCache().filteredScenes ? getMemoryCache().filteredScenes.length : 0;
        if (count !== oldCount) {
          console.log(`[Stash Battle] 📊 Filtered ${battleTarget} count changed: ${oldCount} → ${count} (${count > oldCount ? '+' : ''}${count - oldCount})`);
        } else {
          console.log(`[Stash Battle] 📊 Filtered ${battleTarget} count unchanged: ${count}`);
        }
        
        getMemoryCache().filteredScenes = items;
        getMemoryCache().timestamp = Date.now();
        await setCachedScenesWithFilter(cacheKey, items, count, filterKey);
        
        console.log(`[Stash Battle] ✅ Background refresh complete: ${items.length} filtered ${battleTarget} in ${fetchTime}ms`);
      } else {
        console.log(`[Stash Battle] ⚠️ Filter changed during refresh, discarding results`);
      }
    } catch (e) {
      console.error(`[Stash Battle] ❌ Background refresh (filtered ${battleTarget}) failed:`, e);
    }
  }

  // Build a cache key that includes both sceneFilter (c params) AND search query (q param)
  function buildFilterKey(searchParams, sceneFilter) {
    const q = searchParams.get("q") || "";
    return JSON.stringify({ q, filter: sceneFilter || {} });
  }

  // Get filtered scenes/performers (uses cache with stale-while-revalidate)
  async function getFilteredScenesCached(searchParams, sceneFilter) {
    const filterKey = buildFilterKey(searchParams, sceneFilter);
    const cacheKey = getFilteredCacheKey();
    
    console.log(`[Stash Battle] 🔎 Filter active, checking filtered cache for ${battleTarget}...`);
    
    // Check memory cache first - return immediately if available and same filter
    if (getMemoryCache().filteredScenes && getMemoryCache().filterKey === filterKey) {
      const cacheAge = Math.round((Date.now() - getMemoryCache().timestamp) / 1000);
      const isStale = (Date.now() - getMemoryCache().timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💾 Memory cache hit (filtered ${battleTarget}): ${getMemoryCache().filteredScenes.length} items, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      // If stale, trigger background refresh
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshFilteredScenes(searchParams, sceneFilter, filterKey);
      }
      return { scenes: getMemoryCache().filteredScenes, count: getMemoryCache().filteredScenes.length };
    }
    
    // Check IndexedDB cache (only if filter key matches)
    console.log(`[Stash Battle] 🔍 Memory cache miss (filtered ${battleTarget}), checking IndexedDB...`);
    const cached = await getCachedScenes(cacheKey);
    if (cached && cached.filterKey === filterKey) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
      const isStale = (Date.now() - cached.timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💿 IndexedDB cache hit (filtered ${battleTarget}): ${cached.scenes.length} items, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      getMemoryCache().filteredScenes = cached.scenes;
      getMemoryCache().filterKey = filterKey;
      getMemoryCache().timestamp = cached.timestamp;
      
      // If stale, trigger background refresh
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshFilteredScenes(searchParams, sceneFilter, filterKey);
      }
      return { scenes: cached.scenes, count: cached.count };
    }
    
    if (cached) {
      console.log(`[Stash Battle] 💿 IndexedDB cache exists but filter changed, fetching new ${battleTarget} data...`);
    } else {
      console.log(`[Stash Battle] 💿 IndexedDB cache miss (filtered ${battleTarget})`);
    }
    
    // No matching cache - must fetch from network (blocking)
    console.log(`[Stash Battle] 🌐 Fetching filtered ${battleTarget} from network...`);
    const startTime = Date.now();
    
    const { items, count } = await fetchItems(
      getFindFilter(searchParams, RATING_SORT_FILTER),
      sceneFilter
    );
    const fetchTime = Date.now() - startTime;
    
    // Store in both caches (include filterKey so we can validate on read)
    getMemoryCache().filteredScenes = items;
    getMemoryCache().filterKey = filterKey;
    getMemoryCache().timestamp = Date.now();
    await setCachedScenesWithFilter(cacheKey, items, count, filterKey);
    
    console.log(`[Stash Battle] ✅ Fetched and cached ${items.length} filtered ${battleTarget} in ${fetchTime}ms`);
    return { scenes: items, count };
  }

  // Update an item's rating and reposition it in the sorted array to keep ranks accurate
  function repositionItemInArray(arr, itemId, newRating, newBattleCount = null) {
    const idx = arr.findIndex(s => s.id === itemId);
    if (idx === -1) return false;
    
    const item = arr[idx];
    setRating(item, newRating);
    if (newBattleCount !== null) {
      setBattleCount(item, newBattleCount);
    }
    
    // Remove from current position
    arr.splice(idx, 1);
    
    // Find correct position (array is sorted by rating DESC)
    const newIdx = arr.findIndex(s => (getRating(s) || 0) < newRating);
    
    // Insert at correct position
    if (newIdx === -1) {
      arr.push(item); // Lowest rated, goes at end
    } else {
      arr.splice(newIdx, 0, item);
    }
    
    return true;
  }

  // Legacy repositionSceneInArray alias for backwards compatibility
  function repositionSceneInArray(arr, sceneId, newRating, newBattleCount = null) {
    return repositionItemInArray(arr, sceneId, newRating, newBattleCount);
  }

  // Update an item's rating in the memory cache and IndexedDB (keeps cache in sync after rating changes)
  function updateItemInCaches(itemId, newRating, newBattleCount = null) {
    const allCacheKey = getAllCacheKey();
    const filteredCacheKey = getFilteredCacheKey();
    
    // Reposition in all items (keeps rankings accurate, item stays for opponent pool)
    if (getMemoryCache().allScenes) {
      repositionItemInArray(getMemoryCache().allScenes, itemId, newRating, newBattleCount);
      // Update IndexedDB for all-scenes/all-performers
      setCachedScenes(allCacheKey, getMemoryCache().allScenes, getMemoryCache().allScenes.length);
      console.log(`[Stash Battle] 📝 Updated ${battleTarget.slice(0, -1)} ${itemId} rating to ${newRating} in caches`);
    }
    
    // Also update and reposition in filteredScenes if present
    if (getMemoryCache().filteredScenes) {
      repositionItemInArray(getMemoryCache().filteredScenes, itemId, newRating, newBattleCount);
      console.log(`[Stash Battle] 📝 Updated ${battleTarget.slice(0, -1)} ${itemId} rating to ${newRating} in filtered cache`);
      // Update IndexedDB for filtered-scenes/filtered-performers
      if (getMemoryCache().filterKey) {
        setCachedScenesWithFilter(filteredCacheKey, getMemoryCache().filteredScenes, getMemoryCache().filteredScenes.length, getMemoryCache().filterKey);
      }
    }

    // Also update in detailsCache if present (ensures UI doesn't show stale info on refresh)
    if (getDetailsCache().has(itemId)) {
      const item = getDetailsCache().get(itemId);
      setRating(item, newRating);
      if (newBattleCount !== null) {
        setBattleCount(item, newBattleCount);
      }
    }
  }

  // Legacy updateSceneInCaches alias for backwards compatibility
  function updateSceneInCaches(sceneId, newRating, newBattleCount = null) {
    updateItemInCaches(sceneId, newRating, newBattleCount);
  }

  // ============================================
  // STATE PERSISTENCE
  // ============================================

  function setBattleTarget(target) {
    syncToTarget();
    battleTarget = target;
    syncFromTarget();
  }

  function saveState() {
    syncToTarget();
    const state = {
      currentPair,
      currentRanks,
      currentMode,
      gauntletChampion,
      gauntletWins,
      gauntletChampionRank,
      gauntletDefeated,
      gauntletFalling,
      gauntletFallingScene,
      gauntletLow,
      gauntletHigh,
      totalScenesCount,
      savedFilterParams: window.location.search
    };
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(state));
      localStorage.setItem("stash-battle-target", battleTarget);
    } catch (e) {
      console.error("[Stash Battle] Failed to save state:", e);
    }
  }

  function loadState() {
    try {
      let saved = localStorage.getItem(getStorageKey());
      if (!saved && battleTarget === "scenes") {
        // Fall back to old scene storage key
        saved = localStorage.getItem(STORAGE_KEY);
      }
      if (saved) {
        const state = JSON.parse(saved);
        currentPair = state.currentPair || { left: null, right: null };
        currentRanks = state.currentRanks || { left: null, right: null };
        currentMode = state.currentMode || "swiss";
        gauntletChampion = state.gauntletChampion || null;
        gauntletWins = state.gauntletWins || 0;
        gauntletChampionRank = state.gauntletChampionRank || 0;
        gauntletDefeated = state.gauntletDefeated || [];
        gauntletFalling = state.gauntletFalling || false;
        gauntletFallingScene = state.gauntletFallingScene || null;
        gauntletLow = state.gauntletLow !== undefined ? state.gauntletLow : -1;
        gauntletHigh = state.gauntletHigh !== undefined ? state.gauntletHigh : -1;
        totalScenesCount = state.totalScenesCount || 0;
        savedFilterParams = state.savedFilterParams || "";
        syncFromTarget();
        return true;
      }
    } catch (e) {
      console.error("[Stash Battle] Failed to load state:", e);
    }
    return false;
  }

  function clearState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.error("[Stash Battle] Failed to clear state:", e);
    }
  } 

  // ============================================
  // GRAPHQL QUERIES
  // ============================================

  async function graphqlQuery(query, variables = {}) {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const result = await response.json();
    if (result.errors) {
      console.error("[Stash Battle] GraphQL error:", result.errors);
      throw new Error(result.errors[0].message);
    }
    return result.data;
  }

  const MINIMAL_SCENE_FRAGMENT = `
    id
    custom_fields
  `;

  const FULL_SCENE_FRAGMENT = `
    id
    title
    date
    custom_fields
    play_count
    play_duration
    o_counter
    rating100
    paths {
      screenshot
      preview
    }
    files {
      duration
      path
    }
    studio {
      name
    }
    performers {
      name
    }
    tags {
      name
    }
  `;

  const MINIMAL_PERFORMER_FRAGMENT = `
    id
    custom_fields
  `;

  const FULL_PERFORMER_FRAGMENT = `
    id
    name
    disambiguation
    image_path
    rating100
    scene_count
    o_counter
    custom_fields
    tags {
      name
    }
  `;

  const RATING_SORT_FILTER = {
    per_page: -1,
    sort: "rating",
    direction: "DESC"
  };

  const FIND_SCENES_QUERY = `
    query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
      findScenes(filter: $filter, scene_filter: $scene_filter) {
        count
        scenes {
          ${MINIMAL_SCENE_FRAGMENT}
        }
      }
    }
  `;

  const FIND_PERFORMERS_QUERY = `
    query FindPerformers($filter: FindFilterType, $performer_filter: PerformerFilterType) {
      findPerformers(filter: $filter, performer_filter: $performer_filter) {
        count
        performers {
          ${MINIMAL_PERFORMER_FRAGMENT}
        }
      }
    }
  `;

  const FIND_GROUPS_QUERY = `
    query FindGroups($filter: FindFilterType) {
      findGroups(filter: $filter) {
        count
        groups {
          id
          name
        }
      }
    }
  `;

  const CREATE_GROUP_MUTATION = `
    mutation CreateGroup($input: GroupCreateInput!) {
      groupCreate(input: $input) {
        id
        name
      }
    }
  `;

  const FIND_SCENES_FOR_GROUP_SYNC_QUERY = `
    query SyncFindScenes($filter: FindFilterType, $rated_filter: SceneFilterType, $group_filter: SceneFilterType) {
      rated: findScenes(filter: $filter, scene_filter: $rated_filter) {
        scenes {
          id
          custom_fields
          groups {
            group {
              id
            }
            scene_index
          }
        }
      }
      grouped: findScenes(filter: $filter, scene_filter: $group_filter) {
        scenes {
          id
          custom_fields
          groups {
            group {
              id
            }
            scene_index
          }
        }
      }
    }
  `;

  const FIND_SCENE_DETAILS_QUERY = `
    query FindSceneDetails($id: ID!) {
      findScene(id: $id) {
        ${FULL_SCENE_FRAGMENT}
      }
    }
  `;

  const FIND_PERFORMER_DETAILS_QUERY = `
    query FindPerformerDetails($id: ID!) {
      findPerformer(id: $id) {
        ${FULL_PERFORMER_FRAGMENT}
      }
    }
  `;

  const FIND_IMAGES_QUERY = `
    query FindImages($filter: FindFilterType, $image_filter: ImageFilterType) {
      findImages(filter: $filter, image_filter: $image_filter) {
        count
        images {
          id
          paths {
            thumbnail
            image
          }
        }
      }
    }
  `;


  // Fetch either scenes or performers from network depending on battleTarget
  async function fetchItems(filter, itemFilter = null) {
    if (battleTarget === "scenes") {
      const data = await graphqlQuery(FIND_SCENES_QUERY, {
        filter,
        scene_filter: itemFilter
      });
      const scenes = data.findScenes.scenes || [];
      scenes.sort((a, b) => {
        const rA = getRating(a);
        const rB = getRating(b);
        if (rA === null && rB === null) return 0;
        if (rA === null) return 1;
        if (rB === null) return -1;
        return rB - rA;
      });
      return {
        items: scenes,
        count: data.findScenes.count || 0
      };
    } else {
      const data = await graphqlQuery(FIND_PERFORMERS_QUERY, {
        filter,
        performer_filter: itemFilter
      });
      const performers = data.findPerformers.performers || [];
      performers.sort((a, b) => {
        const rA = getRating(a);
        const rB = getRating(b);
        if (rA === null && rB === null) return 0;
        if (rA === null) return 1;
        if (rB === null) return -1;
        return rB - rA;
      });
      return {
        items: performers,
        count: data.findPerformers.count || 0
      };
    }
  }

  // Legacy fetchScenes alias for backwards compatibility
  async function fetchScenes(filter, sceneFilter = null) {
    const { items, count } = await fetchItems(filter, sceneFilter);
    return { scenes: items, count };
  }

  async function fetchItemDetails(itemId) {
    if (!itemId) return null;
    
    // Check in-memory cache first
    if (getDetailsCache().has(itemId)) {
      return getDetailsCache().get(itemId);
    }
    
    try {
      const query = battleTarget === "scenes" ? FIND_SCENE_DETAILS_QUERY : FIND_PERFORMER_DETAILS_QUERY;
      const promises = [graphqlQuery(query, { id: itemId })];
      if (battleTarget === "performers") {
        promises.push(
          graphqlQuery(FIND_IMAGES_QUERY, {
            filter: { page: 1, per_page: 80, sort: "path", direction: "ASC" },
            image_filter: {
              performers: { value: [itemId.toString()], excludes: [], modifier: "INCLUDES_ALL" }
            }
          }).catch((e) => {
            console.error(`[Stash Battle] Error fetching images for performer ${itemId}:`, e);
            return null;
          })
        );
      }
      
      const [data, imagesData] = await Promise.all(promises);
      const details = battleTarget === "scenes" ? data.findScene : data.findPerformer;
      if (details) {
        if (battleTarget === "performers") {
          details.images = (imagesData && imagesData.findImages) ? (imagesData.findImages.images || []) : [];
        }
        getDetailsCache().set(itemId, details);
      }
      return details;
    } catch (e) {
      console.error(`[Stash Battle] Error fetching ${battleTarget.slice(0, -1)} details for ID ${itemId}:`, e);
      return null;
    }
  }

  // Legacy fetchSceneDetails alias for backwards compatibility
  async function fetchSceneDetails(sceneId) {
    return fetchItemDetails(sceneId);
  }

  function renderConfigPanel() {
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;
    
    // Hide standard action buttons and keyboard hint
    const actionsEl = document.querySelector(".pwr-actions");
    if (actionsEl) {
      actionsEl.style.display = "none";
    }

    // Hide any other banners
    const statusEl = document.getElementById("pwr-gauntlet-status");
    if (statusEl) {
      statusEl.style.display = "none";
    }

    // Count rated items
    const isPerformer = battleTarget === "performers";
    const itemNoun = isPerformer ? "performers" : "scenes";
    const allItems = memoryCache.allScenes || [];
    const ratedCount = allItems.filter(s => getRating(s) !== null).length;

    comparisonArea.innerHTML = `
      <div class="pwr-config-panel" style="position: relative;">
        <div class="pwr-config-header">
          <h2 class="pwr-config-title">⚙️ Stash Battle Configurations</h2>
          <p class="pwr-config-subtitle">Manage your ELO head-to-head matching preferences and data.</p>
        </div>
        <div class="pwr-config-content">

          <div class="pwr-config-card">
            <h3 class="pwr-card-title">Reset All Ratings</h3>
            <p class="pwr-card-desc">
              Completely erase all custom ELO ratings and battle counts across your entire library of ${itemNoun}. 
              This will restore all ${itemNoun} to the default starting baseline (1500, unrated). 
              <strong>Warning: This action is permanent and cannot be undone.</strong>
            </p>
            <button id="pwr-reset-ratings-btn" class="pwr-btn-danger" ${ratedCount === 0 ? "disabled" : ""}>
              💥 Reset All Ratings (${ratedCount} rated)
            </button>
            <div id="pwr-reset-progress-area"></div>
          </div>
        </div>
        <div class="pwr-confirm-actions" style="margin-top:20px; justify-content: flex-end;">
          <button id="pwr-config-back-btn" class="btn btn-secondary">Back to Battle</button>
        </div>
      </div>
    `;

    // Attach button listeners
    const backBtn = comparisonArea.querySelector("#pwr-config-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (actionsEl) actionsEl.style.display = "";
        loadNewPair();
      });
    }

    const resetBtn = comparisonArea.querySelector("#pwr-reset-ratings-btn");
    if (resetBtn && ratedCount > 0) {
      resetBtn.addEventListener("click", () => {
        showResetConfirmationModal(ratedCount);
      });
    }
  }

  function showResetConfirmationModal(n) {
    const configPanel = document.querySelector(".pwr-config-panel");
    if (!configPanel) return;

    const isPerformer = battleTarget === "performers";
    const itemNoun = isPerformer ? "performers" : "scenes";

    const overlay = document.createElement("div");
    overlay.className = "pwr-confirm-overlay";
    overlay.innerHTML = `
      <div class="pwr-confirm-dialog">
        <div class="pwr-confirm-icon">⚠️</div>
        <h3 class="pwr-confirm-title">Are you sure?</h3>
        <p class="pwr-confirm-message">
          Are you sure you want to <strong>DESTROY</strong> the ratings of all <strong>${n}</strong> rated ${itemNoun}?
          This will permanently erase all matchmaking history and ELO scores.
        </p>
        <div class="pwr-confirm-actions">
          <button id="pwr-confirm-cancel-btn" class="btn btn-secondary">Cancel</button>
          <button id="pwr-confirm-destroy-btn" class="pwr-btn-danger">Destroy</button>
        </div>
      </div>
    `;

    configPanel.appendChild(overlay);

    overlay.querySelector("#pwr-confirm-cancel-btn").addEventListener("click", () => {
      overlay.remove();
    });

    overlay.querySelector("#pwr-confirm-destroy-btn").addEventListener("click", async () => {
      overlay.remove(); // Remove confirmation modal
      await executeRatingsDestroy(n);
    });
  }

  async function executeRatingsDestroy(totalCount) {
    const resetBtn = document.getElementById("pwr-reset-ratings-btn");
    const backBtn = document.getElementById("pwr-config-back-btn");
    const progressArea = document.getElementById("pwr-reset-progress-area");

    if (resetBtn) resetBtn.disabled = true;
    if (backBtn) backBtn.disabled = true;

    if (progressArea) {
      progressArea.innerHTML = `
        <div class="pwr-progress-wrapper">
          <div class="pwr-progress-status-container">
            <span class="pwr-progress-status">Destroying ratings...</span>
            <span id="pwr-progress-percent" class="pwr-progress-count">0 / ${totalCount} (0%)</span>
          </div>
          <div class="pwr-progress-track">
            <div id="pwr-progress-bar-fill" class="pwr-progress-bar"></div>
          </div>
        </div>
      `;
    }

    const allItems = memoryCache.allScenes || [];
    const ratedItems = allItems.filter(s => getRating(s) !== null);
    const total = ratedItems.length;

    const chunkSize = 50;
    let completedCount = 0;
    const isPerformer = battleTarget === "performers";

    try {
      for (let i = 0; i < total; i += chunkSize) {
        const chunk = ratedItems.slice(i, i + chunkSize);
        
        // Dynamically build bulk aliased mutations with variables definitions
        let mutationParts = [];
        let varDefs = [];
        let variables = {};
        chunk.forEach((item, index) => {
          const varType = isPerformer ? "PerformerUpdateInput!" : "SceneUpdateInput!";
          const mutName = isPerformer ? "performerUpdate" : "sceneUpdate";
          varDefs.push(`$input_${index}: ${varType}`);
          mutationParts.push(`update_${index}: ${mutName}(input: $input_${index}) { id }`);
          variables[`input_${index}`] = {
            id: item.id,
            custom_fields: {
              remove: [
                RATING_CUSTOM_FIELD_KEY,
                BATTLE_COUNT_CUSTOM_FIELD_KEY
              ]
            }
          };
        });
        
        const bulkMutation = `
          mutation ResetRatingsBulk(${varDefs.join(', ')}) {
            ${mutationParts.join('\n            ')}
          }
        `;

        // Send the bulk mutation with variables
        await graphqlQuery(bulkMutation, variables);

        completedCount += chunk.length;
        const percent = Math.round((completedCount / total) * 100);

        // Update progress bar
        const barFill = document.getElementById("pwr-progress-bar-fill");
        const progressPercentText = document.getElementById("pwr-progress-percent");
        if (barFill) barFill.style.width = `${percent}%`;
        if (progressPercentText) {
          progressPercentText.textContent = `${completedCount} / ${total} (${percent}%)`;
        }
      }

      // Success screen/feedback
      if (progressArea) {
        progressArea.innerHTML = `
          <div class="pwr-progress-status-container" style="margin-top: 15px;">
            <span class="pwr-progress-status" style="color: #4caf50; font-weight: 600;">✅ Ratings successfully destroyed!</span>
          </div>
        `;
      }

      // Clear all caches synchronously to reflect the resets
      await clearSceneCache();
      
      // Reset shuffle and session states
      shuffledFilteredScenes = [];
      shuffleIndex = 0;
      shuffleFilterKey = null;
      removedSceneIds.clear();
      resetGauntletState();
      saveState();

      // Show actions button container again
      const actionsEl = document.querySelector(".pwr-actions");
      if (actionsEl) {
        actionsEl.style.display = "";
      }

    } catch (e) {
      console.error("[Stash Battle] ❌ Rating reset failed:", e);
      if (progressArea) {
        progressArea.innerHTML = `
          <div class="pwr-progress-status-container" style="margin-top: 15px;">
            <span class="pwr-progress-status" style="color: #f44336; font-weight: 600;">❌ Reset failed: ${e.message}</span>
          </div>
        `;
      }
      if (resetBtn) resetBtn.disabled = false;
      if (backBtn) backBtn.disabled = false;
    }
  }

  async function executeRankingsSync() {
    const syncBtn = document.getElementById("pwr-sync-rankings-main-btn");
    const mainSkipBtn = document.getElementById("pwr-skip-btn");
    const mainRefreshBtn = document.getElementById("pwr-refresh-cache-btn");
    const mainConfigBtn = document.getElementById("pwr-config-btn");

    disableChoice = true;
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = "🔄 Connecting...";
    }
    if (mainSkipBtn) mainSkipBtn.disabled = true;
    if (mainRefreshBtn) mainRefreshBtn.disabled = true;
    if (mainConfigBtn) mainConfigBtn.disabled = true;

    const GROUP_NAME = "Stash Battle Rankings";

    function setStatus(msg, percent = null) {
      if (syncBtn) {
        if (percent !== null) {
          syncBtn.textContent = `🔄 Syncing (${percent}%)`;
        } else {
          syncBtn.textContent = `🔄 ${msg}`;
        }
      }
    }

    try {
      setStatus("Finding/Creating group...");

      // 1. Find or create group
      const groupsData = await graphqlQuery(FIND_GROUPS_QUERY, {
        filter: { q: GROUP_NAME }
      });
      
      let groupId = null;
      const existingGroup = (groupsData.findGroups.groups || []).find(g => g.name === GROUP_NAME);
      if (existingGroup) {
        groupId = existingGroup.id;
      } else {
        const createData = await graphqlQuery(CREATE_GROUP_MUTATION, {
          input: { name: GROUP_NAME }
        });
        groupId = createData.groupCreate.id;
      }

      setStatus("Fetching scenes...");

      // 2. Fetch rated scenes and scenes already in the group using a batched query
      const scenesData = await graphqlQuery(FIND_SCENES_FOR_GROUP_SYNC_QUERY, {
        filter: { per_page: -1 },
        rated_filter: {
          custom_fields: [
            {
              field: "battle-rating",
              modifier: "NOT_NULL",
              value: []
            }
          ]
        },
        group_filter: {
          groups: {
            value: [groupId],
            modifier: "INCLUDES"
          }
        }
      });

      // Merge both sets of scenes by ID to handle rated and/or grouped scenes
      const allScenesMap = new Map();
      (scenesData.rated.scenes || []).forEach(s => allScenesMap.set(s.id, s));
      (scenesData.grouped.scenes || []).forEach(s => allScenesMap.set(s.id, s));
      const allScenes = Array.from(allScenesMap.values());

      // 3. Process scenes:
      const ratedScenes = allScenes.filter(s => getSceneRating(s) !== null);
      
      // Sort rated scenes descending by battle-rating
      ratedScenes.sort((a, b) => {
        const rA = getSceneRating(a);
        const rB = getSceneRating(b);
        return rB - rA;
      });

      const ratedSceneIds = new Set(ratedScenes.map(s => s.id));
      const scenesToUpdate = [];

      // Process rated scenes to set correct index
      ratedScenes.forEach((scene, index) => {
        const targetIndex = index + 1; // 1-based scene_index
        
        const otherGroups = [];
        let currentRankGroup = null;
        
        (scene.groups || []).forEach(sg => {
          if (sg.group && sg.group.id === groupId) {
            currentRankGroup = sg;
          } else if (sg.group) {
            otherGroups.push({
              group_id: sg.group.id,
              scene_index: sg.scene_index
            });
          }
        });

        const needsUpdate = !currentRankGroup || currentRankGroup.scene_index !== targetIndex;

        if (needsUpdate) {
          const targetGroups = [
            ...otherGroups,
            { group_id: groupId, scene_index: targetIndex }
          ];
          scenesToUpdate.push({
            id: scene.id,
            groups: targetGroups
          });
        }
      });

      // Process unrated scenes to remove them from the group if they're in it
      allScenes.forEach(scene => {
        if (ratedSceneIds.has(scene.id)) return;
        
        const hasRankGroup = (scene.groups || []).some(sg => sg.group && sg.group.id === groupId);
        if (hasRankGroup) {
          const targetGroups = (scene.groups || [])
            .filter(sg => sg.group && sg.group.id !== groupId)
            .map(sg => ({
              group_id: sg.group.id,
              scene_index: sg.scene_index
            }));

          scenesToUpdate.push({
            id: scene.id,
            groups: targetGroups
          });
        }
      });

      const totalUpdates = scenesToUpdate.length;
      if (totalUpdates === 0) {
        if (syncBtn) {
          syncBtn.textContent = "✅ Already Synced!";
          setTimeout(() => {
            syncBtn.textContent = "🔄 Sync Rankings";
          }, 2000);
        }
        return;
      }

      // 4. Batch updates in chunks of 50
      const chunkSize = 50;
      let completedCount = 0;

      for (let i = 0; i < totalUpdates; i += chunkSize) {
        const chunk = scenesToUpdate.slice(i, i + chunkSize);
        
        let mutationParts = [];
        let varDefs = [];
        let variables = {};
        
        chunk.forEach((updateObj, index) => {
          varDefs.push(`$input_${index}: SceneUpdateInput!`);
          mutationParts.push(`update_${index}: sceneUpdate(input: $input_${index}) { id }`);
          variables[`input_${index}`] = {
            id: updateObj.id,
            groups: updateObj.groups
          };
        });

        const bulkMutation = `
          mutation SyncRankingsBulk(${varDefs.join(', ')}) {
            ${mutationParts.join('\n            ')}
          }
        `;

        await graphqlQuery(bulkMutation, variables);

        completedCount += chunk.length;
        const percent = Math.round((completedCount / totalUpdates) * 100);

        setStatus("Syncing...", percent);
      }

      if (syncBtn) {
        syncBtn.textContent = `✅ Sync Complete! (${totalUpdates})`;
        setTimeout(() => {
          syncBtn.textContent = "🔄 Sync Rankings";
        }, 2000);
      }

    } catch (e) {
      console.error("[Stash Battle] ❌ ELO rank sync failed:", e);
      if (syncBtn) {
        syncBtn.textContent = `❌ Sync Failed`;
        setTimeout(() => {
          syncBtn.textContent = "🔄 Sync Rankings";
        }, 3000);
      }
    } finally {
      disableChoice = false;
      if (syncBtn) syncBtn.disabled = false;
      if (mainSkipBtn) mainSkipBtn.disabled = false;
      if (mainRefreshBtn) mainRefreshBtn.disabled = false;
      if (mainConfigBtn) mainConfigBtn.disabled = false;
    }
  }

  async function fetchScenes(filter, sceneFilter = null) {
    const data = await graphqlQuery(FIND_SCENES_QUERY, {
      filter,
      scene_filter: sceneFilter
    });
    const scenes = data.findScenes.scenes || [];
    scenes.sort((a, b) => {
      const rA = getSceneRating(a);
      const rB = getSceneRating(b);
      if (rA === null && rB === null) return 0;
      if (rA === null) return 1;
      if (rB === null) return -1;
      return rB - rA;
    });
    return {
      scenes,
      count: data.findScenes.count || 0
    };
  }

  // ============================================
  // NAVIGATION
  // ============================================

  // Open scene in a new tab
  function navigateToUrl(url) {
    window.open(url, '_blank');
  }

  // Get current scene ID from pathname if on an individual scene page
  function getCurrentSceneId() {
    const path = window.location.pathname;
    const match = path.match(/^\/scenes\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const id = match[1];
      if (id && id !== "scenes") {
        return id;
      }
    }
    return null;
  }

  // Get current performer ID from pathname if on an individual performer page
  function getCurrentPerformerId() {
    const path = window.location.pathname;
    const match = path.match(/^\/performers\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const id = match[1];
      if (id && id !== "performers") {
        return id;
      }
    }
    return null;
  }

  function getCurrentPageItemId() {
    return battleTarget === "scenes" ? getCurrentSceneId() : getCurrentPerformerId();
  }

  // ============================================
  // URL FILTER PARSING
  // ============================================

  // Get current URL search params
  function getSearchParams() {
    return new URLSearchParams(window.location.search);
  }

  // Build FindFilterType from search params
  function getFindFilter(searchParams, overrides = {}) {
    const filter = {
      per_page: overrides.per_page ?? -1,
      sort: overrides.sort ?? (searchParams.get("sortby") || "rating"),
      direction: overrides.direction ?? (searchParams.get("sortdir")?.toUpperCase() || "DESC"),
      ...overrides
    };
    
    // Include search query if present
    const query = searchParams.get("q");
    if (query) {
      filter.q = query;
    }
    
    return filter;
  }

  // Translate JSON string between URL format (parentheses) and standard JSON (braces)
  // Ported from Stash's ListFilterModel.translateJSON
  // This safely handles parentheses inside quoted strings
  function translateJSON(jsonString, decoding) {
    let inString = false;
    let escape = false;
    return [...jsonString].map((c) => {
      if (escape) {
        escape = false;
        return c;
      }
      switch (c) {
        case "\\":
          if (inString) escape = true;
          break;
        case '"':
          inString = !inString;
          break;
        case "(":
          if (decoding && !inString) return "{";
          break;
        case ")":
          if (decoding && !inString) return "}";
          break;
      }
      return c;
    }).join("");
  }

  // Criterion category mappings for URL → GraphQL transformation
  // Each category requires different transformation logic
  const CRITERION_CATEGORIES = {
    // Boolean: no modifier, value is "true"/"false" string → convert to boolean
    boolean: new Set(["organized", "interactive", "performer_favorite", "filter_favorites"]),
    // StringEnum: URL has modifier but GraphQL just expects the string value directly
    stringEnum: new Set(["is_missing", "has_markers"]),
    // Multi: value is array of {id, label} → extract IDs only
    multi: new Set(["performers", "groups", "movies", "galleries"]),
    // HierarchicalMulti: value has {items, excluded, depth} → rename to {value, excludes, depth} and extract IDs
    hierarchicalMulti: new Set(["tags", "studios", "performer_tags"]),
  };
  
  // Resolution string to GraphQL enum mapping
  // URL uses human-readable strings, GraphQL expects ResolutionEnum values
  const RESOLUTION_MAP = {
    "144p": "VERY_LOW",
    "240p": "LOW",
    "360p": "R360P",
    "480p": "STANDARD",
    "540p": "WEB_HD",
    "720p": "STANDARD_HD",
    "1080p": "FULL_HD",
    "1440p": "QUAD_HD",
    "4k": "FOUR_K",
    "5k": "FIVE_K",
    "6k": "SIX_K",
    "7k": "SEVEN_K",
    "8k": "EIGHT_K",
    "Huge": "HUGE",
  };
  
  // Orientation string to GraphQL enum mapping
  const ORIENTATION_MAP = {
    "Landscape": "LANDSCAPE",
    "Portrait": "PORTRAIT",
    "Square": "SQUARE",
  };

  // Build SceneFilterType from URL 'c' params (or 'qfc' if loading from a scene page)
  // Transforms URL criterion format to GraphQL SceneFilterType format
  function getSceneFilter(searchParams) {
    const sceneFilter = {};
    
    if (!searchParams.has("c") && !searchParams.has("qfc")) return null;
    
    for (const cStr of searchParams.getAll("c").concat(searchParams.getAll("qfc"))) {
      try {
        // Decode URL format: () → {} (safely preserving strings)
        const decoded = translateJSON(cStr, true);
        const cObj = JSON.parse(decoded);
        
        const filterType = cObj.type;
        if (!filterType) {
          console.warn("[Stash Battle] Filter missing type:", cObj);
          continue;
        }
        
        // Remove type from the object - it becomes the key
        const { type, ...rest } = cObj;
        
        // Category: Boolean (organized, interactive, performer_favorite, filter_favorites)
        // URL: { type, value: "true" } → GraphQL: true
        if (CRITERION_CATEGORIES.boolean.has(filterType)) {
          sceneFilter[filterType] = rest.value === "true" || rest.value === true;
          continue;
        }
        
        // Category: StringEnum (sceneIsMissing, hasMarkers)
        // URL: { type, value: "enumValue" } → GraphQL: "enumValue"
        if (CRITERION_CATEGORIES.stringEnum.has(filterType)) {
          sceneFilter[filterType] = rest.value;
          continue;
        }
        
        // Category: Custom Fields
        // URL: { type: "custom_fields", value: [{field, modifier, value}] } → GraphQL: [{field, modifier, value}]
        if (filterType === "custom_fields") {
          sceneFilter[filterType] = rest.value || [];
          continue;
        }

        // Category: Multi (performers, groups, movies, galleries)
        // URL uses same {items, excluded} structure as hierarchical, but GraphQL doesn't use depth
        // URL: { type, modifier, value: { items: [{id, label}], excluded: [{id, label}] } }
        // GraphQL: { modifier, value: [ids], excludes?: [ids] }
        if (CRITERION_CATEGORIES.multi.has(filterType)) {
          const result = { modifier: rest.modifier };
          const val = rest.value || {};
          
          // Handle {items, excluded} structure (standard URL format)
          if (val.items !== undefined) {
            const items = val.items || [];
            const excluded = val.excluded || [];
            result.value = items.map(v => (typeof v === "object" && v.id) ? v.id : v);
            if (excluded.length > 0) {
              result.excludes = excluded.map(v => (typeof v === "object" && v.id) ? v.id : v);
            }
          }
          // Handle flat array format (fallback)
          else if (Array.isArray(rest.value)) {
            result.value = rest.value.map(v => (typeof v === "object" && v.id) ? v.id : v);
          }
          // IS_NULL/NOT_NULL don't use value, but GraphQL schema still requires it (empty array for multi)
          else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
            result.value = [];
          }
          // Pass through as-is (shouldn't happen, but safe fallback)
          else {
            result.value = rest.value;
          }
          
          sceneFilter[filterType] = result;
          continue;
        }
        
        // Category: HierarchicalMulti (tags, studios, performer_tags)
        // URL: { type, modifier, value: { items: [{id, label}], excluded: [{id, label}], depth } }
        // GraphQL: { modifier, value: [ids], excludes: [ids], depth }
        if (CRITERION_CATEGORIES.hierarchicalMulti.has(filterType)) {
          const val = rest.value || {};
          const items = val.items || [];
          const excluded = val.excluded || [];
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: items.map(v => (typeof v === "object" && v.id) ? v.id : v),
            excludes: excluded.map(v => (typeof v === "object" && v.id) ? v.id : v),
            depth: val.depth ?? 0
          };
          continue;
        }
        
        // Category: Resolution (needs string → enum conversion)
        // URL: { type: "resolution", modifier, value: "720p" } → GraphQL: { modifier, value: "STANDARD_HD" }
        if (filterType === "resolution") {
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: RESOLUTION_MAP[rest.value] || rest.value
          };
          continue;
        }
        
        // Category: Orientation (multi-select enum, no modifier)
        // URL: { type: "orientation", value: ["Landscape", "Portrait"] } → GraphQL: { value: ["LANDSCAPE", "PORTRAIT"] }
        if (filterType === "orientation") {
          const values = Array.isArray(rest.value) ? rest.value : [rest.value];
          sceneFilter[filterType] = {
            value: values.map(v => ORIENTATION_MAP[v] || v).filter(Boolean)
          };
          continue;
        }
        
        // Category: Duplicated (phash duplicate filter - different structure)
        // URL: { type: "duplicated", value: "true" } → GraphQL: { duplicated: true }
        if (filterType === "duplicated") {
          sceneFilter[filterType] = {
            duplicated: rest.value === "true" || rest.value === true
          };
          continue;
        }
        
        // Category: Standard (number, string, date, timestamp, duration, special)
        // Check if value needs flattening (nested { value, value2 } structure from range criteria)
        if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value) && "value" in rest.value) {
          // Flatten: { modifier, value: { value: X, value2: Y } } → { modifier, value: X, value2: Y }
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: rest.value.value,
            ...(rest.value.value2 !== undefined && { value2: rest.value.value2 })
          };
        } else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
          // IS_NULL/NOT_NULL modifiers don't use the value, but GraphQL schema still requires it
          // Provide a dummy value (0 for numbers, empty string for strings) to satisfy the schema
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: 0
          };
        } else {
          // Pass through as-is (string criteria, special criteria like phash, stash_id, etc.)
          sceneFilter[filterType] = rest;
        }
        
      } catch (e) {
        console.error("[Stash Battle] Failed to parse filter:", cStr, e);
      }
    }
    
    return Object.keys(sceneFilter).length > 0 ? sceneFilter : null;
  }

  // Fisher-Yates shuffle algorithm - creates a randomized copy of the array
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Get next scene from shuffled filtered list (prevents duplicates when skipping)
  // Reshuffles when filter changes or when all scenes have been shown
  let lastShownSceneId = null; // Track last scene to avoid immediate repeat after reshuffle
  
  function getNextFilteredScene(filteredScenes, filterKey) {
    // If filter changed, clear removed tracking BEFORE filtering
    if (shuffleFilterKey !== null && filterKey !== shuffleFilterKey) {
      console.log("[Stash Battle] 🔀 Filter changed, resetting removed scenes tracking");
      removedSceneIds.clear();
    }
    
    // Filter out scenes that were removed this session (survives background refresh race condition)
    const availableScenes = filteredScenes.filter(s => !removedSceneIds.has(s.id));
    
    // Check if pool is exhausted (all scenes rated)
    if (availableScenes.length === 0) {
      console.log("[Stash Battle] 🏁 Filtered pool exhausted - all scenes rated!");
      return null; // Signal that pool is empty
    }
    
    // Reshuffle if filter changed or first load
    if (filterKey !== shuffleFilterKey || shuffledFilteredScenes.length === 0) {
      console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
      shuffledFilteredScenes = shuffleArray(availableScenes);
      shuffleIndex = 0;
      shuffleFilterKey = filterKey;
      lastShownSceneId = null; // Reset on filter change
    }
    
    // Reshuffle if we've gone through all remaining scenes
    if (shuffleIndex >= shuffledFilteredScenes.length) {
      console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
      shuffledFilteredScenes = shuffleArray(availableScenes);
      shuffleIndex = 0;
      
      // Avoid showing the same scene that ended the previous cycle
      if (lastShownSceneId && shuffledFilteredScenes.length > 1 && 
          shuffledFilteredScenes[0].id === lastShownSceneId) {
        // Swap first scene with a random other position
        const swapIdx = 1 + Math.floor(Math.random() * (shuffledFilteredScenes.length - 1));
        [shuffledFilteredScenes[0], shuffledFilteredScenes[swapIdx]] = 
          [shuffledFilteredScenes[swapIdx], shuffledFilteredScenes[0]];
        console.log("[Stash Battle] 🔄 Swapped first scene to avoid repeat");
      }
    }
    
    const scene = shuffledFilteredScenes[shuffleIndex];
    shuffleIndex++;
    lastShownSceneId = scene.id; // Remember for next reshuffle
    console.log(`[Stash Battle] 📍 Picked scene ${scene.id} (${shuffledFilteredScenes.length - shuffleIndex} remaining in pool, ${removedSceneIds.size} removed this session)`);
    return scene;
  }

  async function fetchRandomFilteredScenesPair() {
    const count = 2;
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
 
    const { scenes } = await fetchScenes(
      getFindFilter(searchParams, {
        per_page: count,
        sort: "random"
      }),
      sceneFilter
    );
 
    if (scenes.length < count) {
      throw new Error(`Not enough filtered scenes for comparison. You need at least ${count} scenes but only found ${scenes.length}.`);
    }
 
    return scenes;
  }

  // Swiss mode: fetch two scenes with similar ratings
  // Left side (scene1): from filtered pool (scenes to be rated)
  // Right side (scene2): from full collection (opponents)
  async function fetchSwissPair() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const hasFilter = sceneFilter || searchParams.has("c") || searchParams.get("q");

    let filteredScenes, allScenes;
    
    if (hasFilter) {
      // With filter: need both filtered scenes and all scenes
      console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
      const [filteredResult, allResult] = await Promise.all([
        getFilteredScenesCached(searchParams, sceneFilter),
        getAllScenesCached()
      ]);
      filteredScenes = filteredResult.scenes || [];
      allScenes = allResult.scenes || [];
    } else {
      // No filter: all scenes = filtered scenes, only need one fetch
      console.log("[Stash Battle] 📋 No filter active, using all scenes");
      const allResult = await getAllScenesCached();
      allScenes = allResult.scenes || [];
      filteredScenes = allScenes;
    }
    
    // Need at least 2 scenes in full collection for opponents
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    // Note: filteredScenes can be empty - getNextFilteredScene will return null for poolExhausted

    // Pick next scene from shuffled filtered pool (left side - to be rated)
    let filterKey = buildFilterKey(searchParams, sceneFilter);
    let scene1 = getNextFilteredScene(filteredScenes, filterKey);
    
    // Handle pool exhaustion - auto-refresh and continue
    if (!scene1) {
      console.log("[Stash Battle] 🏁 Pool exhausted, fetching fresh from network...");
      
      // Clear filtered cache (memory + IndexedDB) to force fresh network fetch
      // This picks up newly-qualified scenes (e.g., a scene that just hit rating 100)
      await clearFilteredCache();
      shuffledFilteredScenes = [];
      shuffleIndex = 0;
      shuffleFilterKey = null;
      removedSceneIds.clear(); // Safe to clear since we're forcing a fresh network fetch
      
      // Re-fetch filtered scenes (will hit network since cache is cleared)
      if (hasFilter) {
        const freshResult = await getFilteredScenesCached(searchParams, sceneFilter);
        filteredScenes = freshResult.scenes || [];
      } else {
        // For no filter, allScenes is already fresh enough
        filteredScenes = allScenes;
      }
      
      // Try again with fresh pool (removedSceneIds will filter out already-rated scenes)
      filterKey = buildFilterKey(searchParams, sceneFilter);
      scene1 = getNextFilteredScene(filteredScenes, filterKey);
      
      // If still empty after fresh fetch, truly no scenes match (or all were already rated)
      if (!scene1) {
        throw new Error("No scenes match your filter criteria.");
      }
    }
    
    // decide which list to draw opponents from; ranking numbers come from same list
    // Right side should only show rated scenes
    const ratedOnly = allScenes.filter(s => getSceneRating(s) != null);
    const opponentPool = ratedOnly.length >= 1 ? ratedOnly : allScenes;

    totalScenesCount = opponentPool.length;

    // index of scene1 within the chosen pool
    const scene1IdxInPool = opponentPool.findIndex(s => s.id === scene1.id);
    // If scene1 not in opponent pool (unrated), position where DEFAULT_RATING (1200) would sit
    let effectiveScene1Idx = scene1IdxInPool;
    if (effectiveScene1Idx === -1) {
      effectiveScene1Idx = opponentPool.findIndex(s => (getSceneRating(s) || DEFAULT_RATING) < DEFAULT_RATING);
      if (effectiveScene1Idx === -1) {
        effectiveScene1Idx = opponentPool.length;
      }
    }
    const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;

    // Collect candidates near scene1 in opponentPool, expanding reach if needed
    let candidates = [];
    for (let reach = 10; candidates.length === 0 && reach <= opponentPool.length; reach *= 2) {
      for (let i = effectiveScene1Idx - reach; i <= effectiveScene1Idx + reach; i++) {
        if (i >= 0 && i < opponentPool.length && i !== scene1IdxInPool) {
          candidates.push({ scene: opponentPool[i], idx: i });
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }

    // Pick randomly from candidates
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const scene2 = pick.scene;
    const scene2Index = pick.idx;

    return {
      scenes: [scene1, scene2],
      ranks: [scene1RankInPool, scene2Index + 1]
    };
  }

  // Find the lowest actually rated scene in a descending-sorted array, excluding a specific scene
  // Returns { scene, index } or fallback to first non-excluded scene if none rated
  function findLowestRated(scenes, excludeId) {
    for (let i = scenes.length - 1; i >= 0; i--) {
      const s = scenes[i];
      if (s.id !== excludeId && getSceneRating(s) != null) {
        return { scene: s, index: i };
      }
    }
    // Fallback to any scene if none rated
    const fallbackIndex = scenes.findIndex(s => s.id !== excludeId);
    return { scene: scenes[fallbackIndex], index: fallbackIndex };
  }

  // Gauntlet mode: champion vs next challenger using Binary Search
  // Left side (champion): initially picked from filtered pool (scenes/performers to be rated)
  // Right side (opponents): from full collection
  async function fetchGauntletPair() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const hasFilter = sceneFilter || searchParams.has("c") || searchParams.get("q");

    // Get ALL items for opponent pool and ranking - CACHED
    console.log("[Stash Battle] 📋 Fetching all items for gauntlet...");
    const allResult = await getAllScenesCached();
    const allScenes = allResult.scenes || [];

    // Use the current page scene/performer as champion if we opened from an individual item page
    const activeOpenId = openedFromSceneId || openedFromPerformerId;
    if (activeOpenId) {
      const currentItem = allScenes.find(s => String(s.id) === String(activeOpenId));
      if (currentItem) {
        if (!gauntletChampion || String(gauntletChampion.id) !== String(activeOpenId)) {
          console.log(`[Stash Battle] 🎯 Initializing gauntlet champion to current page item: ${currentItem.id}`);
          resetGauntletState();
          gauntletChampion = currentItem;
        }
      }
      openedFromSceneId = null;
      openedFromPerformerId = null;
    }

    // compute filtered list once (used for left side and, optionally, for opponents)
    let filteredScenes = hasFilter
      ? (await getFilteredScenesCached(searchParams, sceneFilter)).scenes || []
      : allScenes;

    // choose pool for opponents / ranking; right side should only show rated scenes
    const ratedOnly = allScenes.filter(s => getRating(s) != null);
    const opponentPool = ratedOnly.length >= 1 ? ratedOnly : allScenes;
    totalScenesCount = opponentPool.length;

    if (allScenes.length < 2) {
      return { scenes: await fetchRandomFilteredScenesPair(), ranks: [null, null], isVictory: false, isFalling: false };
    }

    // If no champion yet, pick from filtered pool to start
    if (!gauntletChampion) {
      if (filteredScenes.length < 1) {
        throw new Error(`No ${battleTarget} match your filter criteria.`);
      }
      
      // Pick next scene from shuffled filtered pool as challenger (left side - to be rated)
      const filterKey = buildFilterKey(searchParams, sceneFilter);
      const challenger = getNextFilteredScene(filteredScenes, filterKey);
      
      if (!challenger) {
        throw new Error(`No ${battleTarget} match your filter criteria.`);
      }

      gauntletChampion = challenger;
      gauntletDefeated = [];
      gauntletFalling = false;
      gauntletFallingScene = null;
      gauntletLow = -1;
      gauntletHigh = -1;
    }

    // Build search pool by filtering out the challenger
    const searchPool = opponentPool.filter(s => s.id !== gauntletChampion.id);
    
    // Find challenger's original 0-based index in opponentPool before starting search bounds
    const startIndex = opponentPool.findIndex(s => s.id === gauntletChampion.id);

    // Initialize search bounds if needed
    if (gauntletLow === -1 || gauntletHigh === -1) {
      gauntletLow = 0;
      gauntletHigh = searchPool.length;
    }

    console.log(`[Stash Battle] 🔍 Gauntlet Binary Search: low=${gauntletLow}, high=${gauntletHigh}, searchPoolSize=${searchPool.length}, challengerOriginalIndex=${startIndex}`);

    // Check for immediate placement or convergence
    if (gauntletLow >= gauntletHigh) {
      const targetIndex = gauntletLow;
      const placementRank = targetIndex + 1;
      let placementRating;

      if (startIndex !== -1 && targetIndex === startIndex) {
        // Original rank is unchanged! Preserve original rating.
        placementRating = getRating(gauntletChampion) || DEFAULT_RATING;
        console.log(`[Stash Battle] 🎯 Gauntlet placement converged to starting index (${startIndex}). Preserving original rating: ${placementRating}`);
      } else {
        if (targetIndex === 0) {
          if (searchPool.length > 0) {
            placementRating = (getRating(searchPool[0]) || DEFAULT_RATING) + 1;
          } else {
            placementRating = DEFAULT_RATING;
          }
        } else if (targetIndex === searchPool.length) {
          if (searchPool.length > 0) {
            placementRating = Math.max(RATING_FLOOR, (getRating(searchPool[searchPool.length - 1]) || DEFAULT_RATING) - 1);
          } else {
            placementRating = RATING_FLOOR;
          }
        } else {
          const aboveOpponent = searchPool[targetIndex - 1];
          const belowOpponent = searchPool[targetIndex];
          const aboveRating = getRating(aboveOpponent) || DEFAULT_RATING;
          const belowRating = getRating(belowOpponent) || DEFAULT_RATING;
          placementRating = Math.round((aboveRating + belowRating) / 2);
        }
        console.log(`[Stash Battle] 🎯 Gauntlet placement converged to new index ${targetIndex}. Calculated interpolated rating: ${placementRating}`);
      }

      // Increment challenger's battle count by 1 upon successful placement
      const newCount = getBattleCount(gauntletChampion) + 1;
      
      // Update database and local caches
      await updateSceneRatingAndCount(gauntletChampion.id, placementRating, newCount);

      return {
        scenes: [gauntletChampion],
        ranks: [placementRank],
        isVictory: false,
        isFalling: false,
        isPlacement: true,
        placementRank: placementRank,
        placementRating: placementRating
      };
    }

    // Pick midpoint with up to 10% range jitter
    const rangeSize = gauntletHigh - gauntletLow;
    const maxWiggle = Math.floor(rangeSize * 0.1);
    let offset = 0;
    if (maxWiggle > 0) {
      offset = Math.floor(Math.random() * (2 * maxWiggle + 1)) - maxWiggle;
    }
    let mid = Math.floor((gauntletLow + gauntletHigh) / 2) + offset;
    mid = Math.max(gauntletLow, Math.min(gauntletHigh - 1, mid));

    const opponent = searchPool[mid];

    // Find the opponent's 1-based rank in the main opponentPool
    const opponentIndexInPool = opponentPool.findIndex(s => s.id === opponent.id);
    const opponentRank = opponentIndexInPool !== -1 ? opponentIndexInPool + 1 : mid + 1;

    // The left side card rank badge will display the active search boundary
    const visualLeftRank = `${gauntletLow + 1}-${gauntletHigh + 1}`;

    return {
      scenes: [gauntletChampion, opponent],
      ranks: [visualLeftRank, opponentRank],
      isVictory: false,
      isFalling: false
    };
  }

  // Champion mode: like gauntlet but winner stays on (no falling)
  // Left side (champion): initially picked from filtered pool (scenes to be rated)
  // Right side (opponents): from full collection
  async function fetchChampionPair() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const hasFilter = sceneFilter || searchParams.has("c") || searchParams.get("q");

    // Get ALL scenes/performers for opponent pool and ranking - CACHED
    console.log("[Stash Battle] 📋 Fetching all items for champion...");
    const allResult = await getAllScenesCached();
    const allScenes = allResult.scenes || [];

    // Use the current page scene/performer as champion if we opened from an individual page
    const activeOpenId = openedFromSceneId || openedFromPerformerId;
    if (activeOpenId) {
      const currentScene = allScenes.find(s => String(s.id) === String(activeOpenId));
      if (currentScene) {
        if (!gauntletChampion || String(gauntletChampion.id) !== String(activeOpenId)) {
          console.log(`[Stash Battle] 🎯 Initializing champion LHS to current page item: ${currentScene.id}`);
          resetGauntletState();
          gauntletChampion = currentScene;
        }
      }
      openedFromSceneId = null; // Clear so subsequent loading doesn't force it
      openedFromPerformerId = null;
    }

    // precompute filtered list and opponent/rank pools
    let filteredScenes = hasFilter
      ? (await getFilteredScenesCached(searchParams, sceneFilter)).scenes || []
      : allScenes;
      
    // Right side should only show rated scenes
    const ratedOnly = allScenes.filter(s => getRating(s) != null);
    const opponentPool = ratedOnly.length >= 1 ? ratedOnly : allScenes;
    totalScenesCount = opponentPool.length;
    
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }

    // 1. Choose LHS (scene1):
    // "chosen to be the last winner (if any; if not it should be the entity for the page we're on, if not it should be random)"
    let scene1 = null;

    if (gauntletChampion) {
      scene1 = allScenes.find(s => s.id === gauntletChampion.id);
    }

    // If still no LHS (e.g. not opened from a page & no winner yet), pick random from filtered pool's lowest quartile
    if (!scene1) {
      if (filteredScenes.length > 0) {
        // Sort copy of filteredScenes descending by rating to ensure lowest quartile is at the end
        const sortedFiltered = [...filteredScenes].sort((a, b) => {
          const rA = getRating(a);
          const rB = getRating(b);
          if (rA === null && rB === null) return 0;
          if (rA === null) return 1;
          if (rB === null) return -1;
          return rB - rA;
        });
        const startIdx = Math.floor(sortedFiltered.length * 0.75);
        const count = sortedFiltered.length - startIdx;
        scene1 = sortedFiltered[startIdx + Math.floor(Math.random() * count)];
        console.log(`[Stash Battle] 🎯 No LHS champion/page entity. Picked random LHS from lowest quartile: ${scene1.id} (rating: ${getRating(scene1)})`);
        resetGauntletState();
        gauntletChampion = scene1;
      } else {
        throw new Error("No scenes match your filter criteria.");
      }
    }

    if (!scene1) {
      throw new Error("Could not select a left-hand side item.");
    }

    // 2. Choose RHS (scene2) using Swiss logic:
    // Index of scene1 within the chosen pool
    const scene1IdxInPool = opponentPool.findIndex(s => s.id === scene1.id);
    
    // If scene1 not in opponent pool (unrated), position where DEFAULT_RATING (1200) would sit
    let effectiveScene1Idx = scene1IdxInPool;
    if (effectiveScene1Idx === -1) {
      effectiveScene1Idx = opponentPool.findIndex(s => (getRating(s) || DEFAULT_RATING) < DEFAULT_RATING);
      if (effectiveScene1Idx === -1) {
        effectiveScene1Idx = opponentPool.length;
      }
    }
    const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;

    // 1. Once a scene lands at #1 rank, we should consider the championship round completed!
    if (scene1RankInPool === 1) {
      console.log(`[Stash Battle] 👑 Champion LHS reached Rank #1! Victory screen triggered.`);
      return {
        scenes: [scene1],
        ranks: [1],
        isVictory: true
      };
    }

    // 2. Choose RHS (scene2) using Swiss logic (equal or greater rating only):
    // Collect candidates near scene1 in opponentPool, expanding reach if needed
    let candidates = [];
    for (let reach = 10; candidates.length === 0 && reach <= opponentPool.length; reach *= 2) {
      for (let i = effectiveScene1Idx - reach; i < effectiveScene1Idx; i++) {
        if (i >= 0 && i < opponentPool.length && i !== scene1IdxInPool) {
          candidates.push({ scene: opponentPool[i], idx: i });
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }

    // Pick randomly from candidates
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const scene2 = pick.scene;
    const scene2Index = pick.idx;

    return {
      scenes: [scene1, scene2],
      ranks: [scene1RankInPool, scene2Index + 1],
      isVictory: false
    };
  }
  
  function createVictoryScreen(champion) {
    const isPerformer = battleTarget === "performers";
    const itemNoun = isPerformer ? "performers" : "scenes";
    
    let title = "";
    let imageHtml = "";
    
    if (isPerformer) {
      title = champion.name || "";
      if (champion.disambiguation) {
        title += ` (${champion.disambiguation})`;
      }
      if (!title) {
        title = `Performer #${champion.id}`;
      }
      
      const imagePath = champion.image_path || null;
      if (imagePath) {
        imageHtml = `<img class="pwr-victory-image pwr-performer-image" src="${imagePath}" alt="${title}" />`;
      } else if (champion.images && champion.images.length > 0) {
        const firstImg = champion.images[0].paths.image || champion.images[0].paths.thumbnail;
        imageHtml = `<img class="pwr-victory-image pwr-performer-image" src="${firstImg}" alt="${title}" />`;
      } else {
        imageHtml = `<div class="pwr-victory-image pwr-performer-image pwr-no-image">No Image</div>`;
      }
    } else {
      const file = champion.files && champion.files[0] ? champion.files[0] : {};
      title = champion.title;
      if (!title && file.path) {
        const pathParts = file.path.split(/[/\\]/);
        title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
      }
      if (!title) {
        title = `Scene #${champion.id}`;
      }
      
      const screenshotPath = champion.paths ? champion.paths.screenshot : null;
      imageHtml = screenshotPath 
        ? `<img class="pwr-victory-image" src="${screenshotPath}" alt="${title}" />`
        : `<div class="pwr-victory-image pwr-no-image">No Screenshot</div>`;
    }
    
    return `
      <div class="pwr-victory-screen">
        <div class="pwr-victory-crown">👑</div>
        <h2 class="pwr-victory-title">CHAMPION!</h2>
        <div class="pwr-victory-scene">
          ${imageHtml}
        </div>
        <h3 class="pwr-victory-name">${title}</h3>
        <p class="pwr-victory-stats">Conquered all ${totalScenesCount} ${itemNoun} with a ${gauntletWins} win streak!</p>
        <button id="pwr-new-gauntlet" class="btn btn-primary">Start New Gauntlet</button>
      </div>
    `;
  }

  function showPlacementScreen(scene, rank, finalRating) {
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;
    
    const isPerformer = battleTarget === "performers";
    
    let title = "";
    let imageHtml = "";
    
    if (isPerformer) {
      title = scene.name || "";
      if (scene.disambiguation) {
        title += ` (${scene.disambiguation})`;
      }
      if (!title) {
        title = `Performer #${scene.id}`;
      }
      
      const imagePath = scene.image_path || null;
      if (imagePath) {
        imageHtml = `<img class="pwr-victory-image pwr-performer-image" src="${imagePath}" alt="${title}" />`;
      } else if (scene.images && scene.images.length > 0) {
        const firstImg = scene.images[0].paths.image || scene.images[0].paths.thumbnail;
        imageHtml = `<img class="pwr-victory-image pwr-performer-image" src="${firstImg}" alt="${title}" />`;
      } else {
        imageHtml = `<div class="pwr-victory-image pwr-performer-image pwr-no-image">No Image</div>`;
      }
    } else {
      const file = scene.files && scene.files[0] ? scene.files[0] : {};
      title = scene.title;
      if (!title && file.path) {
        const pathParts = file.path.split(/[/\\]/);
        title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
      }
      if (!title) {
        title = `Scene #${scene.id}`;
      }
      
      const screenshotPath = scene.paths ? scene.paths.screenshot : null;
      imageHtml = screenshotPath 
        ? `<img class="pwr-victory-image" src="${screenshotPath}" alt="${title}" />`
        : `<div class="pwr-victory-image pwr-no-image">No Screenshot</div>`;
    }
    
    comparisonArea.innerHTML = `
      <div class="pwr-victory-screen">
        <div class="pwr-victory-crown">📍</div>
        <h2 class="pwr-victory-title">PLACED!</h2>
        <div class="pwr-victory-scene">
          ${imageHtml}
        </div>
        <h3 class="pwr-victory-name">${title}</h3>
        <p class="pwr-victory-stats">
          Rank <strong>#${rank}</strong> of ${totalScenesCount}<br>
          Rating: <strong>${finalRating}</strong>
        </p>
        <button id="pwr-new-gauntlet" class="btn btn-primary">Start New Run</button>
      </div>
    `;
    
    // Hide status and actions
    const statusEl = document.getElementById("pwr-gauntlet-status");
    const actionsEl = document.querySelector(".pwr-actions");
    if (statusEl) statusEl.style.display = "none";
    if (actionsEl) actionsEl.style.display = "none";
    
    resetGauntletState();
    saveState();
    
    // Attach button handler
    const newBtn = comparisonArea.querySelector("#pwr-new-gauntlet");
    if (newBtn) {
      newBtn.addEventListener("click", () => {
        if (actionsEl) actionsEl.style.display = "";
        loadNewPair();
      });
    }
  }
  
  // Update scene/performer rating and battle count in Stash database
  async function updateItemRatingAndCount(itemId, rating, battleCount = null) {
    const finalRating = Math.max(RATING_FLOOR, rating);
    const partialFields = {
      [RATING_CUSTOM_FIELD_KEY]: finalRating
    };
    if (battleCount !== null) {
      partialFields[BATTLE_COUNT_CUSTOM_FIELD_KEY] = battleCount;
    }

    let mutation;
    let variables;
    if (battleTarget === "scenes") {
      mutation = `
        mutation SceneUpdate($input: SceneUpdateInput!) {
          sceneUpdate(input: $input) {
            id
            custom_fields
          }
        }
      `;
      variables = {
        input: {
          id: itemId,
          custom_fields: {
            partial: partialFields
          }
        }
      };
    } else {
      mutation = `
        mutation PerformerUpdate($input: PerformerUpdateInput!) {
          performerUpdate(input: $input) {
            id
            custom_fields
          }
        }
      `;
      variables = {
        input: {
          id: itemId,
          custom_fields: {
            partial: partialFields
          }
        }
      };
    }

    try {
      await graphqlQuery(mutation, variables);
      console.log(`[Stash Battle] 📝 Updated ${battleTarget.slice(0, -1)} ${itemId} custom fields: rating=${finalRating}, battleCount=${battleCount}`);
      
      updateItemInCaches(itemId, finalRating, battleCount);
      
    } catch (e) {
      console.error(`[Stash Battle] Failed to update ${battleTarget.slice(0, -1)} ${itemId} custom fields:`, e);
    }
  }

  // Legacy updateSceneRatingAndCount alias for backwards compatibility
  async function updateSceneRatingAndCount(sceneId, rating, battleCount = null) {
    return updateItemRatingAndCount(sceneId, rating, battleCount);
  }

  // Remove a scene from the filtered pool (called after battle regardless of rating change)
  function removeFromFilteredPool(sceneId) {
    // Track removal - survives background refresh race condition
    removedSceneIds.add(sceneId);
    
    // Remove from filtered cache
    if (memoryCache.filteredScenes) {
      const idx = memoryCache.filteredScenes.findIndex(s => s.id === sceneId);
      if (idx !== -1) {
        memoryCache.filteredScenes.splice(idx, 1);
        console.log(`[Stash Battle] 🗑️ Removed scene ${sceneId} from filtered pool (${memoryCache.filteredScenes.length} remaining, ${removedSceneIds.size} removed this session)`);
      }
    }
    
    // Also remove from shuffled queue
    const shuffleIdx = shuffledFilteredScenes.findIndex(s => s.id === sceneId);
    if (shuffleIdx !== -1) {
      shuffledFilteredScenes.splice(shuffleIdx, 1);
      if (shuffleIdx < shuffleIndex) {
        shuffleIndex--;
      }
    }
  }

  // ============================================
  // RATING LOGIC
  // ============================================

  // Dynamic K-factor based on battle count (similar to chess ELO for new vs established players)
  // Scenes with more battle history have more "established" ratings and change more slowly
  function getKFactor(battleCount) {
    const count = battleCount || 0;   // Handle null/undefined
    if (count < 8) return 48;        // New: highly volatile provisional phase
    if (count < 16) return 32;       // Provisional/newly established
    if (count < 31) return 24;       // Moderate history
    return 16;                       // Very established: stable rating
  }

  function handleComparison(winnerId, loserId, winnerCurrentRating, loserCurrentRating, winnerBattleCount = 0, loserBattleCount = 0, loserRank = null) {
    const winnerRating = winnerCurrentRating || DEFAULT_RATING;
    const loserRating = loserCurrentRating || DEFAULT_RATING;
    
    let winnerGain = 0;
    let loserLoss = 0;
    
    console.log(`[Stash Battle] 📊 Chess ELO Input: mode=${currentMode} winner=${winnerId}(rating=${winnerCurrentRating || 'Unrated'}, ELO=${winnerRating}, battleCount=${winnerBattleCount}) loser=${loserId}(rating=${loserCurrentRating || 'Unrated'}, ELO=${loserRating}, battleCount=${loserBattleCount})`);
    
    // Standard ELO formula for Winner
    const ratingDiffWinner = loserRating - winnerRating;
    const expectedWinner = 1 / (1 + Math.pow(10, ratingDiffWinner / 400));
    const winnerK = getKFactor(winnerBattleCount);
    winnerGain = Math.round(winnerK * (1 - expectedWinner));
    if (winnerGain < 1) winnerGain = 1;
    console.log(`[Stash Battle] 📊 Winner ELO: battleCount=${winnerBattleCount} ELO=${winnerRating} expectedWinner=${expectedWinner.toFixed(4)} K=${winnerK} winnerGain=${winnerGain}`);
    
    // Standard ELO formula for Loser
    const ratingDiffLoser = winnerRating - loserRating;
    const expectedLoser = 1 / (1 + Math.pow(10, ratingDiffLoser / 400));
    const loserK = getKFactor(loserBattleCount);
    loserLoss = Math.round(loserK * expectedLoser);
    if (loserLoss < 1) loserLoss = 1;
    console.log(`[Stash Battle] 📊 Loser ELO: battleCount=${loserBattleCount} ELO=${loserRating} expectedLoser=${expectedLoser.toFixed(4)} K=${loserK} loserLoss=${loserLoss}`);
    
    // Special modifications for other modes (Gauntlet specific logic)
    if (currentMode === "gauntlet") {
      const isChampionWinner = gauntletChampion && winnerId === gauntletChampion.id;
      const isFallingWinner = gauntletFalling && gauntletFallingScene && winnerId === gauntletFallingScene.id;
      const isChampionLoser = gauntletChampion && loserId === gauntletChampion.id;
      const isFallingLoser = gauntletFalling && gauntletFallingScene && loserId === gauntletFallingScene.id;
      
      console.log(`[Stash Battle] 📊 Gauntlet/Champion Roles: isChampionWinner=${isChampionWinner} isFallingWinner=${isFallingWinner} isChampionLoser=${isChampionLoser} isFallingLoser=${isFallingLoser}`);
      
      if (!isChampionWinner && !isFallingWinner) {
        winnerGain = 0;
      }
      if (!isFallingLoser) {
        loserLoss = 0;
      }
      if (loserRank === 1 && !isChampionLoser && !isFallingLoser) {
        loserLoss = 1;
      }
    } else if (currentMode === "champion") {
      const winnerRank = currentPair.left && winnerId === currentPair.left.id ? currentRanks.left : currentRanks.right;
      if (winnerRank === 1) {
        console.log(`[Stash Battle] 👑 #1 scene won in champion mode. Skipping ELO points change to prevent infinite rise.`);
        winnerGain = 0;
        loserLoss = 0;
      }
    }
    
    const newWinnerRating = Math.max(RATING_FLOOR, winnerRating + winnerGain);
    const newLoserRating = Math.max(RATING_FLOOR, loserRating - loserLoss);
    
    const winnerChange = newWinnerRating - winnerRating;
    const loserChange = newLoserRating - loserRating;
    
    console.log(`[Stash Battle] 📊 ELO Result: winner ${winnerRating}→${newWinnerRating} (${winnerChange >= 0 ? '+' : ''}${winnerChange}) loser ${loserRating}→${newLoserRating} (${loserChange >= 0 ? '+' : ''}${loserChange})`);

    // Increment battle count ONLY if the rating actually updated!
    const newWinnerCount = winnerChange !== 0 ? winnerBattleCount + 1 : null;
    const newLoserCount = loserChange !== 0 ? loserBattleCount + 1 : null;

    // Update local memory caches synchronously so the UI ranks update instantly
    updateItemInCaches(winnerId, newWinnerRating, newWinnerCount);
    updateItemInCaches(loserId, newLoserRating, newLoserCount);

    if (winnerChange !== 0) {
      updateSceneRatingAndCount(winnerId, newWinnerRating, newWinnerCount);
    }
    if (loserChange !== 0) {
      updateSceneRatingAndCount(loserId, newLoserRating, newLoserCount);
    }
    
    return { newWinnerRating, newLoserRating, winnerChange, loserChange };
  }
  
  // Called when gauntlet champion loses - place them one below the winner
  function finalizeGauntletLoss(championId, winnerRating, battleCount = null) {
    // Set champion rating to just below the scene that beat them
    const newRating = Math.max(RATING_FLOOR, winnerRating - 1);
    updateSceneRatingAndCount(championId, newRating, battleCount);
    return newRating;
  }

  // ============================================
  // UI COMPONENTS
  // ============================================

  function formatDuration(seconds) {
    if (!seconds) return "N/A";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function createSceneCard(scene, side, rank = null, streak = null) {
    const file = scene.files && scene.files[0] ? scene.files[0] : {};
    const duration = file.duration;
    const performers = scene.performers && scene.performers.length > 0 
      ? scene.performers.map((p) => p.name).join(", ") 
      : "No performers";
    const studio = scene.studio ? scene.studio.name : "No studio";
    const tags = scene.tags ? scene.tags.slice(0, 40).map((t) => t.name) : [];
    
    // Title fallback: title -> filename from path -> Scene ID
    let title = scene.title;
    if (!title && file.path) {
      const pathParts = file.path.split(/[/\\]/);
      title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }
    if (!title) {
      title = `Scene #${scene.id}`;
    }
    
    const screenshotPath = scene.paths ? scene.paths.screenshot : null;
    const previewPath = scene.paths ? scene.paths.preview : null;
    const rating = getRating(scene);
    const count = getBattleCount(scene);
    let renderedBattleRating;
    if (rating === null || count === 0) {
      renderedBattleRating = "Unrated";
    } else if (count < 8) {
      renderedBattleRating = `${rating}?`;
    } else {
      renderedBattleRating = `${rating}`;
    }
    
    // Star rating formatted from rating100
    const rating100 = scene.rating100;
    const starRating = rating100 !== null && rating100 !== undefined
      ? `${(rating100 / 20).toFixed(1)} ⭐`
      : "Unrated";
    
    // Handle numeric ranks and string ranks
    let rankDisplay = '';
    if (rank !== null && rank !== undefined) {
      if (typeof rank === 'number') {
        rankDisplay = `<span class="pwr-scene-rank">#${rank} / ${totalScenesCount}</span>`;
      } else {
        rankDisplay = `<span class="pwr-scene-rank">${rank} / ${totalScenesCount}</span>`;
      }
    }
    
    // Status badge (streak or falling)
    let streakDisplay = '';
    if (typeof streak === 'string') {
      streakDisplay = `<div class="pwr-streak-badge">${streak}</div>`;
    } else if (streak !== null && streak > 0) {
      streakDisplay = `<div class="pwr-streak-badge">🔥 ${streak} win${streak > 1 ? 's' : ''}</div>`;
    }

    // Preserve URL search params when opening scene
    const currentParams = window.location.search;
    const sceneUrl = `/scenes/${scene.id}${currentParams}`;

    return `
      <div class="pwr-scene-card" data-side="${side}">
        <div class="pwr-scene-image-container" data-scene-url="${sceneUrl}">
          ${screenshotPath 
            ? `<img class="pwr-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />`
            : `<div class="pwr-scene-image pwr-no-image">No Screenshot</div>`
          }
          ${previewPath ? `<video class="pwr-hover-preview" src="${previewPath}" loop playsinline></video>` : ''}
          <div class="pwr-scene-duration">${formatDuration(duration)}</div>
          ${streakDisplay}
          <div class="pwr-click-hint">Click to open scene</div>
        </div>
        
        <div class="pwr-scene-body" data-winner="${scene.id}">
          <div class="pwr-scene-info">
            <div class="pwr-scene-title-row">
              <h3 class="pwr-scene-title">${title}</h3>
              ${rankDisplay}
            </div>
            
            <div class="pwr-scene-meta">
              <div class="pwr-meta-item"><strong>Studio:</strong> ${studio}</div>
              <div class="pwr-meta-item"><strong>Battle Rating:</strong> ${renderedBattleRating}</div>
              <div class="pwr-meta-item"><strong>Performers:</strong> ${performers}</div>
              <div class="pwr-meta-item"><strong>Star Rating:</strong> ${starRating}</div>
              <div class="pwr-meta-item"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="pwr-meta-item"><strong>Total View Duration:</strong> ${formatDuration(scene.play_duration)}</div>
              <div class="pwr-meta-item"><strong>Battle Count:</strong> ${count}</div>
              <div class="pwr-meta-item"><strong>O Count:</strong> ${scene.o_counter || 0}</div>
              <div class="pwr-meta-item pwr-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="pwr-tag">${tag}</span>`).join("") : '<span class="pwr-none">None</span>'}</div>
            </div>
          </div>
          
          <div class="pwr-choose-btn">
            ✓ Choose This Scene
          </div>
        </div>
      </div>
    `;
  }

  function createPerformerCard(performer, side, rank = null, streak = null) {
    const tags = performer.tags ? performer.tags.slice(0, 40).map((t) => t.name) : [];
    
    let title = performer.name;
    if (performer.disambiguation) {
      title += ` (${performer.disambiguation})`;
    }
    
    const imagePath = performer.image_path || null;
    const rating = getRating(performer);
    const count = getBattleCount(performer);
    let renderedBattleRating;
    if (rating === null || count === 0) {
      renderedBattleRating = "Unrated";
    } else if (count < 8) {
      renderedBattleRating = `${rating}?`;
    } else {
      renderedBattleRating = `${rating}`;
    }
    
    const rating100 = performer.rating100;
    const starRating = rating100 !== null && rating100 !== undefined
      ? `${(rating100 / 20).toFixed(1)} ⭐`
      : "Unrated";
    
    let rankDisplay = '';
    if (rank !== null && rank !== undefined) {
      if (typeof rank === 'number') {
        rankDisplay = `<span class="pwr-scene-rank">#${rank} / ${totalScenesCount}</span>`;
      } else {
        rankDisplay = `<span class="pwr-scene-rank">${rank} / ${totalScenesCount}</span>`;
      }
    }
    
    let streakDisplay = '';
    if (typeof streak === 'string') {
      streakDisplay = `<div class="pwr-streak-badge">${streak}</div>`;
    } else if (streak !== null && streak > 0) {
      streakDisplay = `<div class="pwr-streak-badge">🔥 ${streak} win${streak > 1 ? 's' : ''}</div>`;
    }

    const currentParams = window.location.search;
    const performerUrl = `/performers/${performer.id}${currentParams}`;

    let imageHtml = "";
    if (imagePath) {
      imageHtml = `<img class="pwr-scene-image pwr-performer-image" src="${imagePath}" alt="${title}" loading="lazy" data-default-src="${imagePath}" />`;
    } else if (performer.images && performer.images.length > 0) {
      const firstImg = performer.images[0].paths.image || performer.images[0].paths.thumbnail;
      imageHtml = `<img class="pwr-scene-image pwr-performer-image" src="${firstImg}" alt="${title}" loading="lazy" data-default-src="${firstImg}" />`;
    } else {
      imageHtml = `<div class="pwr-scene-image pwr-performer-image pwr-no-image" data-default-src="">No Image</div>`;
    }

    let galleryHtml = "";
    if (performer.images && performer.images.length > 0) {
      galleryHtml = `
        <div class="pwr-gallery-thumbs-container">
          <div class="pwr-gallery-thumbs">
            ${performer.images.map((img) => {
              const hoverSrc = img.paths.image || img.paths.thumbnail;
              const thumbSrc = img.paths.thumbnail || img.paths.image;
              return `
                <div class="pwr-gallery-thumb" data-src="${hoverSrc}">
                  <img src="${thumbSrc}" alt="Thumb" loading="lazy" />
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }

    return `
      <div class="pwr-scene-card pwr-performer-card" data-side="${side}">
        <div class="pwr-scene-image-container" data-scene-url="${performerUrl}">
          ${imageHtml}
          ${streakDisplay}
          <div class="pwr-click-hint">Click to open performer</div>
          ${galleryHtml}
        </div>
        
        <div class="pwr-scene-body" data-winner="${performer.id}">
          <div class="pwr-scene-info">
            <div class="pwr-scene-title-row">
              <h3 class="pwr-scene-title">${title}</h3>
              ${rankDisplay}
            </div>
            
            <div class="pwr-scene-meta">
              <div class="pwr-meta-item"><strong>Battle Rating:</strong> ${renderedBattleRating}</div>
              <div class="pwr-meta-item"><strong>Star Rating:</strong> ${starRating}</div>
              <div class="pwr-meta-item"><strong>Scene Count:</strong> ${performer.scene_count || 0}</div>
              <div class="pwr-meta-item"><strong>Battle Count:</strong> ${count}</div>
              <div class="pwr-meta-item"><strong>O Count:</strong> ${performer.o_counter || 0}</div>
              <div class="pwr-meta-item pwr-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="pwr-tag">${tag}</span>`).join("") : '<span class="pwr-none">None</span>'}</div>
            </div>
          </div>
          
          <div class="pwr-choose-btn">
            ✓ Choose This Performer
          </div>
        </div>
      </div>
    `;
  }

  function createMainUI() {
    const isPerformer = battleTarget === "performers";
    const itemNoun = isPerformer ? "performers" : "scenes";
    const itemNounSingular = isPerformer ? "performer" : "scene";
    
    // Hide sync button for performers
    const syncButtonHtml = isPerformer ? "" : `<button id="pwr-sync-rankings-main-btn" class="btn btn-secondary" title="Sync ELO rankings to Stash Group">🔄 Sync Rankings</button>`;

    const leaderboardLinkHtml = isPerformer
      ? `<div class="pwr-leaderboard-link-container" style="margin-top: 8px;">
          <button id="pwr-leaderboard-modal-btn" class="btn btn-link text-info p-0 font-weight-bold" style="text-decoration: none; font-size: 0.95rem;">
            🏆 View Performer Leaderboard
          </button>
         </div>`
      : "";

    return `
      <div id="stash-battle-container" class="pwr-container ${isPerformer ? 'pwr-performers-mode' : ''}">
        <div class="pwr-header">
          <h1 class="pwr-title">⚔️ Stash Battle</h1>
          <p class="pwr-subtitle">Compare ${itemNoun} head-to-head to build your rankings</p>
          ${leaderboardLinkHtml}
          
          <div class="pwr-mode-toggle">
            <button class="pwr-mode-btn ${currentMode === 'swiss' ? 'active' : ''}" data-mode="swiss">
              <span class="pwr-mode-icon">⚖️</span>
              <span class="pwr-mode-title">Swiss</span>
              <span class="pwr-mode-desc">Fair matchups</span>
            </button>
            <button class="pwr-mode-btn ${currentMode === 'gauntlet' ? 'active' : ''}" data-mode="gauntlet">
              <span class="pwr-mode-icon">🎯</span>
              <span class="pwr-mode-title">Gauntlet</span>
              <span class="pwr-mode-desc">Place a ${itemNounSingular}</span>
            </button>
            <button class="pwr-mode-btn ${currentMode === 'champion' ? 'active' : ''}" data-mode="champion">
              <span class="pwr-mode-icon">🏆</span>
              <span class="pwr-mode-title">Champion</span>
              <span class="pwr-mode-desc">Winner stays on</span>
            </button>
          </div>
        </div>

        <div class="pwr-content">
          <div id="pwr-comparison-area" class="pwr-comparison-area">
            <div class="pwr-loading">Loading ${itemNoun}...</div>
          </div>
          <div class="pwr-actions">
            <div class="pwr-action-buttons">
              <button id="pwr-skip-btn" class="btn btn-secondary">Skip (Get New Pair)</button>
              <button id="pwr-refresh-cache-btn" class="btn btn-secondary" title="Refresh ${itemNounSingular} list from server (use if you've added new ${itemNoun})">🔄 Refresh Cache</button>
              ${syncButtonHtml}
              <button id="pwr-config-btn" class="btn btn-secondary" title="Stash Battle Configurations">⚙️ Config</button>
            </div>
            <div class="pwr-keyboard-hint">
              <span>← Left Arrow</span> to choose left · 
              <span>→ Right Arrow</span> to choose right · 
              <span>Space</span> to skip
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ============================================
  // EVENT HANDLERS
  // ============================================

  // Shared rendering logic for displaying a pair of scenes
  function renderPair(scenes, ranks) {
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;

    // Determine badge for each card (gauntlet and champion modes)
    let leftStreak = null;
    let rightStreak = null;
    if (currentMode === "gauntlet") {
      if (gauntletChampion) {
        if (scenes[0].id === gauntletChampion.id) {
          leftStreak = "📍 Finding placement...";
        } else if (scenes[1].id === gauntletChampion.id) {
          rightStreak = "📍 Finding placement...";
        }
      }
    } else if (currentMode === "champion") {
      if (gauntletChampion) {
        if (scenes[0].id === gauntletChampion.id) {
          leftStreak = gauntletWins;
        } else if (scenes[1].id === gauntletChampion.id) {
          rightStreak = gauntletWins;
        }
      }
    }

    const cardHtmlLeft = battleTarget === "scenes" 
      ? createSceneCard(scenes[0], "left", ranks[0], leftStreak)
      : createPerformerCard(scenes[0], "left", ranks[0], leftStreak);

    const cardHtmlRight = battleTarget === "scenes" 
      ? createSceneCard(scenes[1], "right", ranks[1], rightStreak)
      : createPerformerCard(scenes[1], "right", ranks[1], rightStreak);

    comparisonArea.innerHTML = `
      <div class="pwr-vs-container">
        ${cardHtmlLeft}
        <div class="pwr-vs-divider">
          <span class="pwr-vs-text">VS</span>
        </div>
        ${cardHtmlRight}
      </div>
    `;

    // Attach event listeners to scene body (for choosing)
    comparisonArea.querySelectorAll(".pwr-scene-body").forEach((body) => {
      body.addEventListener("click", handleChooseScene);
    });

    // Attach click-to-open (for thumbnail only) - opens in new tab
    comparisonArea.querySelectorAll(".pwr-scene-image-container").forEach((container) => {
      const sceneUrl = container.dataset.sceneUrl;
      
      container.addEventListener("click", () => {
        if (sceneUrl) {
          navigateToUrl(sceneUrl);
        }
      });
    });

    // Attach hover preview to entire card
    comparisonArea.querySelectorAll(".pwr-scene-card").forEach((card) => {
      const video = card.querySelector(".pwr-hover-preview");
      if (!video) return;
      
      card.addEventListener("mouseenter", () => {
        video.currentTime = 0;
        video.muted = false;
        video.volume = 0.5;
        video.play().catch(() => {});
      });
      
      card.addEventListener("mouseleave", () => {
        video.pause();
        video.currentTime = 0;
      });
    });

    // Attach gallery thumbnail hover event listeners for performer cards
    if (battleTarget === "performers") {
      comparisonArea.querySelectorAll(".pwr-performer-card").forEach((card) => {
        const mainImage = card.querySelector(".pwr-performer-image");
        if (!mainImage) return;

        const defaultSrc = mainImage.dataset.defaultSrc;
        const thumbsContainer = card.querySelector(".pwr-gallery-thumbs-container");

        if (thumbsContainer) {
          // Stop propagation of click events inside thumbs container so clicking thumbnails doesn't trigger card navigation
          thumbsContainer.addEventListener("click", (e) => {
            e.stopPropagation();
          });

          thumbsContainer.addEventListener("mouseleave", () => {
            if (defaultSrc) {
              mainImage.src = defaultSrc;
            }
            card.querySelectorAll(".pwr-gallery-thumb").forEach((t) => t.classList.remove("active"));
          });
        }

        card.querySelectorAll(".pwr-gallery-thumb").forEach((thumb) => {
          const hoverSrc = thumb.dataset.src;

          thumb.addEventListener("mouseenter", () => {
            if (hoverSrc) {
              mainImage.src = hoverSrc;
            }
            card.querySelectorAll(".pwr-gallery-thumb").forEach((t) => t.classList.remove("active"));
            thumb.classList.add("active");
          });
        });
      });
    }

    
    // Update skip button state
    const skipBtn = document.querySelector("#pwr-skip-btn");
    if (skipBtn) {
      const disableSkip = currentMode === "gauntlet" && gauntletChampion;
      skipBtn.disabled = disableSkip;
      skipBtn.style.opacity = disableSkip ? "0.5" : "1";
      skipBtn.style.cursor = disableSkip ? "not-allowed" : "pointer";
    }
  }

  function getNextDeterministicScene() {
    if (shuffledFilteredScenes && shuffleIndex < shuffledFilteredScenes.length) {
      return shuffledFilteredScenes[shuffleIndex];
    }
    return null;
  }

  function triggerPrefetch() {
    if (currentMode === "swiss") {
      const nextScene = getNextDeterministicScene();
      if (nextScene) {
        console.log(`[Stash Battle] 🚀 Pre-fetching next left-side scene ${nextScene.id}...`);
        fetchSceneDetails(nextScene.id);
      }
    }
  }

  async function loadNewPair() {
    disableChoice = false;
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;

    console.log(`[Stash Battle] 🎮 Loading new pair (mode: ${currentMode})...`);
    const startTime = Date.now();

    // Show beautiful card shimmer loaders on loading
    comparisonArea.innerHTML = `
      <div class="pwr-vs-container">
        <div class="pwr-scene-card pwr-shimmer" data-side="left">
          <div class="pwr-scene-image-container">
            <div class="pwr-scene-image pwr-no-image">Loading screenshot...</div>
          </div>
          <div class="pwr-scene-body">
            <div class="pwr-scene-info">
              <div class="pwr-scene-title">Loading title...</div>
              <div class="pwr-meta-item"></div>
              <div class="pwr-meta-item"></div>
              <div class="pwr-meta-item"></div>
              <div class="pwr-meta-item"></div>
            </div>
          </div>
        </div>
        <div class="pwr-vs-divider">
          <span class="pwr-vs-text">VS</span>
        </div>
        <div class="pwr-scene-card pwr-shimmer" data-side="right">
          <div class="pwr-scene-image-container">
            <div class="pwr-scene-image pwr-no-image">Loading screenshot...</div>
          </div>
          <div class="pwr-scene-body">
            <div class="pwr-scene-info">
              <div class="pwr-scene-title">Loading title...</div>
              <div class="pwr-meta-item"></div>
              <div class="pwr-meta-item"></div>
              <div class="pwr-meta-item"></div>
              <div class="pwr-meta-item"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    try {
      let scenes;
      let ranks = [null, null];
      
      if (currentMode === "gauntlet") {
        const gauntletResult = await fetchGauntletPair();
        
        // Check for victory (champion reached #1)
        if (gauntletResult.isVictory) {
          const fullScene = await fetchSceneDetails(gauntletResult.scenes[0].id);
          comparisonArea.innerHTML = createVictoryScreen(fullScene || gauntletResult.scenes[0]);
          
          // Hide the status banner and skip button
          const statusEl = document.getElementById("pwr-gauntlet-status");
          const actionsEl = document.querySelector(".pwr-actions");
          if (statusEl) statusEl.style.display = "none";
          if (actionsEl) actionsEl.style.display = "none";
          
          // Attach new gauntlet button
          const newGauntletBtn = comparisonArea.querySelector("#pwr-new-gauntlet");
          if (newGauntletBtn) {
            newGauntletBtn.addEventListener("click", () => {
              resetGauntletState();
              saveState();
              // Show the actions again
              if (actionsEl) actionsEl.style.display = "";
              loadNewPair();
            });
          }
          
          return;
        }
        
        // Check for placement (falling scene hit bottom)
        if (gauntletResult.isPlacement) {
          const fullScene = await fetchSceneDetails(gauntletResult.scenes[0].id);
          showPlacementScreen(fullScene || gauntletResult.scenes[0], gauntletResult.placementRank, gauntletResult.placementRating);
          return;
        }
        
        scenes = gauntletResult.scenes;
        ranks = gauntletResult.ranks;
      } else if (currentMode === "champion") {
        const championResult = await fetchChampionPair();
        
        // Check for victory (champion beat everyone)
        if (championResult.isVictory) {
          const fullScene = await fetchSceneDetails(championResult.scenes[0].id);
          comparisonArea.innerHTML = createVictoryScreen(fullScene || championResult.scenes[0]);
          
          // Hide the skip button
          const actionsEl = document.querySelector(".pwr-actions");
          if (actionsEl) actionsEl.style.display = "none";
          
          // Attach new run button
          const newGauntletBtn = comparisonArea.querySelector("#pwr-new-gauntlet");
          if (newGauntletBtn) {
            newGauntletBtn.addEventListener("click", () => {
              resetGauntletState();
              saveState();
              if (actionsEl) actionsEl.style.display = "";
              loadNewPair();
            });
          }
          
          return;
        }
        
        scenes = championResult.scenes;
        ranks = championResult.ranks;
      } else {
        const swissResult = await fetchSwissPair();
        
        scenes = swissResult.scenes;
        ranks = swissResult.ranks;
      }
      
      if (scenes.length < 2) {
        comparisonArea.innerHTML =
          '<div class="pwr-error">Not enough scenes available for comparison.</div>';
        return;
      }

      // Fetch the full details in parallel!
      const [fullLeft, fullRight] = await Promise.all([
        fetchSceneDetails(scenes[0].id),
        fetchSceneDetails(scenes[1].id)
      ]);

      if (!fullLeft || !fullRight) {
        throw new Error("Failed to load scene details from the database.");
      }

      currentPair.left = fullLeft;
      currentPair.right = fullRight;
      currentRanks.left = ranks[0];
      currentRanks.right = ranks[1];

      const loadTime = Date.now() - startTime;
      console.log(`[Stash Battle] ✅ Pair loaded & hydrated in ${loadTime}ms: Scene ${scenes[0].id} (rank #${ranks[0]}) vs Scene ${scenes[1].id} (rank #${ranks[1]})`);

      renderPair([fullLeft, fullRight], ranks);
      saveState();

      // Proactively pre-fetch next deterministic left-side scene in background
      setTimeout(triggerPrefetch, 100);
    } catch (error) {
      console.error("[Stash Battle] Error loading scenes:", error);
      const isNoScenes = error.message.includes("No scenes") || error.message.includes("Not enough");
      comparisonArea.innerHTML = `
        <div class="pwr-error-screen">
          <div class="pwr-error-icon">⚠️</div>
          <p class="pwr-error-message">${error.message}</p>
          <button id="pwr-error-retry" class="btn btn-primary">Retry</button>
        </div>
      `;
      
      // Attach retry handler
      const retryBtn = document.getElementById("pwr-error-retry");
      if (retryBtn) {
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Loading...";
          
          if (isNoScenes) {
            // "No scenes" error: clear everything and start fresh
            await clearFilteredCache();
            shuffledFilteredScenes = [];
            shuffleIndex = 0;
            shuffleFilterKey = null;
            removedSceneIds.clear();
          }
          // Network/other errors: just retry without clearing session state
          
          await loadNewPair();
        });
      }
    }
  }

  function restoreCurrentPair() {
    disableChoice = false;
    console.log("[Stash Battle] 📂 Rendering saved pair (no network fetch needed)");

    // Pre-warm the cache in background for when user makes a choice
    if (!memoryCache.allScenes) {
      console.log("[Stash Battle] 🔥 Pre-warming cache in background...");
      getAllScenesCached(); // Don't await - runs in background
    }

    renderPair(
      [currentPair.left, currentPair.right],
      [currentRanks.left, currentRanks.right]
    );
  }

  let isWaitingForDismissal = false;

  function setupDismissListener() {
    if (isWaitingForDismissal) return;
    isWaitingForDismissal = true;
    
    const handleDismiss = (event) => {
      // Prevent standard browser behaviors for keypresses (like space scrolling)
      if (event.type === "keydown") {
        event.preventDefault();
      }
      cleanupDismiss();
    };
    
    function cleanupDismiss() {
      document.removeEventListener("keydown", handleDismiss);
      document.removeEventListener("click", handleDismiss);
      
      document.querySelectorAll(".pwr-rating-overlay").forEach(el => el.remove());
      isWaitingForDismissal = false;
      loadNewPair();
    }
    
    // Brief delay to allow initial choose-click event bubbling to finish fully
    setTimeout(() => {
      document.addEventListener("keydown", handleDismiss);
      document.addEventListener("click", handleDismiss);
    }, 100);
  }

  function handleChooseScene(event) {
    if(disableChoice) return;
    disableChoice = true;
    const body = event.currentTarget;
    const winnerId = body.dataset.winner;
    const winnerCard = body.closest(".pwr-scene-card");
    const loserId = winnerId === currentPair.left.id ? currentPair.right.id : currentPair.left.id;
    
    const winnerScene = winnerId === currentPair.left.id ? currentPair.left : currentPair.right;
    const loserScene = loserId === currentPair.left.id ? currentPair.left : currentPair.right;
    const winnerRating = getSceneRating(winnerScene) || DEFAULT_RATING;
    const loserRating = getSceneRating(loserScene) || DEFAULT_RATING;
    const loserDisplayRating = getSceneRating(loserScene) || DEFAULT_RATING;
    const loserSide = winnerId === currentPair.left.id ? "right" : "left";
    const loserCard = document.querySelector(`.pwr-scene-card[data-side="${loserSide}"]`);
    
    // Get the loser's rank for #1 dethrone logic
    const loserRank = loserId === currentPair.left.id ? currentRanks.left : currentRanks.right;

    // Capture old rank information
    const winnerCount = getSceneBattleCount(winnerScene);
    const winnerIsUnrated = getSceneRating(winnerScene) === null || winnerCount === 0;
    const oldWinnerInfo = getCurrentRankAndTotal(winnerId);
    const oldWinnerRank = winnerIsUnrated ? null : oldWinnerInfo.rank;
    const oldWinnerTotal = oldWinnerInfo.total;

    const loserCount = getSceneBattleCount(loserScene);
    const loserIsUnrated = getSceneRating(loserScene) === null || loserCount === 0;
    const oldLoserInfo = getCurrentRankAndTotal(loserId);
    const oldLoserRank = loserIsUnrated ? null : oldLoserInfo.rank;
    const oldLoserTotal = oldLoserInfo.total;

    // Handle gauntlet mode (binary search model)
    if (currentMode === "gauntlet") {
      const cache = getMemoryCache();
      const allScenes = cache.allScenes || [];

      const ratedOnly = allScenes.filter(s => getRating(s) != null);
      const opponentPool = ratedOnly.length >= 1 ? ratedOnly : allScenes;
      
      const searchPool = opponentPool.filter(s => s.id !== gauntletChampion.id);
      const opponent = currentPair.left.id === gauntletChampion.id ? currentPair.right : currentPair.left;
      let mid = searchPool.findIndex(s => s.id === opponent.id);
      if (mid === -1) {
        mid = Math.floor((gauntletLow + gauntletHigh) / 2);
      }

      if (winnerId === gauntletChampion.id) {
        // Challenger wins - correct index is <= mid
        gauntletHigh = mid;
        console.log(`[Stash Battle] 👍 Challenger won! Adjusting high boundary to ${mid}`);
      } else {
        // Challenger loses - correct index is > mid
        gauntletLow = mid + 1;
        console.log(`[Stash Battle] 👎 Challenger lost! Adjusting low boundary to ${mid + 1}`);
      }

      gauntletWins++;
      saveState();

      // Visual feedback: green border on winner, red on loser
      winnerCard.classList.add("pwr-winner");
      if (loserCard) loserCard.classList.add("pwr-loser");

      setTimeout(() => {
        loadNewPair();
      }, 800);

      return;
    }

    // Handle champion mode (like gauntlet but winner always takes over)
    if (currentMode === "champion") {
      
      // First battle: set champion so handleComparison recognizes the active scene
      const isFirstBattle = !gauntletChampion;
      if (isFirstBattle) {
        gauntletChampion = currentPair.left;
      }

      // Calculate rating changes (pass loserRank for #1 dethrone)
      const { newWinnerRating, newLoserRating, winnerChange, loserChange } = handleComparison(
        winnerId, loserId, winnerRating, loserRating,
        getSceneBattleCount(winnerScene), getSceneBattleCount(loserScene), loserRank
      );
      
      const newWinnerInfo = getCurrentRankAndTotal(winnerId);
      const newLoserInfo = getCurrentRankAndTotal(loserId);
      
      if (winnerId === gauntletChampion.id) {
        // Champion won - continue streak
        gauntletWins++;
      } else {
        // Champion lost or first pick - winner becomes new champion
        gauntletChampion = winnerScene;
        gauntletWins = 1;
      }
      
      saveState();
      
      // Visual feedback with animations
      winnerCard.classList.add("pwr-winner");
      if (loserCard) loserCard.classList.add("pwr-loser");
      
      showRatingAnimation(winnerCard, winnerRating, newWinnerRating, winnerChange, true,
        { rank: oldWinnerRank, total: oldWinnerTotal },
        { rank: newWinnerInfo.rank, total: newWinnerInfo.total }
      );
      if (loserCard) {
        const loserDisplayNew = loserChange !== 0 ? newLoserRating : loserDisplayRating;
        showRatingAnimation(loserCard, loserDisplayRating, loserDisplayNew, loserChange, false,
          { rank: oldLoserRank, total: oldLoserTotal },
          { rank: newLoserInfo.rank, total: newLoserInfo.total }
        );
      }
      
      // Wait for user keypress or click to load next pair
      setupDismissListener();
      return;
    }

    // For Swiss: Calculate and show rating changes
    const { newWinnerRating, newLoserRating, winnerChange, loserChange } = handleComparison(
      winnerId, loserId, winnerRating, loserRating,
      getSceneBattleCount(winnerScene), getSceneBattleCount(loserScene)
    );
    
    const newWinnerInfo = getCurrentRankAndTotal(winnerId);
    const newLoserInfo = getCurrentRankAndTotal(loserId);
    
    // Remove both scenes from filtered pool (they've been processed)
    // This prevents the loser from reappearing if it no longer matches the filter
    removeFromFilteredPool(currentPair.left.id);
    removeFromFilteredPool(currentPair.right.id);

    saveState();

    // Visual feedback
    winnerCard.classList.add("pwr-winner");
    if (loserCard) loserCard.classList.add("pwr-loser");

    // Show rating change animation
    showRatingAnimation(winnerCard, winnerRating, newWinnerRating, winnerChange, true,
      { rank: oldWinnerRank, total: oldWinnerTotal },
      { rank: newWinnerInfo.rank, total: newWinnerInfo.total }
    );
    if (loserCard) {
      const loserDisplayNew = loserChange !== 0 ? newLoserRating : loserDisplayRating;
      showRatingAnimation(loserCard, loserDisplayRating, loserDisplayNew, loserChange, false,
        { rank: oldLoserRank, total: oldLoserTotal },
        { rank: newLoserInfo.rank, total: newLoserInfo.total }
      );
    }

    // Wait for user keypress or click to load next pair
    setupDismissListener();
  }

  function showRatingAnimation(card, oldRating, newRating, change, isWinner, oldRankInfo = null, newRankInfo = null) {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = `pwr-rating-overlay ${isWinner ? 'pwr-rating-winner' : 'pwr-rating-loser'}`;
    
    let rankDisplay = null;
    let rankChangeDisplay = null;
    let startRank = null;
    let newRank = null;

    // Setup Rank elements at the top if rank info is available
    if (oldRankInfo && newRankInfo && newRankInfo.rank !== null) {
      rankDisplay = document.createElement("div");
      rankDisplay.className = "pwr-rating-display";
      rankDisplay.style.textAlign = "center";
      rankDisplay.textContent = oldRankInfo.rank === null ? "Unrated" : `#${oldRankInfo.rank} / ${oldRankInfo.total}`;

      rankChangeDisplay = document.createElement("div");
      rankChangeDisplay.className = "pwr-rating-change";
      rankChangeDisplay.style.marginBottom = "24px";
      rankChangeDisplay.style.textAlign = "center";
      
      newRank = newRankInfo.rank;
      startRank = oldRankInfo.rank === null ? newRankInfo.total : oldRankInfo.rank;
      
      if (oldRankInfo.rank === null) {
        rankChangeDisplay.textContent = "▲ New";
        rankChangeDisplay.style.color = "#d4ffff";
      } else {
        const diff = oldRankInfo.rank - newRank; // positive means rank decreased (moved UP)
        if (diff > 0) {
          rankChangeDisplay.textContent = `▲ ${diff}`;
          rankChangeDisplay.style.color = "#d4ffd4";
        } else if (diff < 0) {
          rankChangeDisplay.textContent = `▼ ${Math.abs(diff)}`;
          rankChangeDisplay.style.color = "#ffd4d4";
        } else {
          rankChangeDisplay.textContent = "—";
          rankChangeDisplay.style.color = "rgba(255, 255, 255, 0.8)";
        }
      }
      
      overlay.appendChild(rankDisplay);
      overlay.appendChild(rankChangeDisplay);
    }

    const ratingDisplay = document.createElement("div");
    ratingDisplay.className = "pwr-rating-display";
    ratingDisplay.textContent = oldRating;
    
    const changeDisplay = document.createElement("div");
    changeDisplay.className = "pwr-rating-change";
    changeDisplay.textContent = isWinner ? `+${change}` : `${change}`;
    
    overlay.appendChild(ratingDisplay);
    overlay.appendChild(changeDisplay);
    card.appendChild(overlay);

    // Animate the rating counting
    let currentDisplay = oldRating;
    const changeAmount = newRating - oldRating;
    const duration = 800; // Animation duration in ms
    const intervalTime = 30; // 30ms interval
    const totalTicks = duration / intervalTime;
    const increment = changeAmount / totalTicks;
    let tickCount = 0;
    
    const interval = setInterval(() => {
      tickCount++;
      currentDisplay += increment;
      ratingDisplay.textContent = Math.round(currentDisplay);
      
      if (tickCount >= totalTicks) {
        clearInterval(interval);
        ratingDisplay.textContent = newRating;
      }
    }, intervalTime);

    // Animate the rank counting in sync
    if (rankDisplay && startRank !== null && newRank !== null) {
      let currentRankDisplay = startRank;
      const rankChangeAmount = newRank - startRank;
      const rankIncrement = rankChangeAmount / totalTicks;
      
      const startTotal = oldRankInfo.total;
      const newTotal = newRankInfo.total;
      let currentTotalDisplay = startTotal;
      const totalChangeAmount = newTotal - startTotal;
      const totalIncrement = totalChangeAmount / totalTicks;
      let rankTickCount = 0;
      
      const rankInterval = setInterval(() => {
        rankTickCount++;
        currentRankDisplay += rankIncrement;
        currentTotalDisplay += totalIncrement;
        rankDisplay.textContent = `#${Math.round(currentRankDisplay)} / ${Math.round(currentTotalDisplay)}`;
        
        if (rankTickCount >= totalTicks) {
          clearInterval(rankInterval);
          rankDisplay.textContent = `#${newRank} / ${newTotal}`;
        }
      }, intervalTime);
    }
  }

  // ============================================
  // MODAL & NAVIGATION
  // ============================================

  function shouldShowButton() {
    const path = window.location.pathname;
    // Show on /scenes and /performers lists and individual pages
    return path === '/scenes' || path === '/scenes/' || path.startsWith('/scenes/') ||
           path === '/performers' || path === '/performers/' || path.startsWith('/performers/');
  }

  function addFloatingButton() {
    const buttonId = "plugin_pwr";
    
    // Remove button if we're not on the scenes page
    if (!shouldShowButton()) {
        const existing = document.getElementById(buttonId);
        if (existing) {
            existing.closest(".nav-link")?.remove();
        }
        return;
    }
    
    // Prevent duplicates
    if (document.getElementById(buttonId)) return;

    const navItem = document.createElement("div");
    navItem.className = "col-4 col-sm-3 col-md-2 col-lg-auto nav-link";
    navItem.id = buttonId;

    navItem.innerHTML = `
        <a href="#" class="minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary">
            <svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
                <path fill="currentColor" d="m24 29 5-5L6 1H1v5z"/>
                <path fill="currentColor" d="M1 1v5l23 23 2.5-2.5z"/>
                <path fill="currentColor" d="M33.424 32.808c.284-.284.458-.626.531-.968l-5.242-6.195-.7-.702c-.565-.564-1.57-.473-2.249.205l-.614.612c-.677.677-.768 1.683-.204 2.247l.741.741 6.15 5.205c.345-.072.688-.247.974-.532z"/>
                <path fill="currentColor" d="M33.424 32.808c.284-.284.458-.626.531-.968l-1.342-1.586-.737 3.684c.331-.077.661-.243.935-.518zm-3.31-5.506-.888 4.44 1.26 1.067.82-4.1zm-1.4-1.657-.702-.702a1.2 1.2 0 0 0-.326-.224l-.978 4.892 1.26 1.066.957-4.783zm-2.402-.888a2 2 0 0 0-.548.392l-.614.61a2 2 0 0 0-.51.86c-.143.51-.047 1.036.306 1.388l.596.596zm0 0q0-.003 0 0"/>
                <path fill="currentColor" d="M33.25 36a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5M29.626 22.324a1.034 1.034 0 0 1 0 1.462l-6.092 6.092a1.032 1.032 0 0 1-1.686-.336 1.03 1.03 0 0 1 .224-1.126l6.092-6.092a1.033 1.033 0 0 1 1.462 0"/>
                <path fill="currentColor" d="M22.072 31.627a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5M29.626 24.073a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5"/>
                <path fill="currentColor" d="M22.072 30.877a1 1 0 1 0 0-2 1 1 0 0 0 0 2M29.626 23.323a1 1 0 1 0 0-2 1 1 0 0 0 0 2M33.903 29.342a.76.76 0 0 1 0 1.078l-3.476 3.475a.762.762 0 0 1-1.078-1.078l3.476-3.475a.76.76 0 0 1 1.078 0M12 29l-5-5L30 1h5v5z"/>
                <path fill="currentColor" d="M35 1v5L12 29l-2.5-2.5z"/>
                <path fill="currentColor" d="M2.576 32.808a1.95 1.95 0 0 1-.531-.968l5.242-6.195.7-.702c.565-.564 1.57-.473 2.249.205l.613.612c.677.677.768 1.683.204 2.247l-.741.741-6.15 5.205a1.95 1.95 0 0 1-.974-.532z"/>
                <path fill="currentColor" d="M2.576 32.808a1.95 1.95 0 0 1-.531-.968l1.342-1.586.737 3.684a1.93 1.93 0 0 1-.935-.518zm3.31-5.506.888 4.44-1.26 1.067-.82-4.1zm1.4-1.657.702-.702a1.2 1.2 0 0 1 .326-.224l.978 4.892-1.26 1.066-.957-4.783zm2.402-.888c.195.095.382.225.548.392l.613.612c.254.254.425.554.51.86.143.51.047 1.035-.306 1.387l-.596.596zm0 0q0-.003 0 0"/>
                <path fill="currentColor" d="M2.75 36a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5M6.374 22.324a1.034 1.034 0 0 0 0 1.462l6.092 6.092a1.033 1.033 0 1 0 1.462-1.462l-6.092-6.092a1.033 1.033 0 0 0-1.462 0"/>
                <path fill="currentColor" d="M13.928 31.627a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5M6.374 24.073a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5"/>
                <path fill="currentColor" d="M13.928 30.877a1 1 0 1 0 0-2 1 1 0 0 0 0 2M6.374 23.323a1 1 0 1 0 0-2 1 1 0 0 0 0 2M2.097 29.342a.76.76 0 0 0 0 1.078l3.476 3.475a.763.763 0 0 0 1.078-1.078l-3.476-3.475a.76.76 0 0 0-1.078 0"/>
            </svg>
            <span>Battle</span>
        </a>
    `;

    // Prevent default link behavior and attach click handler
    const link = navItem.querySelector("a");
    link.addEventListener("click", (e) => {
        e.preventDefault();
        openRankingModal();
    });

    // Append to navbar
    const navTarget = document.querySelector(".navbar-nav");
    if (navTarget) {
        navTarget.appendChild(navItem);
    }
  }


  function openRankingModal() {
    console.log("[Stash Battle] 🎯 Opening modal...");
    
    // Pause all media playing in stash when battle modal is opened to prevent audio overlap with hover previews
    document.querySelectorAll('video, audio').forEach(v => v.pause());
    
    // Set battleTarget based on active route
    const path = window.location.pathname;
    if (path.startsWith('/performers')) {
      setBattleTarget("performers");
    } else {
      setBattleTarget("scenes");
    }
    
    // Try to load saved state
    const hasState = loadState();
    console.log(`[Stash Battle] 📋 LocalStorage state: ${hasState ? 'found' : 'none'}`);
    
    if (!hasState) {
      syncFromTarget();
    }
    
    // Set openedFromSceneId if we are on a scene or performer detail page
    const currentItemId = getCurrentPageItemId();
    if (currentItemId) {
      openedFromSceneId = currentItemId;
      console.log(`[Stash Battle] 🎯 Battle modal opened from page with ID: ${openedFromSceneId}`);
    } else {
      openedFromSceneId = null;
    }
    
    // Check if URL filter params have changed - if so, reset state
    const currentFilterParams = window.location.search;
    const filtersChanged = hasState && savedFilterParams !== currentFilterParams;
    
    if (filtersChanged) {
      console.log("[Stash Battle] Filter params changed, resetting gauntlet state and filtered cache");
      currentPair = { left: null, right: null };
      currentRanks = { left: null, right: null };
      resetGauntletState();
      savedFilterParams = currentFilterParams;
      
      // Clear filtered cache
      clearFilteredCache();
      
      // Reset shuffle for new filter
      shuffledFilteredScenes = [];
      shuffleIndex = 0;
      shuffleFilterKey = null;
    }
    
    // Recreate modal every time to ensure fresh content matching battleTarget
    const existingModal = document.getElementById("pwr-modal");
    if (existingModal) {
      existingModal.remove();
    }
    
    // Initialize filter params tracking
    if (!savedFilterParams) {
      savedFilterParams = currentFilterParams;
    }

    const modal = document.createElement("div");
    modal.id = "pwr-modal";
    const isPerformer = battleTarget === "performers";
    modal.innerHTML = `
      <div class="pwr-modal-backdrop"></div>
      <div class="pwr-modal-content ${isPerformer ? 'pwr-performers-modal' : ''}">
        <button class="pwr-modal-close">✕</button>
        ${createMainUI()}
      </div>
    `;

    document.body.appendChild(modal);

    // Focus the modal content so keyboard shortcuts work immediately
    const modalContent = modal.querySelector(".pwr-modal-content");
    if (modalContent) {
      modalContent.setAttribute("tabindex", "-1");
      modalContent.style.outline = "none";
      modalContent.focus();
    }

    // Mode toggle buttons
    modal.querySelectorAll(".pwr-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newMode = btn.dataset.mode;
        if (newMode !== currentMode) {
          currentMode = newMode;
          
          resetGauntletState();
          
          // Reset shuffle to start fresh with new mode
          shuffleIndex = 0;
          
          // Update button states
          modal.querySelectorAll(".pwr-mode-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.mode === currentMode);
          });
          
          // Re-show actions (skip button) in case it was hidden
          const actionsEl = document.querySelector(".pwr-actions");
          if (actionsEl) actionsEl.style.display = "";
          
          // Re-initialize openedFromSceneId when switching to gauntlet/champion mode
          if (currentMode === "gauntlet" || currentMode === "champion") {
            const currentSceneId = getCurrentSceneId();
            if (currentSceneId) {
              openedFromSceneId = currentSceneId;
            }
          }
          
          // Load new pair in new mode
          loadNewPair();
          saveState();
        }
      });
    });

    // Skip button
    const skipBtn = modal.querySelector("#pwr-skip-btn");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        // In gauntlet mode with active run, skip is disabled
        if (currentMode === "gauntlet" && gauntletChampion) {
          return;
        }
        if(disableChoice) return
        disableChoice = true;
        
        openedFromSceneId = null; // Clear on skip so a random scene is chosen instead of the page scene
        
        // Reset state on skip
        if (currentMode === "gauntlet" || currentMode === "champion") {
          resetGauntletState();
          saveState();
        }
        loadNewPair();
      });
    }

    // Refresh cache button
    const refreshCacheBtn = modal.querySelector("#pwr-refresh-cache-btn");
    if (refreshCacheBtn) {
      refreshCacheBtn.addEventListener("click", async () => {
        if (disableChoice) return;
        
        refreshCacheBtn.disabled = true;
        refreshCacheBtn.textContent = "🔄 Refreshing...";
        
        try {
          await clearSceneCache();
          
          // Reset shuffle state since scene list is being refreshed
          shuffledFilteredScenes = [];
          shuffleIndex = 0;
          shuffleFilterKey = null;
          removedSceneIds.clear(); // Reset removed tracking for fresh data
          
          // Reset gauntlet state since rankings may have changed
          resetGauntletState();
          saveState();
          
          // Re-show actions in case hidden
          const actionsEl = document.querySelector(".pwr-actions");
          if (actionsEl) actionsEl.style.display = "";
          
          await loadNewPair();
        } catch (e) {
          console.error("[Stash Battle] Refresh failed:", e);
        } finally {
          refreshCacheBtn.disabled = false;
          refreshCacheBtn.textContent = "🔄 Refresh Cache";
        }
      });
    }

    // Config button
    const configBtn = modal.querySelector("#pwr-config-btn");
    if (configBtn) {
      configBtn.addEventListener("click", () => {
        if (disableChoice) return;
        renderConfigPanel();
      });
    }

    // Main view Sync Rankings button
    const mainSyncBtn = modal.querySelector("#pwr-sync-rankings-main-btn");
    if (mainSyncBtn) {
      mainSyncBtn.addEventListener("click", () => {
        if (disableChoice) return;
        executeRankingsSync();
      });
    }

    // Leaderboard button click handler
    const lbBtn = modal.querySelector("#pwr-leaderboard-modal-btn");
    if (lbBtn) {
      lbBtn.addEventListener("click", (e) => {
        e.preventDefault();
        closeRankingModal();
        window.location.pathname = "/performer-battle-leaderboard";
      });
    }

    // Load initial comparison or restore saved pair
    if (hasState && currentPair.left && currentPair.right && !filtersChanged) {
      const shouldStartNewGauntlet = openedFromSceneId && 
                                    (currentMode === "gauntlet" || currentMode === "champion") && 
                                    (!gauntletChampion || String(gauntletChampion.id) !== String(openedFromSceneId));
      
      if (shouldStartNewGauntlet) {
        console.log("[Stash Battle] 🆕 Starting new gauntlet/champion run with current page scene");
        loadNewPair();
      } else {
        console.log(`[Stash Battle] 📂 Restoring saved pair from localStorage (Scene ${currentPair.left.id} vs Scene ${currentPair.right.id})`);
        restoreCurrentPair();
      }
    } else {
      console.log(`[Stash Battle] 🆕 No saved pair or filters changed, loading new pair...`);
      loadNewPair();
    }

    // Close handlers
    modal.querySelector(".pwr-modal-backdrop").addEventListener("click", closeRankingModal);
    modal.querySelector(".pwr-modal-close").addEventListener("click", closeRankingModal);
    
    // Remove any existing keyboard handlers before adding new ones
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
    
    // Single keyboard handler for all modal shortcuts
    modalKeyHandler = function(e) {
      const modal = document.getElementById("pwr-modal");
      if (!modal) {
        document.removeEventListener("keydown", modalKeyHandler, true);
        modalKeyHandler = null;
        return;
      }

      // Escape to close
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRankingModal();
        return;
      }

      // Arrow keys to choose (stop propagation to prevent Stash scene navigation)
      if (e.key === "ArrowLeft" && currentPair.left) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const leftBody = modal.querySelector('.pwr-scene-card[data-side="left"] .pwr-scene-body');
        if (leftBody) leftBody.click();
      }
      if (e.key === "ArrowRight" && currentPair.right) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const rightBody = modal.querySelector('.pwr-scene-card[data-side="right"] .pwr-scene-body');
        if (rightBody) rightBody.click();
      }
      
      // Spacebar to skip
      if (e.key === " " || e.code === "Space") {
        const activeElement = document.activeElement;
        // Skip if focused on input/textarea, or if a button is focused (let button's click handle it)
        if (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA" || activeElement.tagName === "BUTTON") {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        // Don't skip during active gauntlet run
        if (currentMode === "gauntlet" && gauntletChampion) {
          return;
        }
        if(disableChoice) return;
        disableChoice = true;
        
        openedFromSceneId = null; // Clear on skip so a random scene is chosen instead of the page scene
        
        if (currentMode === "gauntlet" || currentMode === "champion") {
          resetGauntletState();
          saveState();
        }
        loadNewPair();
      }
    };
    
    document.addEventListener("keydown", modalKeyHandler, true);
  }

  // Track keyboard handler so we can remove it on close
  let modalKeyHandler = null;

  function closeRankingModal() {
    const modal = document.getElementById("pwr-modal");
    if (!modal || modal.classList.contains("pwr-modal-hidden")) return;
    
    // Add closing class to trigger fade-out animation
    modal.classList.add("pwr-modal-closing");
    
    // After animation completes, hide the modal (keep in DOM for reuse)
    setTimeout(() => {
      modal.classList.add("pwr-modal-hidden");
      modal.classList.remove("pwr-modal-closing");
    }, 200); // Match CSS animation duration
    
    // Clean up keyboard handler
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  function init() {
    console.log("[Stash Battle] Initialized");

    addFloatingButton();

    // Watch for SPA navigation
    const observer = new MutationObserver(() => {
      addFloatingButton();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
