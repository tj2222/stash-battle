# Stash Battle — Technical Documentation

> For LLM agents and contributors working on the plugin. This documents the nuanced behavior, architecture, and design decisions that aren't obvious from the code alone.

## ⚠️ Keeping This Document Up To Date

**This file must be updated whenever you change behavior in the plugin.** If you modify rating logic, pool filtering, mode behavior, caching, UI components, or any other documented behavior, update the relevant section here in the same changeset.

When adding new features or fixing bugs:
1. Update any existing sections that are affected by your change
2. If the change introduces a subtle edge case or non-obvious behavior, add it to the **Common Pitfalls & Edge Cases** section
3. If you add a new mode, config option, or major feature, add a new section for it

If you're an LLM agent: read this file before making changes to understand existing behavior, and update it after making changes to keep it accurate.

---

## Architecture Overview

The plugin is a single IIFE (`stash-battle.js`, ~3600 lines) injected into the Stash UI. It has no build step — just raw JS, a CSS file, and a YAML manifest. It adds a "Battle" button to `/scenes` and `/performers` pages that opens a modal where users compare items head-to-head to build rankings via an ELO system.

### Target-Neutral Architecture

The plugin operates on two **battle targets**: `"scenes"` and `"performers"`. The active target is determined by the current URL path (`/performers` → performers, everything else → scenes). All matchmaking, caching, and UI logic is target-neutral — functions like `fetchItems()`, `updateItemRatingAndCount()`, and `getAllScenesCached()` operate on whichever target is active via the `battleTarget` variable.

Each target has its own isolated:
- **Memory cache** (`scenesMemoryCache` / `performersMemoryCache`)
- **Details cache** (`scenesDetailsCache` / `performersDetailsCache`)
- **Session pool** (`sessionPools.scenes` / `sessionPools.performers`)
- **IndexedDB cache keys** (`"all-scenes"` / `"all-performers"`, `"filtered-scenes"` / `"filtered-performers"`)

### Entry Flow

1. `init()` fires on `DOMContentLoaded`
2. `addFloatingButton()` injects a nav item on `/scenes` or `/performers` pages
3. `PluginApi.Event.addEventListener("stash:location", ...)` re-adds the button on SPA navigation — this is Stash's official event, dispatched from React's `useEffect` in `App.tsx` on every route change. It replaces the old `MutationObserver` approach.
4. Clicking the button opens `openRankingModal()` which:
   - Sets `battleTarget` based on the current URL path
   - Loads persisted mode preference via `loadMode()` (only `currentMode` is persisted)
   - Always loads a fresh pair — no state is restored from previous sessions
5. **Item Page Auto-Initialization**: If the modal is opened while viewing an individual item page (e.g., `/scenes/<id>` or `/performers/<id>`), the plugin captures the active item's ID via `getCurrentPageItemId()`. In Gauntlet or Champion modes, this item is used as the initial challenger/champion.

### State Persistence

Only `currentMode` (`"swiss"`, `"gauntlet"`, or `"champion"`) is persisted via `localStorage` under the key `"stash-battle-mode"`. All other state (current pair, gauntlet progress, filter tracking) is ephemeral — refreshing the page resets it. This was a deliberate simplification to reduce complexity; the previous system persisted ~15 state variables and required filter-change detection, restore-vs-new-pair branching, and storage key management.

### Core State Variables

All state lives in closure-scoped variables (no globals):

| Variable | Purpose |
|---|---|
| `battleTarget` | `"scenes"` or `"performers"` — determines which type of item to battle |
| `currentPair` | `{ left, right }` — the two items currently displayed |
| `currentRanks` | `{ left, right }` — rank positions for display |
| `currentMode` | `"swiss"`, `"gauntlet"`, or `"champion"` — **only persisted state** |
| `gauntletChampion` | The item on a winning streak (gauntlet/champion modes) |
| `gauntletWins` | Current win streak count |
| `gauntletDefeated` | Array of item IDs the champion has beaten (prevents rematches) |
| `gauntletFalling` | Boolean — true when in gauntlet falling/binary-search mode |
| `gauntletFallingScene` | The item being placed via binary search |
| `gauntletLow` / `gauntletHigh` | Binary search bounds (0-indexed into `searchPool`) |
| `totalScenesCount` | Size of the opponent pool (used for "Rank #X of Y" display) |
| `openedFromItemId` | Captured when modal opens from an individual item page |
| `disableChoice` | Prevents double-clicks during animation/transition periods |

