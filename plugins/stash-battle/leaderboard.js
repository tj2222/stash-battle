(function () {
  "use strict";

  const React = window.PluginApi.React;
  const PluginApi = window.PluginApi;
  const { NavLink, useHistory } = PluginApi.libraries.ReactRouterDOM || {};
  const { Icon } = PluginApi.components || {};
  const { faTrophy } = PluginApi.libraries.FontAwesomeSolid || {};

  console.log("[Stash Battle] Initializing Performer Leaderboard SPA component...");

  // React component to render the performer ELO leaderboard
  const LeaderboardPage = (props) => {
    const [htmlContent, setHtmlContent] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState("");

    const history = useHistory ? useHistory() : (props.history || null);

    React.useEffect(() => {
      let active = true;

      async function loadLeaderboard() {
        try {
          if (active) {
            setLoading(true);
            setError("");
          }

          // 1. Trigger the background plugin task to compile and update the leaderboard HTML file
          await fetch("/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!) {
                runPluginTask(plugin_id: $plugin_id, task_name: $task_name)
              }`,
              variables: {
                plugin_id: "stash-battle",
                task_name: "Generate Leaderboard"
              }
            })
          });

          // 2. Fetch the compiled HTML template from our asset endpoint.
          // We use a light retry mechanism to wait for the Python background task to complete writing.
          let html = "";
          let fetched = false;
          for (let i = 0; i < 5; i++) {
            try {
              const res = await fetch("/plugin/stash-battle/assets/leaderboard.html");
              if (res.ok) {
                html = await res.text();
                fetched = true;
                break;
              }
            } catch (e) {
              console.warn("[Stash Battle] Retry fetch error:", e);
            }
            // Wait 200ms before retrying
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          if (!fetched) {
            throw new Error("Failed to load compiled leaderboard HTML from Stash assets server. Please try reloading the page.");
          }

          if (active) {
            setHtmlContent(html);
            setLoading(false);
          }
        } catch (err) {
          console.error("[Stash Battle] Leaderboard loading error:", err);
          if (active) {
            setError(err.message || "An unknown error occurred while compiling the leaderboard.");
            setLoading(false);
          }
        }
      }

      loadLeaderboard();

      return () => {
        active = false;
      };
    }, []);

    // Post-render step: execute embedded scripts & bind events once HTML is in the DOM
    React.useEffect(() => {
      if (loading || error || !htmlContent) return;

      const container = document.getElementById("pwr-leaderboard-container");
      if (container) {
        // React dangerouslySetInnerHTML does not execute embedded script tags.
        // We extract them, create new script tags, and append them globally so the search
        // and tab switching functions (showTab, filterTable) are initialized correctly in the window scope.
        const scripts = container.getElementsByTagName("script");
        for (let i = 0; i < scripts.length; i++) {
          try {
            const script = scripts[i];
            const newScript = document.createElement("script");
            newScript.text = script.textContent;
            document.body.appendChild(newScript).parentNode.removeChild(newScript);
          } catch (e) {
            console.error("[Stash Battle] Error executing inline script:", e);
          }
        }

        // Override direct DOM back buttons with React Router navigation to keep SPA seamless
        const backBtn = container.querySelector("#pwr-leaderboard-back-btn");
        if (backBtn && history) {
          backBtn.onclick = null;
          backBtn.addEventListener("click", (e) => {
            e.preventDefault();
            history.push("/scenes");
          });
        }
      }

      // Cleanup global handlers on unmount to keep global namespace clean
      return () => {
        delete window.showTab;
        delete window.filterTable;
      };
    }, [htmlContent, loading, error, history]);

    if (loading) {
      return React.createElement(
        "div",
        {
          className: "container-fluid d-flex flex-column align-items-center justify-content-center py-5",
          style: { minHeight: "50vh" }
        },
        React.createElement("div", { className: "spinner-border text-primary mb-3", role: "status" }),
        React.createElement("div", { className: "text-muted" }, "Generating and loading ELO leaderboard...")
      );
    }

    if (error) {
      return React.createElement(
        "div",
        { className: "container-fluid py-5" },
        React.createElement(
          "div",
          { className: "alert alert-danger mx-auto", style: { maxWidth: "600px" } },
          React.createElement("h4", { className: "alert-heading" }, "Error Loading Leaderboard"),
          React.createElement("p", null, error),
          React.createElement("hr", null),
          React.createElement(
            "button",
            {
              className: "btn btn-outline-danger btn-sm",
              onClick: () => window.location.reload()
            },
            "Retry"
          )
        )
      );
    }

    // TODO(security): The HTML loaded is compiled server-side by stash-battle.py.
    // All untrusted user-controlled strings (names, disambiguations, image paths) are strictly escaped on the server using html.escape() to completely prevent XSS.
    // Thus, using dangerouslySetInnerHTML is secure and fully justified.
    return React.createElement("div", {
      id: "pwr-leaderboard-container",
      className: "container-fluid py-3",
      dangerouslySetInnerHTML: { __html: htmlContent }
    });
  };

  // Register our leaderboard component under Stash SPA route
  try {
    PluginApi.register.route("/performer-battle-leaderboard", LeaderboardPage);
    console.log("[Stash Battle] SPA Route /performer-battle-leaderboard registered successfully");
  } catch (e) {
    console.error("[Stash Battle] Failed to register SPA route:", e);
  }

  // Patch the main navigation menu to append our new Leaderboard menu item
  try {
    PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
      try {
        // Check for duplicate nav elements to prevent double rendering
        const childrenArray = React.Children.toArray(props.children);
        const hasLeaderboard = childrenArray.some(child => {
          return child?.props?.to === "/performer-battle-leaderboard" ||
                 child?.props?.children?.props?.to === "/performer-battle-leaderboard";
        });
        if (hasLeaderboard) {
          return [props];
        }
      } catch (e) {
        console.warn("[Stash Battle] Error checking duplicate navigation link:", e);
      }

      const label = "Leaderboard";
      const iconEl = Icon && faTrophy
        ? React.createElement(Icon, { key: "icon", icon: faTrophy, className: "mb-1 mb-xl-0 me-xl-2" })
        : null;
      const labelEl = React.createElement("span", { key: "label" }, label);

      const navLinkElement = NavLink
        ? React.createElement(NavLink, {
            exact: true,
            to: "/performer-battle-leaderboard",
            activeClassName: "active",
            className: "btn minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center"
          }, iconEl, labelEl)
        : React.createElement("a", {
            href: "#/performer-battle-leaderboard",
            className: "btn minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center"
          }, iconEl, labelEl);

      const node = React.createElement("div", {
        key: "pwr-leaderboard-menu-item",
        className: "col-4 col-sm-3 col-md-2 col-lg-auto"
      }, navLinkElement);

      return [{ children: React.createElement(React.Fragment, null,
        props.children,
        node) }];
    });
    console.log("[Stash Battle] MainNavBar.MenuItems patched successfully");
  } catch (e) {
    console.error("[Stash Battle] Failed to patch MainNavBar:", e);
  }
})();
