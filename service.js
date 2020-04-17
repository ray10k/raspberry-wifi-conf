var async               = require("async"),
    wifi_manager        = require("./app/wifi_manager")(),
    dependency_manager  = require("./app/dependency_manager")(),
    config              = require("./config.json");

/*****************************************************************************\
    1. Check for dependencies
    2. Disable the wifi entirely, to provide a known basic state.
    3. Host a lightweight HTTP server which allows for the user to connect and
       configure the RPIs wifi connection. The interfaces exposed are RESTy so
       other applications can similarly implement their own UIs around the
       data returned.
    3. Wait for instructions to the server.
\*****************************************************************************/
async.series([

    // 1. Check if we have the required dependencies installed
    function test_deps(next_step) {
        dependency_manager.check_deps({
            "binaries": ["dnsmasq", "hostapd", "iw"],
            "files":    ["/etc/dnsmasq.conf"]
        }, function(error) {
            if (error) console.log(" * Dependency error, did you run `sudo npm run-script provision`?");
            next_step(error);
        });
    },

    // 2. Disable wifi entirely.
    function disable_wifi(next_step) {
        wifi_manager.shutdown_wireless_network(config.access_point.wifi_interface, function(error) {
            if(error) {
                console.log("... AP Enable ERROR: " + error);
            } else {
                console.log("... AP Enable Success!");
            }
            next_step(error);
        });
    },

    // 3. Host HTTP server, the "api.js" file contains all the needed logic to
    //    get a basic express server up. It uses a small angular application 
    //    which allows us to choose the wifi of our choosing.
    function start_http_server(next_step) {
        console.log("\nHTTP server running...");
        require("./app/api.js")(wifi_manager, next_step);
    },
    

], function(error) {
    if (error) {
        console.log("ERROR: " + error);
    }
});