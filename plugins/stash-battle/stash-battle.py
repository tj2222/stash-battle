import sys
import json
import os
import html
import re
from stashapi.stashapp import StashInterface

def generate_html(rated, unranked):
    # Standard trophy icons for top-3
    def get_rank_badge(rank):
        if rank == 1:
            return '<span class="badge bg-warning text-dark px-2 py-1"><span class="fa fa-trophy me-1"></span> 1</span>'
        elif rank == 2:
            return '<span class="badge bg-secondary px-2 py-1"><span class="fa fa-trophy me-1"></span> 2</span>'
        elif rank == 3:
            return '<span class="badge text-white px-2 py-1" style="background-color: #cd7f32;"><span class="fa fa-trophy me-1"></span> 3</span>'
        else:
            return f'<span class="text-muted fw-bold ps-2">{rank}</span>'

    # Build Ranked Rows
    rated_rows_html = ""
    for idx, p in enumerate(rated):
        rank = idx + 1
        rank_badge = get_rank_badge(rank)
        
        name_escaped = html.escape(p["name"])
        disamb_escaped = html.escape(p["disambiguation"])
        image_escaped = html.escape(p["image_path"]) if p["image_path"] else ""
        
        display_name = name_escaped
        if p["disambiguation"]:
            display_name = f'{name_escaped} <span class="text-muted small">({disamb_escaped})</span>'
            
        img_html = ""
        if image_escaped:
            img_html = f'<img src="{image_escaped}" class="pwr-leaderboard-img me-2" alt="">'
        else:
            img_html = '<div class="pwr-leaderboard-img d-inline-flex align-items-center justify-content-center bg-dark text-muted me-2" style="font-size: 1.2rem;"><span class="fa fa-user"></span></div>'
            
        provisional = "?" if p["battle_count"] < 8 else ""
        rating_str = f'{p["rating"]}{provisional}'
        
        rated_rows_html += f"""
        <tr class="pwr-leaderboard-row align-middle">
            <td class="text-center" style="width: 80px;">{rank_badge}</td>
            <td class="pwr-performer-name-col">
                <a href="/performers/{p["id"]}" class="d-flex align-items-center text-decoration-none text-white fw-semibold">
                    {img_html}
                    <span>{display_name}</span>
                </a>
            </td>
            <td class="text-center fw-bold text-info" style="width: 120px;">{rating_str}</td>
            <td class="text-center text-muted" style="width: 120px;">{p["battle_count"]}</td>
            <td class="text-center text-muted" style="width: 120px;">{p["scene_count"]}</td>
        </tr>
        """
        
    # Build Unranked Rows
    unranked_rows_html = ""
    for p in unranked:
        name_escaped = html.escape(p["name"])
        disamb_escaped = html.escape(p["disambiguation"])
        image_escaped = html.escape(p["image_path"]) if p["image_path"] else ""
        
        display_name = name_escaped
        if p["disambiguation"]:
            display_name = f'{name_escaped} <span class="text-muted small">({disamb_escaped})</span>'
            
        img_html = ""
        if image_escaped:
            img_html = f'<img src="{image_escaped}" class="pwr-leaderboard-img me-2" alt="">'
        else:
            img_html = '<div class="pwr-leaderboard-img d-inline-flex align-items-center justify-content-center bg-dark text-muted me-2" style="font-size: 1.2rem;"><span class="fa fa-user"></span></div>'
            
        unranked_rows_html += f"""
        <tr class="pwr-leaderboard-row align-middle">
            <td class="pwr-performer-name-col">
                <a href="/performers/{p["id"]}" class="d-flex align-items-center text-decoration-none text-white fw-semibold">
                    {img_html}
                    <span>{display_name}</span>
                </a>
            </td>
            <td class="text-center text-muted" style="width: 150px;">{p["scene_count"]}</td>
        </tr>
        """

    # Empty State Placeholders
    if not rated_rows_html:
        rated_table_body = """
        <tr>
            <td colspan="5" class="text-center py-5 text-muted">
                <span class="fa fa-user-circle fa-3x mb-3 text-secondary d-block"></span>
                No ranked performers. Complete some battles to rank performers!
            </td>
        </tr>
        """
    else:
        rated_table_body = rated_rows_html

    if not unranked_rows_html:
        unranked_table_body = """
        <tr>
            <td colspan="2" class="text-center py-5 text-muted">
                <span class="fa fa-check-circle fa-3x mb-3 text-success d-block"></span>
                No unranked performers left!
            </td>
        </tr>
        """
    else:
        unranked_table_body = unranked_rows_html

    # Complete HTML output
    html_out = f"""
    <div class="row align-items-center mb-3">
        <div class="col-8">
            <h2 class="mb-1 text-white fw-bold">Performer Leaderboard</h2>
            <p class="text-muted mb-0">Rankings based on ELO ratings from head-to-head performer battles</p>
        </div>
        <div class="col-4 text-end">
            <button id="pwr-leaderboard-back-btn" class="btn btn-secondary btn-sm">
                <span class="fa fa-chevron-left me-1"></span> Back to Stash
            </button>
        </div>
    </div>

    <style>
        .pwr-leaderboard-row:hover {{
            background-color: rgba(138, 155, 168, 0.1) !important;
        }}
        .pwr-leaderboard-img {{
            width: 300px;
            height: 450px;
            object-fit: cover;
            border-radius: 4px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }}
        .nav-tabs .nav-link {{
            cursor: pointer;
            border-bottom: 2px solid transparent;
            color: #aaa;
            padding: 8px 16px;
            border-top: none;
            border-left: none;
            border-right: none;
            background: transparent;
            font-weight: 600;
        }}
        .nav-tabs .nav-link:hover {{
            color: #fff;
            border-bottom-color: rgba(255, 255, 255, 0.3);
        }}
        .nav-tabs .nav-link.active {{
            color: #48aff0 !important;
            border-bottom-color: #48aff0 !important;
            background: transparent !important;
        }}
    </style>

    <div class="card mb-4 bg-transparent border-0">
        <div class="card-body p-0">
            <div class="row mb-3 g-2 align-items-center">
                <div class="col-md-7">
                    <ul class="nav nav-tabs border-bottom-0 mb-0" id="leaderboardTabs" role="tablist">
                        <li class="nav-item" role="presentation">
                            <button class="nav-link active" id="ranked-tab" onclick="showTab('ranked')" type="button" role="tab">
                                Ranked Performers <span class="badge bg-primary ms-1">{len(rated)}</span>
                            </button>
                        </li>
                        <li class="nav-item" role="presentation">
                            <button class="nav-link" id="unranked-tab" onclick="showTab('unranked')" type="button" role="tab">
                                Unranked Performers <span class="badge bg-secondary ms-1">{len(unranked)}</span>
                            </button>
                        </li>
                    </ul>
                </div>
                <div class="col-md-5">
                    <div class="input-group input-group-sm">
                        <span class="input-group-text bg-dark border-secondary text-muted"><span class="fa fa-search"></span></span>
                        <input type="text" id="leaderboard-search" class="form-control bg-dark text-white border-secondary" placeholder="Search performers..." onkeyup="filterTable()">
                    </div>
                </div>
            </div>

            <!-- Tab Content -->
            <div class="tab-content" id="leaderboardTabContent">
                <!-- Ranked Pane -->
                <div class="tab-pane fade show active d-block" id="ranked" role="tabpanel">
                    <div class="pwr-no-matches d-none text-center py-5 text-muted">
                        <span class="fa fa-search fa-3x mb-3 text-secondary d-block"></span>
                        No matching performers found in Ranked.
                    </div>
                    <div class="table-responsive">
                        <table class="table table-striped table-hover align-middle border-0">
                            <thead>
                                <tr class="text-uppercase text-muted" style="font-size: 0.8rem; letter-spacing: 0.5px;">
                                    <th class="text-center" style="width: 80px; border-bottom: 1px solid #414c53;">Rank</th>
                                    <th style="border-bottom: 1px solid #414c53;">Performer</th>
                                    <th class="text-center" style="width: 120px; border-bottom: 1px solid #414c53;">Rating</th>
                                    <th class="text-center" style="width: 120px; border-bottom: 1px solid #414c53;">Battles</th>
                                    <th class="text-center" style="width: 120px; border-bottom: 1px solid #414c53;">Scenes</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rated_table_body}
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Unranked Pane -->
                <div class="tab-pane fade d-none" id="unranked" role="tabpanel">
                    <div class="pwr-no-matches d-none text-center py-5 text-muted">
                        <span class="fa fa-search fa-3x mb-3 text-secondary d-block"></span>
                        No matching performers found in Unranked.
                    </div>
                    <div class="table-responsive">
                        <table class="table table-striped table-hover align-middle border-0">
                            <thead>
                                <tr class="text-uppercase text-muted" style="font-size: 0.8rem; letter-spacing: 0.5px;">
                                    <th style="border-bottom: 1px solid #414c53;">Performer</th>
                                    <th class="text-center" style="width: 150px; border-bottom: 1px solid #414c53;">Scenes</th>
                                </tr>
                            </thead>
                            <tbody>
                                {unranked_table_body}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        function showTab(tabId) {{
            // Hide all tab panes
            document.querySelectorAll('.tab-pane').forEach(function(el) {{
                el.classList.remove('show', 'active', 'd-block');
                el.classList.add('d-none');
            }});

            // Show target tab pane
            var activePane = document.getElementById(tabId);
            if (activePane) {{
                activePane.classList.remove('d-none');
                activePane.classList.add('show', 'active', 'd-block');
            }}

            // Update active status on tab triggers
            document.querySelectorAll('.nav-tabs .nav-link').forEach(function(el) {{
                el.classList.remove('active');
            }});
            var activeBtn = document.getElementById(tabId + '-tab');
            if (activeBtn) {{
                activeBtn.classList.add('active');
            }}

            // Reset search input and filters
            document.getElementById('leaderboard-search').value = '';
            filterTable();
        }}

        function filterTable() {{
            var query = document.getElementById('leaderboard-search').value.toLowerCase().trim();
            var activePane = document.querySelector('.tab-pane.active');
            if (!activePane) return;

            var rows = activePane.querySelectorAll('tbody tr');
            var matchCount = 0;

            rows.forEach(function(row) {{
                // Skip if this is the "no performers" empty state row
                if (row.cells.length === 1 && row.cells[0].colSpan > 1) {{
                    row.classList.remove('d-none');
                    matchCount++;
                    return;
                }}

                var nameCell = row.querySelector('.pwr-performer-name-col');
                if (!nameCell) return;

                var nameText = nameCell.innerText.toLowerCase();
                if (nameText.indexOf(query) !== -1) {{
                    row.classList.remove('d-none');
                    matchCount++;
                }} else {{
                    row.classList.add('d-none');
                }}
            }});

            // Toggle no matches notice
            var noMatchesEl = activePane.querySelector('.pwr-no-matches');
            var tableEl = activePane.querySelector('.table-responsive');
            if (matchCount === 0 && query !== '') {{
                if (noMatchesEl) noMatchesEl.classList.remove('d-none');
                if (tableEl) tableEl.classList.add('d-none');
            }} else {{
                if (noMatchesEl) noMatchesEl.classList.add('d-none');
                if (tableEl) tableEl.classList.remove('d-none');
            }}
        }}
    </script>
    """
    return html_out