---

## The Two Sides

The battle UI always shows two items:

- **Left side (scene1)**: Drawn from the **filtered pool** — these are the items the user wants to rate. In gauntlet/champion modes, this is the champion/challenger.
- **Right side (scene2)**: Drawn from the **opponent pool** — these serve as rated benchmarks for comparison.

This distinction is fundamental to the entire plugin.

---

## Item Pools

### `allScenes`
All items in the Stash library (scenes or performers, depending on `battleTarget`), sorted by `battle-rating` DESC via `sortByRatingDesc()`. Fetched once and cached aggressively. Includes both rated and unrated items.

### `filteredScenes`
Items matching the current URL filter parameters (`c`, `q` params). If no filter is active, this equals `allScenes`. Used exclusively for the **left side** — the "items to be rated" pool.

### `opponentPool` (right side)
Determined per-fetch in each mode function:

```
ratedOnly = allScenes.filter(s => getRating(s) != null)
opponentPool = ratedOnly.length >= 1 ? ratedOnly : allScenes
```

**Critical behavior**: The opponent pool prefers rated items only. This prevents unrated items from appearing as right-side opponents. If no rated items exist yet (bootstrap scenario), it falls back to the full list.

### `totalScenesCount`
Set from `opponentPool.length` (not `allScenes.length`), so the "Rank #X of Y" display is consistent with the pool the ranks come from.

---

## Caching Strategy

### Two Memory Caches per Target

Each target (`scenes` / `performers`) has its own isolated memory cache:

```js
scenesMemoryCache = { allScenes, filteredScenes, filterKey, timestamp }
performersMemoryCache = { allScenes, filteredScenes, filterKey, timestamp }
```

`getMemoryCache()` returns the active one based on `battleTarget`.

### Three Cache Layers

1. **Memory cache** (`getMemoryCache()` + `getDetailsCache()`) — instant, lives for the page session. `memoryCache` stores minimal item lists; `detailsCache` (a `Map`) stores on-demand loaded detailed item objects.
2. **IndexedDB** (`stash-battle-cache` DB) — survives page reloads. Uses target-specific keys: `"all-scenes"` / `"all-performers"`, `"filtered-scenes"` / `"filtered-performers"`.
3. **Network** (GraphQL) — source of truth, slowest

### Stale-While-Revalidate

On cache hit, data is returned immediately. If older than `CACHE_MAX_AGE_MS` (5 minutes), a background refresh fires (not awaited) to update caches for next time.

### `filterKey`

A JSON string of the current filter parameters (both `q` and `c` params). Stored alongside the filtered cache to detect when the filter has changed and the cache should be invalidated.

---

## Lazy-Loading Item Details

To support extremely large libraries (160k+ items), the plugin uses a minimal-data architecture:

### 1. Fragment Division
- **`MINIMAL_SCENE_FRAGMENT`** / **`MINIMAL_PERFORMER_FRAGMENT`**: Only `id` and `custom_fields`. Avoids expensive SQL joins during startup.
- **`FULL_SCENE_FRAGMENT`** / **`FULL_PERFORMER_FRAGMENT`**: All rich visual metadata (screenshot/image paths, duration, studio, performers/scenes, tags, play count) for rendering cards.

### 2. On-Demand Hydration
When a pair is chosen, `loadNewPair()` calls `fetchItemDetails(id)` in parallel for both items to retrieve full metadata before rendering.

### 3. Progressive Pre-Fetching
- **Left-Side Pre-fetching**: In Swiss mode, the next left-side item is deterministic (next index in `shuffledFiltered`). The plugin pre-fetches its details in the background via `triggerPrefetch()`.
- **Shimmer Placeholders**: During the brief detail-loading interval, CSS shimmer placeholders are shown for a premium feel.

