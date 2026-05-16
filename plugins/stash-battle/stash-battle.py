import sys
import json
import stashapi.log as log
from stashapi.stashapp import StashInterface

def main():
    log.info("Stash Battle plugin task started")
    try:
        # Read input from Stash (Interface: raw)
        input_data = sys.stdin.read()
        if not input_data:
            log.error("No input data received on stdin")
            sys.exit(1)
            
        json_input = json.loads(input_data)
    except Exception as e:
        log.error(f"Failed to parse input: {e}")
        sys.exit(1)

    try:
        conn = json_input.get('server_connection')
        if not conn:
            log.error("No server connection provided in plugin input")
            sys.exit(1)

        stash = StashInterface(conn)
        
        # Extract task name from arguments
        # Tasks are registered in stash-battle.yml
        task_name = json_input.get('args', {}).get('mode')
        log.info(f"Executing task: {task_name}")
        
        if task_name == "store_native_load_battle":
            store_native_load_battle(stash)
        elif task_name == "store_battle_load_native":
            store_battle_load_native(stash)
        else:
            log.error(f"Unknown task mode: {task_name}")
            
        # Return empty JSON to satisfy raw interface
        print("{}")
            
    except Exception as e:
        log.error(f"Unexpected error during task execution: {e}")
        import traceback
        log.error(traceback.format_exc())
        sys.exit(1)

def store_native_load_battle(stash):
    log.info("Starting task: Store native ratings, load battle points...")
    
    # Target: Scenes where live_rating != NULL OR rating100_battle != NULL
    # We use find_scenes with filters
    scenes = stash.find_scenes(
        f={
            "rating100": {"modifier": "NOT_NULL", "value": 0}
        },
        fragment="id rating100 custom_fields"
    )
    
    # Also find scenes where rating100_battle is set but live might be NULL
    # Stash filter for custom fields is a bit tricky, we'll just fetch all scenes 
    # with either condition if possible, or merge results.
    # For simplicity in this plugin, we'll fetch scenes with rating100 != NULL
    # and then manually check for those with rating100_battle.
    
    # Better: Fetch scenes with rating100_battle != NULL
    battle_stored_scenes = stash.find_scenes(
        f={
            "custom_fields": {
                "field": "rating100_battle",
                "modifier": "NOT_NULL",
                "value": []
            }
        },
        fragment="id rating100 custom_fields"
    )
    
    # Merge scenes (deduplicate by ID)
    scene_map = {s['id']: s for s in scenes}
    for s in battle_stored_scenes:
        scene_map[s['id']] = s
        
    total = len(scene_map)
    log.info(f"Processing {total} candidate scenes...")
    
    count = 0
    for scene_id, scene in scene_map.items():
        count += 1
        if count % 50 == 0:
            log.progress(count / total)
            
        live = scene.get('rating100')
        custom = scene.get('custom_fields', {})
        native_stored = custom.get('rating100_native')
        battle_stored = custom.get('rating100_battle')
        
        # Case D: Both exist - skip
        if native_stored is not None and battle_stored is not None:
            log.warning(f"Skipping Scene {scene_id}: Inconsistent state (Both backups exist)")
            continue
            
        # If native is already stored (Case B), skip
        if native_stored is not None:
            continue
            
        # Case A or C: Native is currently live
        # Logic: Store live -> native, Load battle -> live, Clear battle
        new_scene = {"id": scene_id, "custom_fields": {"partial": {}, "remove": []}}
        
        # Store live to native
        new_scene['custom_fields']['partial']['rating100_native'] = live
        
        # Load battle to live
        new_scene['rating100'] = battle_stored
        
        # Clear battle store
        new_scene['custom_fields']['remove'].append('rating100_battle')
        
        stash.update_scene(new_scene)

    log.info("Task completed successfully.")

def store_battle_load_native(stash):
    log.info("Starting task: Store battle points, load native ratings...")
    
    # Target: Scenes where live_rating != NULL OR rating100_native != NULL
    scenes = stash.find_scenes(
        f={
            "rating100": {"modifier": "NOT_NULL", "value": 0}
        },
        fragment="id rating100 custom_fields"
    )
    
    native_stored_scenes = stash.find_scenes(
        f={
            "custom_fields": {
                "field": "rating100_native",
                "modifier": "NOT_NULL",
                "value": []
            }
        },
        fragment="id rating100 custom_fields"
    )
    
    scene_map = {s['id']: s for s in scenes}
    for s in native_stored_scenes:
        scene_map[s['id']] = s
        
    total = len(scene_map)
    log.info(f"Processing {total} candidate scenes...")
    
    count = 0
    for scene_id, scene in scene_map.items():
        count += 1
        if count % 50 == 0:
            log.progress(count / total)
            
        live = scene.get('rating100')
        custom = scene.get('custom_fields', {})
        native_stored = custom.get('rating100_native')
        battle_stored = custom.get('rating100_battle')
        
        # Case D: Both exist - skip
        if native_stored is not None and battle_stored is not None:
            log.warning(f"Skipping Scene {scene_id}: Inconsistent state (Both backups exist)")
            continue
            
        # Case B: Native is stored, live is battle
        # Case A/C: Native is NULL, live is native (but user wants to swap anyway)
        if native_stored is not None or live is not None:
            new_scene = {"id": scene_id, "custom_fields": {"partial": {}, "remove": []}}
            
            # Store live to battle
            new_scene['custom_fields']['partial']['rating100_battle'] = live
            
            # Load native to live
            new_scene['rating100'] = native_stored
            
            # Clear native store
            new_scene['custom_fields']['remove'].append('rating100_native')
            
            stash.update_scene(new_scene)
        else:
            # Case A/C where both are NULL, nothing to do
            continue

    log.info("Task completed successfully.")

if __name__ == "__main__":
    main()