def main():
    try:
        # Read standard input details
        json_input = json.loads(sys.stdin.read())
        
        server = json_input.get("server_connection", {})
        stash = StashInterface(server)
        
        # Query all performers with fields
        performers = stash.find_performers(
            filter={"per_page": -1},
            fragment="id name disambiguation image_path rating100 scene_count custom_fields"
        )
        
        rated = []
        unranked = []
        
        for p in performers:
            cf = p.get("custom_fields") or {}
            rating = cf.get("battle-rating")
            count = cf.get("battle-count")
            
            try:
                rating_val = int(rating) if rating is not None else None
            except (ValueError, TypeError):
                rating_val = None
                
            try:
                count_val = int(count) if count is not None else 0
            except (ValueError, TypeError):
                count_val = 0
                
            p_data = {
                "id": p["id"],
                "name": p.get("name") or "",
                "disambiguation": p.get("disambiguation") or "",
                "image_path": p.get("image_path") or "",
                "scene_count": p.get("scene_count") or 0,
                "rating": rating_val,
                "battle_count": count_val
            }
            
            if rating_val is not None and count_val > 0:
                rated.append(p_data)
            else:
                unranked.append(p_data)
                
        # Sort rated by rating DESC, name ASC. Sort unranked by name ASC.
        rated.sort(key=lambda x: (-x["rating"], x["name"].lower()))
        unranked.sort(key=lambda x: x["name"].lower())
        
        # Compile static leaderboard HTML content
        html_content = generate_html(rated, unranked)
        
        # Resolve target plugin directory
        plugin_dir = server.get("PluginDir") or server.get("plugin_dir") or os.path.dirname(os.path.abspath(__file__))
        assets_dir = os.path.join(plugin_dir, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        
        output_path = os.path.join(assets_dir, "leaderboard.html")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(html_content)
            
        print(json.dumps({"output": "success"}))
        
    except Exception as e:
        error_msg = f"Error generating performer leaderboard: {str(e)}"
        print(json.dumps({"error": error_msg}), file=sys.stderr)
        print(json.dumps({"error": error_msg}))

if __name__ == "__main__":
    main()