### 4. Image Decode API
After rendering card HTML, `img.decode()` is called on all images to decode them off-main-thread. Images start at `opacity: 0` and fade in after decoding, preventing frame drops from large JPEG screenshots.

### 5. Cache Syncing
When ELO rating is updated, `updateItemInCaches()` modifies ratings in `allScenes`, `filteredScenes`, and `detailsCache` simultaneously, and calls `repositionItemInArray()` to maintain correct sort order.

---

## Configuration & Rating Reset Panel

### UI Transition
- **⚙️ Config Button**: In the modal's action footer.
- **Stateless DOM Swap**: Renders config panel inside `#pwr-comparison-area`, hiding action buttons.
- **"Back to Battle"**: Restores actions and calls `loadNewPair()`.

### Bulk Rating Destruction
- **GraphQL Aliased Batching**: Combines 50 aliased mutations per HTTP request for bulk resets.
- **Safety Safeguard**: Glassmorphic confirmation dialog before destruction.
- **Progress Tracking**: Real-time progress bar during execution.
- **Cache Invalidation**: All caches cleared after completion.

### Rankings Sync (Group Export)
The plugin supports exporting current rankings as a Stash **Group** via `executeRankingsSync()`. Items are added to the group in rank order, allowing users to browse their rankings as a standard Stash group/playlist.

---

## Filtered Pool Management

### Shuffled Traversal

Filtered items are shuffled (Fisher-Yates) and traversed sequentially via `shuffleIndex`. This ensures every item is shown once before any repeat. The shuffle is invalidated when the filter changes (`shuffleFilterKey` check).

### `removedIds`

A `Set` per target (in `sessionPools`) tracking items processed this session. Survives background cache refreshes (which could re-add items to memory cache). Items are removed from the filtered pool after each battle via `removeFromFilteredPool()`.

### Pool Exhaustion

When all filtered items have been processed (`getNextFilteredScene` returns `null`):
1. Clear filtered cache (memory + IndexedDB)
2. Reset shuffle state and `removedIds`
3. Re-fetch from network
4. Retry — picks up newly-qualifying items

---

## Rating / ELO System

### Scale
Standard chess-style Elo points. Clamped with a floor of **100** (`RATING_FLOOR`) and no ceiling.

### Unrated Items
Start with `DEFAULT_RATING` of **1500**. Display as `"Unrated"` until their first battle. In Swiss matchmaking, unrated items are positioned where 1500 would sit in the opponent pool.

### ELO Formula

```
ratingDiffWinner = loserRating - winnerRating
expectedWinner = 1 / (1 + 10^(ratingDiffWinner / 400))
winnerGain = max(1, round(winnerK * (1 - expectedWinner)))

ratingDiffLoser = winnerRating - loserRating
expectedLoser = 1 / (1 + 10^(ratingDiffLoser / 400))
loserLoss = max(1, round(loserK * expectedLoser))
```

Rating defaults use `??` (nullish coalescing) so that a rating of 0 is treated as valid, not as "missing".

### K-Factor (Dynamic)

Based on `battleCount` — newer items have higher K-factors:

| Battle Count | K-Factor | Category |
|---|---|---|
| < 8 | 48 | Provisional — extremely volatile |
| 8 to 15 | 32 | Settling — moderate changes |
| 16 to 30 | 24 | Established — smaller changes |
| ≥ 31 | 16 | Very established — highly stable |

### Mode-Specific Rating Behavior

**Swiss mode**: True ELO — both sides get rating changes based on their respective K-factors.

**Gauntlet mode**: Only the **active scene** (champion or falling scene) gets rating changes. Defenders are benchmarks — their ratings stay the same. Exception: if the defender is **rank #1** and loses, they drop by 1 point (dethrone mechanic).

**Champion mode**: Both sides get standard ELO changes. Exception: if the **#1-ranked item wins**, both sides get 0 change — prevents infinite rating inflation for an already-dominant item.

---

## Game Modes

### Swiss Mode

The default mode. Pairs items with similar ratings for meaningful comparisons.

