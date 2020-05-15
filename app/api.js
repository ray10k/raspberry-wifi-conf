var path       = require("path"),
    util       = require("util"),
    iwlist     = require("./iwlist"),
    express    = require("express"),
    bodyParser = require('body-parser'),
    config     = require("../config.json"),
    http_test  = config.http_test_only;

// Helper function to log errors and send a generic status "SUCCESS"
// message to the caller
function log_error_send_success_with(success_obj, error, response) {
    if (error) {
        console.log("ERROR: " + error);
        response.send({ status: "ERROR", error: error });
    } else {
        success_obj = success_obj || {};
        success_obj["status"] = "SUCCESS";
        response.send(success_obj);
    }
    response.end();
}

/*****************************************************************************\
    Returns a function which sets up the app and our various routes.
\*****************************************************************************/
module.exports = function(wifi_manager, callback) {
    var app = express();

    // Configure the app
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));
    app.set("trust proxy", true);

    // Setup static routes to public assets
    app.use(express.static(path.join(__dirname, "public")));
    app.use(bodyParser.json());

    // Setup HTTP routes for rendering views
    app.get("/", function(request, response) {
        response.render("index");
    });

    // Setup HTTP routes for various APIs we wish to implement
    // the responses to these are typically JSON
    app.get("/api/rescan_wifi", function(request, response) {
        console.log("Server got /rescan_wifi");
        iwlist(function(error, result) {
            log_error_send_success_with(result[0], error, response);
        });
    });

    app.get("/api/wifi_info", function(request, response) {
        console.log("Server got /wifi_info");
        wifi_manager.get_wifi_info(function(error,result) {
            log_error_send_success_with(result,error,response);
        });
    });

    app.get("/api/enable_wifi", function(request, response) {
        console.log("Server got /enable_wifi");
        wifi_manager.enable_wifi_mode({}, function(error) {
            log_error_send_success_with({result:"wifi enabled"},error,response);
        });
    });

    app.post("/api/enable_wifi", function(request, response) {
        console.log("Server post: enable_wifi");
        console.log(JSON.stringify(request.body));
        var conn_info = {
            wifi_ssid:      request.body.wifi_ssid,
            wifi_passcode:  request.body.wifi_passcode,
        };

        if (typeof(request.body.force) != 'undefined')
        {
            conn_info["force"] = request.body.force;
        }
        else
        {
            conn_info["force"] = false;
        }

        // TODO: If wifi did not come up correctly, it should fail
        // currently we ignore ifup failures.
        wifi_manager.enable_wifi_mode(conn_info, function(error) {
            if (error) {
                console.log("Enable Wifi ERROR: " + error);
                console.log("Attempt to re-enable AP mode");
                wifi_manager.enable_ap_mode(config.access_point.ssid, function(error) {
                    console.log("... AP mode reset");
                });
            }
            // Success! - exit
            console.log("Wifi Enabled! - Standing by.");
            log_error_send_success_with({result:"Wifi enabled"},error,response);
        });
    });

    app.get("/api/wifi_connected", function(request, response) {
        console.log("Server got /wifi_connected");
        wifi_manager.is_wifi_enabled(function(error,result)
        {
            let response_obj = {connected:(result !== null), address:result};
            log_error_send_success_with(response_obj,error,response);
        })
    })

    app.get("/api/disable_wifi", function(request, response) {
        console.log('Server got disable_wifi');
        wifi_manager.shutdown_wireless_network("wlan0", function(error) {
            console.log("Wifi Disabled! - Standing by.");
            log_error_send_success_with({result:"Wifi enabled"},error,response);
        });
    });

    app.get("/api/enable_ap", function(request, response) {
        console.log('Server got enable_ap');
        wifi_manager.enable_ap_mode(config.access_point.ssid, function(error) {
            console.log("Starting AP mode: " + error);
            log_error_send_success_with({result:"AP enabled"},error,response);
        });
    });

    app.get("/api/wlan0_exists", function(request, response) {
        console.log('Server got wlan0_exists');
        wifi_manager.wireless_interface_exists("wlan0", function(error,result) {
            log_error_send_success_with({exists:result},error,response)
        })
    });

    app.delete("/api/known_wifi", function(request, response) {
        console.log('Server instructed to delete known wifi networks');
        wifi_manager.forget_saved_wifi(function(error) {
            log_error_send_success_with({},error,response);
        })
    });

    app.get("/api/known_wifi", function(request, response) {
        console.log('Server got known_wifi');
        wifi_manager.list_saved_wifi(function(error,result) {
            log_error_send_success_with({wifi_ssids:result},error,response);
        })
    });

    app.patch("/api/known_wifi", function(request, response) {
        console.log('Server instructed to Patch known_wifi');
        wifi_manager.reorder_saved_wifi(function(error, result) {
            log_error_send_success_with({wifi_ssids:result},error,response);
        })
    });

    // Listen on our server
    app.listen(config.server.port);
}
