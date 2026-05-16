# Implementation Plan - Stash Battle Ratings Swap

This document outlines the architecture and execution steps for implementing the Ratings Swap feature in the `stash-battle` plugin.

## 1. Overview
The feature allows toggling between **Native Mode** (star ratings) and **Battle Mode** (ELO points) by swapping values between the live `rating100` field and two custom backup fields: `rating100_native` and `rating100_battle`.

## 2. Mode Definitions & UI State
The system state is determined by the global counts of scenes with backups:

| Mode | Condition | UI Behavior |
| :--- | :--- | :--- |
| **Error State** | `countNative > 0` AND `countBattle > 0` | **Disable all controls.** Show error: "Inconsistent State Detected". |
| **Battle Mode** | `countNative > 0` AND `countBattle == 0` | **Normal operation.** All battle controls enabled. |
| **Native Mode** | `countNative == 0` AND `countBattle > 0` | **Lock Battles.** Enable only "Store Native / Load Battle". Prompt user to swap. |
| **Fresh Start** | `countNative == 0` AND `countBattle == 0` | **Setup Required.** If `countLive > 0`, enable "Store Native". Else, instruct user to rate scenes. |

## 3. Backend Implementation (Python)
File: `stash-battle.py`
Interface: `raw`

### Task: `store_native_load_battle`
- **Target**: Scenes where `live_rating != NULL` OR `rating100_battle != NULL`.
- **Logic**:
    - Skip if **Case D** (both backups exist).
    - If `native_backup == NULL` (Case A or C):
        - Move `live_rating` to `rating100_native`.
        - Move `rating100_battle` to `live_rating`.
        - Clear `rating100_battle`.

### Task: `store_battle_load_native`
- **Target**: Scenes where `live_rating != NULL` OR `rating100_native != NULL`.
- **Logic**:
    - Skip if **Case D**.
    - If `native_backup != NULL` OR `live_rating != NULL`:
        - Move `live_rating` to `rating100_battle`.
        - Move `rating100_native` to `live_rating`.
        - Clear `rating100_native`.

## 4. Manifest Updates (YAML)
File: `stash-battle.yml`
- Add `exec` pointing to `stash-battle.py`.
- Add `interface: raw`.
- Register tasks: `Store native ratings, load battle points` and `Store battle points, load native ratings`.

## 5. Frontend Implementation (JS)
File: `stash-battle.js`

### UI Changes
- Inject two swap buttons in `createMainUI`.
- Add a "Mode Banner" area to display prompts and error messages.
- Implement a shared loading spinner for swap operations.

### Logic & Safeguards
- **startupCheck()**: Queries GraphQL for global backup counts on modal open. Sets `currentMode` and updates UI visibility/enablement.
- **runSwapTask(mode)**: Triggers `runPluginTask` and starts a polling loop on `findJob` to track completion.
- **Cache Invalidation**: On success, call an enhanced `clearSceneCache()` that resets `shuffledFilteredScenes`, `shuffleIndex`, and `removedSceneIds`.
- **LocalStorage**: Clear `currentPair` and other session state after swap.

## 6. Verification Plan
- **Manual Test A**: Swap from Fresh Start (with native ratings) to Battle Mode. Verify ratings are cleared or moved correctly.
- **Manual Test B**: Perform battles, then swap back to Native Mode. Verify star ratings return and battle points are stored.
- **Safety Test**: Manually create an "Error State" (Case D) and verify the UI locks correctly.
- **Zero-Rating Test**: Verify Fresh Start instructions appear correctly when no scenes are rated.