**Pairing logic**:
1. Pick the next item from the shuffled filtered pool (left side)
2. Find its position in the opponent pool (sorted by rating DESC)
3. If the item isn't in the opponent pool (unrated), position it where `DEFAULT_RATING` (1500) would sit
4. Collect candidates within ±10 of that position, excluding any item with the same ID as scene1 (self-match guard)
5. If no candidates found, **expand the search** (double the reach) until candidates exist
6. Pick randomly from candidates

**After battle**: Both items are removed from the filtered pool. Both get ELO updates.

### Gauntlet Mode (Binary Search)

A ranking-placement mode where a challenger's position is determined via binary search against the rated ladder.

**Initial setup**:
1. Pick an item from the filtered pool as the challenger
2. If opened from an individual item page, that item becomes the challenger
3. Build `searchPool` = opponent pool minus the challenger
4. Initialize binary search bounds: `gauntletLow = 0`, `gauntletHigh = searchPool.length`

**Binary search iteration**:
1. Compute midpoint with up to 10% range jitter: `mid = floor((low + high) / 2) + offset`
2. Present: challenger vs `searchPool[mid]`
3. If challenger wins (beats the opponent): `gauntletHigh = mid` (correct rank is ≤ mid)
4. If challenger loses: `gauntletLow = mid + 1` (correct rank is > mid)
5. Continue until `gauntletLow >= gauntletHigh` — placement is found

**Placement convergence**:
- Target index = `gauntletLow`
- If target index equals the challenger's original index → preserve original rating
- Otherwise, interpolate rating from neighbors above and below the target index
- Special cases for index 0 (above everyone) and last index (below everyone)
- Increment battle count by 1 and update database

**Bounds clamping**: After initialization, bounds are clamped to `[0, searchPool.length]` to handle pool size changes during a session (e.g., background cache refresh changes the rated item count).

**Victory screen**: Not applicable in gauntlet — the mode always ends with a placement screen showing final rank and rating.

### Champion Mode

King-of-the-hill mode where the winner stays on as champion.

