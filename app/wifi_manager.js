var _       = require("underscore")._,
    async   = require("async"),
    fs      = require("fs"),
    exec    = require("child_process").exec,
    config  = require("../config.json"),
    readline= require("readline");
const NEWLINE = require('os').EOL;

// Better template format
_.templateSettings = {
    interpolate: /\{\{(.+?)\}\}/g,
    evaluate :   /\{\[([\s\S]+?)\]\}/g
};

const network_block = _.template("\nnetwork={\n"+
    "\tssid=\"{{ wifi_ssid }}\"\n"+
    "\tpsk=\"{{ wifi_passcode }}\"\n"+
    "\tkey_mgmt=WPA-PSK\n"+
"}\n");

// Helper function to write a given template to a file based on a given
// context
function write_template_to_file(template_path, file_name, context, callback) {
    async.waterfall([

        function read_template_file(next_step) {
            fs.readFile(template_path, {encoding: "utf8"}, next_step);
        },

        function update_file(file_txt, next_step) {
            var template = _.template(file_txt);
            fs.writeFile(file_name, template(context), next_step);
        }

    ], callback);
}

/*****************************************************************************\
    Return a set of functions which we can use to manage and check our wifi
    connection information
\*****************************************************************************/
module.exports = function() {
    // Detect which wifi driver we should use, the rtl871xdrv or the nl80211
    exec("iw list", function(error, stdout, stderr) {
        if (stderr.match(/^nl80211 not found/)) {
            config.wifi_driver_type = "rtl871xdrv";
        }
    });

    console.log(JSON.stringify(config,{},1));

    // Hack: this just assumes that the outbound interface will be "wlan0"

    // Define some globals
    var ifconfig_fields = {
        "hw_addr":         /HWaddr\s([^\s]+)/,
        "inet_addr":       /inet\s*([^\s]+)/,
    },  iwconfig_fields = {
        "ap_addr":         /Access Point:\s([^\s]+)/,
        "ap_ssid":         /ESSID:\"([^\"]+)\"/,
        "unassociated":    /(unassociated)\s+Nick/,
    },  last_wifi_info = null;

    // TODO: rpi-config-ap hardcoded, should derive from a constant

    // Get generic info on an interface
    var _get_wifi_info = function(callback) {
        var output = {
            hw_addr:      "<unknown>",
            inet_addr:    "<unknown>",
            ap_addr:      "<unknown_ap>",
            ap_ssid:      "<unknown_ssid>",
            unassociated: "<unknown>",
        };

        // Inner function which runs a given command and sets a bunch
        // of fields
        function run_command_and_set_fields(cmd, fields, callback) {
            exec(cmd, function(error, stdout, stderr) {
                if (error) return callback(error);
                
                for (var key in fields) {
                    re = stdout.match(fields[key]);
                    if (re && re.length > 1) {
                        output[key] = re[1];
                    }
                }
                
                callback(null);
            });
        }

        // Run a bunch of commands and aggregate info
        async.series([
            function run_ifconfig(next_step) {
                run_command_and_set_fields("ifconfig wlan0", ifconfig_fields, next_step);
            },
            function run_iwconfig(next_step) {
                run_command_and_set_fields("iwconfig wlan0", iwconfig_fields, next_step);
            },
        ], function(error) {
            last_wifi_info = output;
            return callback(error, output);
        });
    },

    _reboot_wireless_network = function(wlan_iface, callback) {
        async.series([
            function down(next_step) {
                exec("sudo ifconfig " + wlan_iface + " down", function(error, stdout, stderr) {
                    if (!error) console.log("ifconfig " + wlan_iface + " down successful...");
                    next_step();
                });
            },
            function up(next_step) {
                exec("sudo ifconfig " + wlan_iface + " up", function(error, stdout, stderr) {
                    if (!error) console.log("ifconfig " + wlan_iface + " up successful...");
                    next_step();
                });
            },
        ], callback);
    },

    _shutdown_wireless_network = function(wlan_iface, callback) {
        async.series([
            function down(next_step) {
                exec("sudo ifconfig " + wlan_iface + " down", function(error, stdout, stderr) {
                    if (!error) console.log("ifconfig " + wlan_iface + " down successful.");
                    next_step();
                });
            },
        ], callback);
    },

    // Wifi related functions
    _is_wifi_enabled_sync = function(info) {
        // If we are not an AP, and we have a valid
        // inet_addr - wifi is enabled!
        //console.log(_is_ap_enabled_sync(info));
        if (null        == _is_ap_enabled_sync(info) &&
            "<unknown>" != info["inet_addr"]         &&
            "Not-Associated" != info["ap_addr"] &&
            "<unknown_ap>" != info["ap_addr"]  ) {
            return info["inet_addr"];
        }
        return null;
    },

    _is_wifi_enabled = function(callback) {
        _get_wifi_info(function(error, info) {
            if (error) return callback(error, null);
            return callback(null, _is_wifi_enabled_sync(info));
        });
    },

    // Access Point related functions
    _is_ap_enabled_sync = function(info) {
        
        var is_ap = info["ap_ssid"] == config.access_point.ssid;
        
        if(is_ap == true){
			return info["ap_ssid"];
		}
		else{
			
			return null;
		}
        
    },

    _is_ap_enabled = function(callback) {
        _get_wifi_info(function(error, info) {
            if (error) return callback(error, null);
            return callback(null, _is_ap_enabled_sync(info));
        });
    },

    // Enables the accesspoint w/ bcast_ssid. This assumes that both
    // dnsmasq and hostapd are installed using:
    // $sudo npm run-script provision
    _enable_ap_mode = function(bcast_ssid, callback) {
        _is_ap_enabled(function(error, result_addr) {
            if (error) {
                console.log("ERROR: " + error);
                return callback(error);
            }

            if (result_addr && !config.access_point.force_reconfigure) {
                console.log("\nAccess point is enabled with ADDR: " + result_addr);
                return callback(null);
            } else if (config.access_point.force_reconfigure) {
                console.log("\nForce reconfigure enabled - reset AP");
            } else {
                console.log("\nAP is not enabled yet... enabling...");
            }

            var context = config.access_point;
            context["enable_ap"] = true;
            context["wifi_driver_type"] = config.wifi_driver_type;

            console.log(`starting ap mode with context:\n${JSON.stringify(context)}`);

            // Here we need to actually follow the steps to enable the ap
            async.series([

                // Enable the access point ip and netmask + static
                // DHCP for the wlan0 interface
                function update_interfaces(next_step) {
                    console.log('writing dhcpcd config...');
                    write_template_to_file(
                        "./assets/etc/dhcpcd/dhcpcd.ap.template",
                        "/etc/dhcpcd.conf",
                        context, next_step);
                },


                // Enable the interface in the dhcp server
                function update_dhcp_interface(next_step) {
                    console.log('writing dnsmasq config...')
                    write_template_to_file(
                        "./assets/etc/dnsmasq/dnsmasq.ap.template",
                        "/etc/dnsmasq.conf",
                        context, next_step);
                },

                // Enable hostapd.conf file
                function update_hostapd_conf(next_step) {
                    console.log('writing hostapd config...')
                    write_template_to_file(
                        "./assets/etc/hostapd/hostapd.conf.template",
                        "/etc/hostapd/hostapd.conf",
                        context, next_step);
                },

                function restart_dhcp_service(next_step) {
                    console.log('restarting dhcpcd...');
                    exec("sudo systemctl restart dhcpcd", function(error, stdout, stderr) {
                        if (!error) console.log("... dhcpcd server restarted!");
                        else console.log("... dhcpcd server failed! - " + stdout);
                        next_step();
                    });
                },

                
                function reboot_network_interfaces(next_step) {
                    console.log('rebooting network interface...')
                    _reboot_wireless_network(config.wifi_interface, next_step);
                },

                function restart_hostapd_service(next_step) {
                    console.log('restarting hostapd...');
                    exec("sudo systemctl restart hostapd", function(error, stdout, stderr) {
                        //console.log(stdout);
                        if (!error) console.log("... hostapd restarted!");
                        else console.log("... hostapd restart failed!");
                        next_step();
                    });
                },
                
                function restart_dnsmasq_service(next_step) {
                    console.log('restarting dnsmasq...');
                    exec("sudo systemctl restart dnsmasq", function(error, stdout, stderr) {
                        if (!error) console.log("... dnsmasq server restarted!");
                        else console.log("... dnsmasq server failed! - " + stdout);
                        next_step();
                    });
                },
                

            ], callback);
        });
    },

    // Disables AP mode and reverts to wifi connection
    _enable_wifi_mode = function(connection_info, callback) {

        _is_wifi_enabled(function(error, result_ip) {
            if (error) return callback(error);

            if (result_ip) {
                console.log("\nWifi connection is enabled with IP: " + result_ip);
                return callback(null);
            }

            console.log(`starting wifi with context:\n${JSON.stringify(connection_info)}`);

            async.series([
                function down(next_step) {
                    console.log('taking down network adapter')
                    exec("sudo ifconfig " + config.access_point.wifi_interface + " down", function(error, stdout, stderr) {
                        if (!error) console.log("ifconfig " + config.access_point.wifi_interface + " down successful...");
                        next_step();
                    });
                },
				function update_wpa_supplicant(next_step) {
                    console.log('writing wpa_supplicant configuration...');
                    if (typeof connection_info.wifi_ssid == 'undefined' || connection_info.wifi_ssid == "")
                    {
                        //Don't change WPA supplicant config.
                        next_step();
                    }
                    //First: If no WPA supplicant configuration exists, copy in the default template.
                    else if (!fs.existsSync("/etc/wpa_supplicant/wpa_supplicant.conf"))
                    {
                    write_template_to_file(
                        "./assets/etc/wpa_supplicant/wpa_supplicant.conf.template",
                        "/etc/wpa_supplicant/wpa_supplicant.conf",
                        connection_info, next_step);
                    }
                    else
                    {
                        //Second: WPA supplicant configuration exists. Search the file for the given
                        //ssid.
                        let exists = false;
                        let lines = [];
                        let reader = readline.createInterface(
                            {input:fs.createReadStream("/etc/wpa_supplicant/wpa_supplicant.conf")}
                        );
                        reader.on('line', function(line) {
                            lines.push(line);
                            if (line.includes('ssid="'+connection_info.wifi_ssid+'"'))
                            {
                                exists = true;
                            }
                        });

                        reader.on('close', function() {
                            if (exists)
                            {
                                //Third: The ssid already exists in the file. Update the passkey.
                                //Note: will break if the passkey isn't in the line immediately
                                //after the one with the ssid.
                                let i = -1;
                                lines.forEach((value,index) => {
                                    if (value.includes('ssid="'+connection_info.wifi_ssid+'"'))
                                    {
                                        i = index + 1;
                                    }
                                });
                                lines[i] = "\tpsk=\""+connection_info.wifi_passcode+'"';
                                let stream = fs.createWriteStream("/etc/wpa_supplicant/wpa_supplicant.conf");
                                lines.forEach((line) => {
                                    stream.write(line);
                                    stream.write(NEWLINE);
                                });
                                stream.close();
                            }
                            else
                            {
                                //Fourth: the ssid doesn't exist in the file yet. Fill in a new
                                //network block, and append it to the end of the file.
                                let stream = fs.createWriteStream("/etc/wpa_supplicant/wpa_supplicant.conf",{flags:"a"});
                                stream.write(network_block(connection_info));
                                stream.close();
                            }
                            next_step();
                        });
                    }
				},

                function update_interfaces(next_step) {
                    console.log('writing dhcpcd configuration...');
                    write_template_to_file(
                        "./assets/etc/dhcpcd/dhcpcd.station.template",
                        "/etc/dhcpcd.conf",
                        connection_info, next_step);
                },

                // Enable the interface in the dhcp server
                function update_dhcp_interface(next_step) {
                    console.log('writing dnsmasq configuration...');
                    write_template_to_file(
                        "./assets/etc/dnsmasq/dnsmasq.station.template",
                        "/etc/dnsmasq.conf",
                        connection_info, next_step);
                },

                // Enable hostapd.conf file
                function update_hostapd_conf(next_step) {
                    console.log('writing hostapd configuration...');
                    write_template_to_file(
                        "./assets/etc/hostapd/hostapd.conf.station.template",
                        "/etc/hostapd/hostapd.conf",
                        connection_info, next_step);
                },

				function restart_dnsmasq_service(next_step) {
                    console.log('stopping dnsmasq service...');
                    exec("sudo systemctl stop dnsmasq", function(error, stdout, stderr) {
                        if (!error) console.log("... dnsmasq server stopped!");
                        else console.log("... dnsmasq server failed! - " + stdout);
                        next_step();
                    });
                },
                
                function restart_hostapd_service(next_step) {
                    console.log('stopping hostapd service...');
                    exec("sudo systemctl stop hostapd", function(error, stdout, stderr) {
                        if (!error) console.log("... hostapd stopped!");
                        next_step();
                    });
                },
                
                function restart_dhcp_service(next_step) {
                    console.log('restarting dhcpcd service...');
                    exec("sudo systemctl restart dhcpcd", function(error, stdout, stderr) {
                        if (!error) console.log("... dhcpcd server restarted!");
                        else console.log("... dhcpcd server failed! - " + stdout);
                        next_step();
                    });
                },

                function up(next_step) {
                    console.log('Bringing up network adapter...');
                    exec("sudo ifconfig " 
                        + config.access_point.wifi_interface 
                        + " up inet "
                        + config.access_point.ip_addr, function(error, stdout, stderr) {
                        if (!error) 
                        {
                            console.log("ifconfig "
                            + config.access_point.wifi_interface 
                            + " up inet "
                            + config.access_point.ip_addr
                            + " successful." );
                        }
                        else
                        {
                            console.error("ERROR: "+error);
                        }
                        next_step();
                    });
                },

            ], callback);
        });

    };

    return {
        get_wifi_info:           _get_wifi_info,
        reboot_wireless_network: _reboot_wireless_network,
        shutdown_wireless_network: _shutdown_wireless_network,

        is_wifi_enabled:         _is_wifi_enabled,
        is_wifi_enabled_sync:    _is_wifi_enabled_sync,

        is_ap_enabled:           _is_ap_enabled,
        is_ap_enabled_sync:      _is_ap_enabled_sync,

        enable_ap_mode:          _enable_ap_mode,
        enable_wifi_mode:        _enable_wifi_mode,
    };
}
