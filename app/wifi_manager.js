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

const wpa_supplicant_header = "ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev" + NEWLINE +
"update_config=1"+ NEWLINE +
"country=NL" + NEWLINE;

const network_block = _.template(NEWLINE + "network={"+ NEWLINE +
    "\tssid=\"{{ wifi_ssid }}\""+ NEWLINE +
    "\tpsk=\"{{ wifi_passcode }}\""+ NEWLINE + 
    "\tkey_mgmt=WPA-PSK"+ NEWLINE +
    "\tpriority={{ network_priority }}" + NEWLINE +
"}" + NEWLINE);

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
    };

    var _save_wpa_config = function(callback, wpa_supplicant_config) {
        if (typeof wpa_supplicant_config == 'undefined' || !Array.isArray(wpa_supplicant_config))
        {
            //Don't bother doing anything with an empty input.
            callback(null,[]);
            return;
        }

        let to_write = "";
        let retval = [];
        let priority = wpa_supplicant_config.length;
        wpa_supplicant_config.forEach((entry) => {
            to_write += network_block({wifi_ssid:entry.ssid,wifi_passcode:entry.passcode,network_priority:priority});
            retval.push({ssid:entry.ssid,passcode:entry.passcode});
            priority--;
        });

        async.waterfall([
            function open_file(next_step) {
                fs.open("/etc/wpa_supplicant/wpa_supplicant.conf","w",0o644,next_step);
            },
            function write_header(file_handle,next_step) {
                fs.write(file_handle,wpa_supplicant_header,(err) => next_step(err,file_handle));
            },
            function write_networks(file_handle,next_step) {
                fs.write(file_handle,to_write,(err) => next_step(err,file_handle));
            },
            function flush_file(file_handle,next_step) {
                fs.fsync(file_handle,(err) => next_step(err,file_handle));
            },
            function close_file(file_handle,next_step) {
                fs.close(file_handle,next_step);
            }            
        ],function result(err, result) {
            callback(err,retval);
        });
    }

    var _load_wpa_config = function(callback) {
        let retval = [];
        let current_block;

        if (!fs.existsSync("/etc/wpa_supplicant/wpa_supplicant.conf"))
        {
            callback(retval);
            return;
        }

        let lines = fs.readFileSync("/etc/wpa_supplicant/wpa_supplicant.conf").toString().split(NEWLINE);
        let clip = function(input) 
        {
            //strip off the first and last character of a string.
            return input.substring(1,input.length - 1);
        };

        lines.forEach((line) => {
            let clean_line = line.trim();
            if (clean_line.includes("network="))
            {
                current_block = {ssid:"",passcode:""};
            }
            else if (clean_line.includes("ssid="))
            {
                let end = clean_line.indexOf("=") + 1;
                current_block["ssid"] = clip(clean_line.substring(end));
            }
            else if (clean_line.includes("psk="))
            {
                let end = clean_line.indexOf("=") + 1;
                current_block["passcode"] = clip(clean_line.substring(end));
            }

            if (clean_line.includes("}"))
            {
                retval.push(current_block);
            }
        });
        callback(retval);
    }

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
            return callback(error, output);
        });
    },

    _reboot_wireless_network = function(wlan_iface, set_address, callback) {
        async.series([
            function down(next_step) {
                exec("sudo ifconfig " + wlan_iface + " down", function(error, stdout, stderr) {
                    if (!error) console.log("ifconfig " + wlan_iface + " down successful...");
                    next_step();
                });
            },
            function up(next_step) {
                if (set_address)
                {
                    exec("sudo ifconfig " + wlan_iface + " inet " + config.access_point.ip_addr + " up"
                    , function(error, stdout, stderr) {
                        if (!error) console.log("ifconfig " + wlan_iface + " up successful (with address)...");
                        next_step();
                    });
                }
                else
                {
                    exec("sudo ifconfig " + wlan_iface + " up"
                    , function(error, stdout, stderr) {
                        if (!error) console.log("ifconfig " + wlan_iface + " up successful (no address)...");
                        next_step();
                    });
                }
            },
            function reconfigure_wifi(next_step) {
                exec(`sudo wpa_cli -i ${wlan_iface} reconfigure`,
                function(error, stdout, stderr) {
                    if (!error) console.log(`Interface ${wlan_iface} reconfigured successfully.`);
                    next_step();
                })
            }
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

    _wireless_interface_existst = function(wlan_iface, callback) {
        async.series([
            function check(next_step) {
                exec("sudo ifconfig", function(error, stdout, stderr) {
                    var out_string = stdout.toString('utf-8');
                    next_step(error,out_string.includes(wlan_iface));
                })
            }
        ], function done(err, results) {
            callback(err,results[0]);
        });
    }

    // Wifi related functions
    // Honestly, this should be called something like "Get_wifi_ip", but oh well.
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
                    _reboot_wireless_network(config.wifi_interface, true, next_step);
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

            console.log(`starting wifi with context:\n${JSON.stringify(connection_info)}`);

            if (error) return callback(error);

            if (result_ip && !connection_info.force) {
                console.log("\nWifi connection is enabled with IP: " + result_ip);
                return callback(null);
            }

            async.series([
				function update_wpa_supplicant(next_step) {
                    console.log('writing wpa_supplicant configuration...');
                    if (typeof connection_info.wifi_ssid == 'undefined' || connection_info.wifi_ssid == "")
                    {
                        next_step();
                    }
                    else
                    {
                        _load_wpa_config((wpa_supplicant_config) =>
                        {
                            let index = 0;
                            for (;index < wpa_supplicant_config.length; index++)
                            {
                                if (wpa_supplicant_config[index].ssid == connection_info.wifi_ssid)
                                {
                                    break;
                                }
                            }

                            if (index < wpa_supplicant_config.length)
                            {
                                //Path 3: Data provided, SSID already known.
                                //Update the passcode.
                                wpa_supplicant_config[index].passcode = connection_info.wifi_passcode;
                            }
                            else
                            {
                                //Path 4: Data provided, SSID not known yet.
                                //Create a new entry for the new file.
                                wpa_supplicant_config.push({ssid:connection_info.wifi_ssid, passcode: connection_info.wifi_passcode});
                            }
                            _save_wpa_config(next_step,wpa_supplicant_config);
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

                function reboot_network_interfaces(next_step) {
                    console.log('rebooting network interface...')
                    _reboot_wireless_network(config.wifi_interface, false, next_step);
                },

            ], callback);
        });
    };

    _forget_saved_wifi = function(callback) {
        console.log("Forgetting saved wifi networks.");
        _save_wpa_config(callback,[]);
    };

    _list_saved_wifi = function(callback) {
        console.log("Listing saved wifi networks.");

        _load_wpa_config((entries) => {
            let retval = [];
            entries.forEach((entry) => {
                retval.push(entry.ssid)
            });
            callback(null,retval);
        });
    };

    _reorder_saved_wifi = function(order_list,callback) {
        console.log("Reordering saved wifi networks.");
        if (!Array.isArray(order_list))
        {
            callback("ERROR: expected an array");
            return;
        }
        
        _load_wpa_config((entries) => {
            let new_list = [];
            //Anyone order a roughly O(n^2) algorithm?
            order_list.forEach((entry) => {
                //For each item in the order-list, check if it exists in the list of known
                //networks. Disregard duplicates and unknown SSIDs.
                let index = 0;
                for (; index < entries.length; index++)
                {
                    if (entries[index].ssid == entry)
                    {
                        break;
                    }
                }

                if (index < entries.length)
                {
                    new_list.push(entries[index]);
                    entries.splice(index,1);
                }
            });
            //Push the remaining known SSIDs to the end of the list so they're last to
            //get connected to, and to ensure no SSIDs are accidentally forgotten.
            new_list = new_list.concat(entries);
            _save_wpa_config((err,result) => {_reboot_wireless_network(config.wifi_interface,false,() => callback(err,result))},new_list);
        });
    }

    return {
        get_wifi_info:           _get_wifi_info,
        reboot_wireless_network: _reboot_wireless_network,
        shutdown_wireless_network: _shutdown_wireless_network,
        wireless_interface_exists: _wireless_interface_existst,

        is_wifi_enabled:         _is_wifi_enabled,
        is_wifi_enabled_sync:    _is_wifi_enabled_sync,

        is_ap_enabled:           _is_ap_enabled,
        is_ap_enabled_sync:      _is_ap_enabled_sync,

        enable_ap_mode:          _enable_ap_mode,
        enable_wifi_mode:        _enable_wifi_mode,

        forget_saved_wifi:       _forget_saved_wifi,
        list_saved_wifi:         _list_saved_wifi,
        reorder_saved_wifi:      _reorder_saved_wifi,
    };
}