**Key differences from Gauntlet**:
- No binary search — uses Swiss-style pairing against higher-rated opponents (candidates above the champion only)
- Both sides get standard ELO changes (exception: #1 winner gets 0 change)
- When champion loses, the winner becomes new champion; old champion keeps their earned rating
- Victory is achieved when the champion reaches **rank #1** in the opponent pool
- Self-match guard prevents the champion from being matched against themselves

---

## UI Behavior

### Item Cards

Cards are rendered by `createSceneCard()` (for scenes) and `createPerformerCard()` (for performers). Each shows target-specific information:

**Scene cards**: Screenshot (with hover video preview), title, duration, rank, studio, performers, play count, rating, tags, and a "Choose This Scene" button.

**Performer cards**: Primary image (with gallery thumbnail hover), name, scene count, rank, rating, tags, and a "Choose This Performer" button. Gallery thumbnails are shown below the main image and swap the main image on hover.

**Badges** (displayed over the image):
- Win streak: `🔥 X wins`
- Binary search placement: `📍 Finding placement...`

**Provisional indicator**: Displays `?` after the rating (e.g. `1548?`) if an item has under 8 battles. Unrated items display as `"Unrated"`.

### Rating Animations

After each battle, an overlay animates the rating and rank changes:
- Green overlay with `+X` for the winner, red with `-X` for the loser
- Both rating and rank count-up/count-down in a single `requestAnimationFrame` loop over 800ms with linear interpolation
- Overlay dismissed on any click or keypress, then new pair loads

### End Screens

Victory and placement screens are rendered by a shared `createEndScreen()` function that takes a config object:
- **Victory** (`createVictoryScreen`): 👑 icon, "CHAMPION!", streak stats, "Start New Gauntlet" button
- **Placement** (`showPlacementScreen`): 📍 icon, "PLACED!", final rank/rating, "Start New Run" button

Both use shared `getItemTitle()` and `getItemImageHtml()` helpers for target-neutral display.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| Escape | Close modal |
| Left Arrow | Choose left item |
| Right Arrow | Choose right item |
| Space | Skip (disabled during gauntlet with active champion) |

---

## GraphQL Integration

All data comes from Stash's GraphQL API via `graphqlQuery()`:

### Retry Mechanism
`graphqlQuery()` includes a single retry with 1-second delay for transient `TypeError` network errors (e.g., `Failed to fetch`). This handles brief connectivity interruptions without adding strict timeouts — legitimate queries for large libraries can take 15-45 seconds.

### Queries and Mutations
- **`findScenes`** / **`findPerformers`**: Fetches minimal item lists with `per_page: -1`
- **`findScene`** / **`findPerformer`**: Fetches full details for individual items on-demand
- **`sceneUpdate`** / **`performerUpdate`**: Writes rating changes back to Stash. Uses a template-based mutation that derives type name from `battleTarget` (e.g., `Scene` → `sceneUpdate`, `Performer` → `performerUpdate`).
- **Bulk mutations** (rating destruction): Aliased batching of 50 mutations per HTTP request

### Custom Fields
Ratings are stored in Stash's `custom_fields` system:
- `battle-rating`: The ELO rating (number)
- `battle-count`: Number of battles fought (number)

Updates use `custom_fields: { partial: { ... } }` to avoid overwriting other custom fields.

---

## URL Filter Integration

The plugin reads Stash's URL filter parameters:

- **`q`** parameter: text search query
- **`c`** parameters: structured criteria (JSON-encoded with `()` instead of `{}`)
- **`sortby`** / **`sortdir`**: sort options (default: `rating` DESC)

`getItemFilter()` parses these into a GraphQL filter type. Supported criterion types: boolean, stringEnum, multi, hierarchicalMulti, resolution, orientation, duplicated, and standard numeric/string comparisons.

---

## Common Pitfalls & Edge Cases

1. **First gauntlet battle ELO**: `gauntletChampion` must be set *before* `handleComparison` runs, otherwise all role checks evaluate to false and no ELO change occurs.

2. **Unrated in opponent pool**: Without the rated-only filter, unrated items cluster at the bottom of the DESC-sorted list. Swiss mode's ±10 reach around an unrated left-side item would pick other unrated items as opponents — defeating the purpose.

3. **Self-match guard**: Both Swiss and Champion modes include `opponentPool[i].id !== scene1.id` checks in candidate selection to prevent the same item from appearing on both sides, even if index-based exclusion fails (e.g., item not in pool).

4. **Gauntlet bounds clamping**: After initializing binary search bounds, they're clamped to `[0, searchPool.length]`. This handles the case where a background cache refresh changes the pool size mid-session, which could otherwise cause out-of-bounds array access.

5. **Gauntlet searchPool minimum**: After filtering out the champion from the opponent pool, the code validates `searchPool.length >= 1`. This prevents entering binary search with an empty pool.

6. **Champion mode #1 winner**: When the #1-ranked item wins in champion mode, both sides get 0 ELO change. Without this, the top item's rating would inflate infinitely since it keeps winning.

7. **`repositionItemInArray`**: After a rating change, the item is physically moved in the sorted array to maintain correct rankings. This means `findIndex` lookups against the opponent pool always reflect the latest ratings.

8. **Background refresh race condition**: `removedIds` (per-target `Set` in `sessionPools`) persists across background cache refreshes. Without it, a background refresh could re-add items to the filtered pool that were already processed this session.

9. **Pool size for rank display**: `totalScenesCount` is set from `opponentPool.length`, not `allScenes.length`. This ensures "Rank #X of Y" is consistent when unrated items are excluded.

10. **Rating defaults with `??`**: `handleComparison` uses `??` (nullish coalescing) instead of `||` for rating defaults. This is semantically correct because a rating of `0` should be treated as a valid value, not as "missing".

11. **PluginApi availability**: The `PluginApi.Event` API is available on `window.PluginApi` (set by Stash's React app at boot). The plugin uses it directly without fallback — it requires a modern Stash version that supports the PluginApi.

12. **GraphQL retry scope**: Only `TypeError` (network-level) errors trigger retry. GraphQL-level errors (e.g., validation errors from Stash) are thrown immediately without retry, since those indicate a logic problem rather than a transient issue.
