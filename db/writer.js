/*jslint node: true */
"use strict";
var _ = require('lodash');
var async = require('async');
var constants = require("../config/constants.js");
var conf = require("../config/conf.js");
var storage = require('../db/storage.js');
var db = require('../db/db.js');
var objectHash = require("../base/object_hash.js");
var mutex = require('../base/mutex.js');
var main_chain = require("../mc/main_chain.js");
var Definition = require("../encrypt/definition.js");
var eventBus = require('../base/event_bus.js');
var profiler = require('../base/profiler.js');
var deposit = require( '../sc/deposit.js' );

var count_writes = 0;
var count_units_in_prev_analyze = 0;

function saveJoint(objJoint, objValidationState, preCommitCallback, onDone) {
	var objUnit = objJoint.unit;
	console.log("\nsaving unit "+objUnit.unit);
	profiler.start();
	
	db.takeConnectionFromPool(function(conn){
		var arrQueries = [];
		conn.addQuery(arrQueries, "BEGIN");
		
		// additional queries generated by the validator, used only when received a doublespend
		for (var i=0; i<objValidationState.arrAdditionalQueries.length; i++){
			var objAdditionalQuery = objValidationState.arrAdditionalQueries[i];
			console.log("----- applying additional queries: "+objAdditionalQuery.sql);
			conn.addQuery(arrQueries, objAdditionalQuery.sql, objAdditionalQuery.params);
		}
		
		var fields = "unit, version, alt, last_ball_unit, headers_commission, payload_commission, sequence, content_hash";
		var values = "?,?,?,?,?,?,?,?";
		var params = [objUnit.unit, objUnit.version, objUnit.alt, objUnit.last_ball_unit,
			objUnit.headers_commission || 0, objUnit.payload_commission || 0, objValidationState.sequence, objUnit.content_hash];
		if (conf.bLight){
			fields += ", creation_date";
			values += ","+conn.getFromUnixTime("?");
			params.push(objUnit.timestamp);
		}
		if (objUnit.round_index){  // pow add
			fields += ", round_index, pow_type";
			values += ",?,?";
			params.push(objUnit.round_index, objUnit.pow_type);
		}
		if (objUnit.pow_type === constants.POW_TYPE_TRUSTME){  // pow add
			fields += ", main_chain_index, phase";
			values += ",?,?";
			params.push(objUnit.hp, objUnit.phase);
		}
		else if (conf.bLight){
			fields += ", main_chain_index";
			values += ",?";
			params.push(objUnit.main_chain_index);
		}
		conn.addQuery(arrQueries, "INSERT INTO units ("+fields+") VALUES ("+values+")", params);
		
		if (objJoint.ball && !conf.bLight){
			conn.addQuery(arrQueries, "INSERT INTO balls (ball, unit) VALUES(?,?)", [objJoint.ball, objUnit.unit]);
			conn.addQuery(arrQueries, "DELETE FROM hash_tree_balls WHERE ball=? AND unit=?", [objJoint.ball, objUnit.unit]);
			if (objJoint.skiplist_units)
				for (var i=0; i<objJoint.skiplist_units.length; i++)
					conn.addQuery(arrQueries, "INSERT INTO skiplist_units (unit, skiplist_unit) VALUES (?,?)", [objUnit.unit, objJoint.skiplist_units[i]]);
		}
		
		if (objUnit.parent_units){
			for (var i=0; i<objUnit.parent_units.length; i++)
				conn.addQuery(arrQueries, "INSERT INTO parenthoods (child_unit, parent_unit) VALUES(?,?)", [objUnit.unit, objUnit.parent_units[i]]);
		}
		
		if (storage.isGenesisUnit(objUnit.unit))
			conn.addQuery(arrQueries, 
				"UPDATE units SET is_on_main_chain=1, main_chain_index=0, is_stable=1, level=0, witnessed_level=0 \n\
				WHERE unit=?", [objUnit.unit]);
		else {
			conn.addQuery(arrQueries, "UPDATE units SET is_free=0 WHERE unit IN(?)", [objUnit.parent_units], function(result){
				// in sqlite3, result.affectedRows actually returns the number of _matched_ rows
				var count_consumed_free_units = result.affectedRows;
				console.log(count_consumed_free_units+" free units consumed");
			});
		}
		
		var arrAuthorAddresses = [];
		for (var i=0; i<objUnit.authors.length; i++){
			var author = objUnit.authors[i];
			arrAuthorAddresses.push(author.address);
			var definition = author.definition;
			var definition_chash = null;
			if (definition){
				// IGNORE for messages out of sequence
				definition_chash = objectHash.getChash160(definition);
				conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO definitions (definition_chash, definition, has_references) VALUES (?,?,?)", 
					[definition_chash, JSON.stringify(definition), Definition.hasReferences(definition) ? 1 : 0]);
				// actually inserts only when the address is first used.
				// if we change keys and later send a unit signed by new keys, the address is not inserted. 
				// Its definition_chash was updated before when we posted change-definition message.
				if (definition_chash === author.address)
					conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO addresses (address) VALUES(?)", [author.address]);
			}
			else if (objUnit.content_hash)
				conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO addresses (address) VALUES(?)", [author.address]);
			conn.addQuery(arrQueries, "INSERT INTO unit_authors (unit, address, definition_chash) VALUES(?,?,?)", 
				[objUnit.unit, author.address, definition_chash]);
			if (!objUnit.content_hash){
				for (var path in author.authentifiers)
					conn.addQuery(arrQueries, "INSERT INTO authentifiers (unit, address, path, authentifier) VALUES(?,?,?,?)", 
						[objUnit.unit, author.address, path, author.authentifiers[path]]);
			}
		}

		// save coordinators
		if(objUnit.coordinators) {
			for (var i=0; i<objUnit.coordinators.length; i++){
				var coordinator = objUnit.coordinators[i];
				if (!objUnit.content_hash){
					for (var c_path in coordinator.authentifiers)
						conn.addQuery(arrQueries, "INSERT INTO coordinator_authentifiers (unit, address, path, authentifier) VALUES(?,?,?,?)", 
							[objUnit.unit, coordinator.address, c_path, coordinator.authentifiers[c_path]]);
				}
			}
		}
		
		if (!objUnit.content_hash){
			for (var i=0; i<objUnit.messages.length; i++){
				var message = objUnit.messages[i];
				
				var text_payload = null;
				if (message.app === "text")
					text_payload = message.payload;
				else if (message.app === "data" || message.app === "profile" || message.app === "attestation" || message.app === "definition_template" ||
						message.app === "pow_equihash" || message.app === "trustme" || message.app === "coinbase")
					text_payload = JSON.stringify(message.payload);
				
				// reward unit
				if(conf.bCalculateReward && !conf.bLight){
					if (message.app === "text" && message.payload != null && message.payload.indexOf("DepositReward") === 0 ){
						conn.addQuery(arrQueries, "INSERT INTO coin_reward_unit (reward_period, address, unit)  \n\
						VALUES (?, ?, ?)", 
						[message.payload.substring(14), objJoint.unit.authors[0].address, objJoint.unit.unit]);
					}
				}
					
				conn.addQuery(arrQueries, "INSERT INTO messages \n\
					(unit, message_index, app, payload_hash, payload_location, payload, payload_uri, payload_uri_hash) VALUES(?,?,?,?,?,?,?,?)", 
					[objUnit.unit, i, message.app, message.payload_hash, message.payload_location, text_payload, 
					message.payload_uri, message.payload_uri_hash]);
				
				if (message.payload_location === "inline"){
					switch (message.app){
						case "address_definition_change":
							var definition_chash = message.payload.definition_chash;
							var address = message.payload.address || objUnit.authors[0].address;
							conn.addQuery(arrQueries, 
								"INSERT INTO address_definition_changes (unit, message_index, address, definition_chash) VALUES(?,?,?,?)", 
								[objUnit.unit, i, address, definition_chash]);
							break;
						case "poll":
							var poll = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO polls (unit, message_index, question) VALUES(?,?,?)", [objUnit.unit, i, poll.question]);
							for (var j=0; j<poll.choices.length; j++)
								conn.addQuery(arrQueries, "INSERT INTO poll_choices (unit, choice_index, choice) VALUES(?,?,?)", 
									[objUnit.unit, j, poll.choices[j]]);
							break;
						case "vote":
							var vote = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO votes (unit, message_index, poll_unit, choice) VALUES (?,?,?,?)", 
								[objUnit.unit, i, vote.unit, vote.choice]);
							break;
						case "pow_equihash":  // pow add
							var powEquihash = message.payload;
							conn.addQuery(arrQueries, "INSERT "+db.getIgnore()+" INTO pow (unit, solution) VALUES (?,?)", 
								[objUnit.unit, JSON.stringify(powEquihash.solution)]);
							break;
						case "attestation":
							var attestation = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO attestations (unit, message_index, attestor_address, address) VALUES(?,?,?,?)", 
								[objUnit.unit, i, objUnit.authors[0].address, attestation.address]);
							break;
						case "asset":
							var asset = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO assets (unit, message_index, \n\
								cap, is_private, is_transferrable, auto_destroy, fixed_denominations, \n\
								issued_by_definer_only, cosigned_by_definer, spender_attested, \n\
								issue_condition, transfer_condition) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", 
								[objUnit.unit, i, 
								asset.cap, asset.is_private?1:0, asset.is_transferrable?1:0, asset.auto_destroy?1:0, asset.fixed_denominations?1:0, 
								asset.issued_by_definer_only?1:0, asset.cosigned_by_definer?1:0, asset.spender_attested?1:0, 
								asset.issue_condition ? JSON.stringify(asset.issue_condition) : null,
								asset.transfer_condition ? JSON.stringify(asset.transfer_condition) : null]);
							if (asset.attestors){
								for (var j=0; j<asset.attestors.length; j++){
									conn.addQuery(arrQueries, 
										"INSERT INTO asset_attestors (unit, message_index, asset, attestor_address) VALUES(?,?,?,?)",
										[objUnit.unit, i, objUnit.unit, asset.attestors[j]]);
								}
							}
							if (asset.denominations){
								for (var j=0; j<asset.denominations.length; j++){
									conn.addQuery(arrQueries, 
										"INSERT INTO asset_denominations (asset, denomination, count_coins) VALUES(?,?,?)",
										[objUnit.unit, asset.denominations[j].denomination, asset.denominations[j].count_coins]);
								}
							}
							break;
						case "asset_attestors":
							var asset_attestors = message.payload;
							for (var j=0; j<asset_attestors.attestors.length; j++){
								conn.addQuery(arrQueries, 
									"INSERT INTO asset_attestors (unit, message_index, asset, attestor_address) VALUES(?,?,?,?)",
									[objUnit.unit, i, asset_attestors.asset, asset_attestors.attestors[j]]);
							}
							break;
						case "data_feed":
							var data = message.payload;
							for (var feed_name in data){
								var value = data[feed_name];
								var field_name = (typeof value === 'string') ? "`value`" : "int_value";
								conn.addQuery(arrQueries, "INSERT INTO data_feeds (unit, message_index, feed_name, "+field_name+") VALUES(?,?,?,?)", 
									[objUnit.unit, i, feed_name, value]);
							}
							break;
							
						case "payment":
							// we'll add inputs/outputs later because we need to read the payer address
							// from src outputs, and it's inconvenient to read it synchronously
							break;
					} // switch message.app
				} // inline

				if ("spend_proofs" in message){
					for (var j=0; j<message.spend_proofs.length; j++){
						var objSpendProof = message.spend_proofs[j];
						conn.addQuery(arrQueries, 
							"INSERT INTO spend_proofs (unit, message_index, spend_proof_index, spend_proof, address) VALUES(?,?,?,?,?)", 
							[objUnit.unit, i, j, objSpendProof.spend_proof, objSpendProof.address || arrAuthorAddresses[0] ]);
					}
				}
			}
		}
		
		function determineInputAddressFromSrcOutput(asset, denomination, input, handleAddress){
			conn.query(
				"SELECT address, denomination, asset FROM outputs WHERE unit=? AND message_index=? AND output_index=?",
				[input.unit, input.message_index, input.output_index],
				function(rows){
					if (rows.length > 1)
						throw Error("multiple src outputs found");
					if (rows.length === 0){
						if (conf.bLight) // it's normal that a light client doesn't store the previous output
							return handleAddress(null);
						else
							throw Error("src output not found");
					}
					var row = rows[0];
					if (!(!asset && !row.asset || asset === row.asset))
						throw Error("asset doesn't match");
					if (denomination !== row.denomination)
						throw Error("denomination doesn't match");
					var address = row.address;
					if (arrAuthorAddresses.indexOf(address) === -1)
						throw Error("src output address not among authors");
					handleAddress(address);
				}
			);
		}
		
		function addInlinePaymentQueries(cb){
			async.forEachOfSeries(
				objUnit.messages,
				function(message, i, cb2){
					if (message.payload_location !== 'inline')
						return cb2();
					var payload = message.payload;
					if (message.app !== 'payment')
						return cb2();
					
					var denomination = payload.denomination || 1;
					
					async.forEachOfSeries(
						payload.inputs,
						function(input, j, cb3){
							var type = input.type || "transfer";
							var src_unit = (type === "transfer") ? input.unit : null;
							var src_message_index = (type === "transfer") ? input.message_index : null;
							var src_output_index = (type === "transfer") ? input.output_index : null;
							
							var determineInputAddress = function(handleAddress){
								if (type === "issue" || type === "coinbase")
									return handleAddress((arrAuthorAddresses.length === 1) ? arrAuthorAddresses[0] : input.address);
								// hereafter, transfer
								if (arrAuthorAddresses.length === 1)
									return handleAddress(arrAuthorAddresses[0]);
								determineInputAddressFromSrcOutput(payload.asset, denomination, input, handleAddress);
							};
							
							determineInputAddress(function(address){
								var is_unique = 
									objValidationState.arrDoubleSpendInputs.some(function(ds){ return (ds.message_index === i && ds.input_index === j); }) 
									? null : 1;
								conn.addQuery(arrQueries, "INSERT INTO inputs \n\
								(unit, message_index, input_index, type, \n\
								src_unit, src_message_index, src_output_index, \n\
								denomination, amount, serial_number, \n\
								asset, is_unique, address) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
								[objUnit.unit, i, j, type, 
								src_unit, src_message_index, src_output_index, 
								denomination, input.amount, input.serial_number ? input.serial_number : null, 
								payload.asset ? payload.asset : null, is_unique, address]);
								switch (type){
									case "transfer":
										conn.addQuery(arrQueries, 
											"UPDATE outputs SET is_spent=1 WHERE unit=? AND message_index=? AND output_index=?",
											[src_unit, src_message_index, src_output_index]);
										break;
								}
								cb3();
							});
						},
						function(){
							for (var j=0; j<payload.outputs.length; j++){
								var output = payload.outputs[j];
								// we set is_serial=1 for public payments as we check that their inputs are stable and serial before spending, 
								// therefore it is impossible to have a nonserial in the middle of the chain (but possible for private payments)
								conn.addQuery(arrQueries, 
									"INSERT INTO outputs \n\
									(unit, message_index, output_index, address, amount, asset, denomination, is_serial) VALUES(?,?,?,?,?,?,?,1)",
									[objUnit.unit, i, j, output.address, parseInt(output.amount), payload.asset, denomination]
								);
							}
							cb2();
						}
					);
				},
				cb
			);
		}
				
		// function updateBestParent(cb){
		// 	conn.query("UPDATE units SET best_parent_unit=? WHERE unit=?", [objValidationState.best_parent_unit, objUnit.unit], function(){ cb(); });
		// }
		
		function updateLevel(cb){
			conn.query("SELECT MAX(level) AS max_level FROM units WHERE unit IN(?)", [objUnit.parent_units], function(rows){
				if (rows.length !== 1)
					throw Error("not a single max level?");
				conn.query("UPDATE units SET level=? WHERE unit=?", [rows[0].max_level + 1, objUnit.unit], function(){
					cb();
				});
			});
		}
		
		function updateWitnessedLevel(cb){
			conn.query("UPDATE units SET witnessed_level=? WHERE unit=?", [objValidationState.witnessed_level, objUnit.unit], function(){
				profiler.stop('write-wl-update');
				cb();
			});
		}
			
		function updateLimci(cb){
			conn.query("UPDATE units SET latest_included_mc_index=? WHERE unit=?", [objValidationState.limci, objUnit.unit], function(){
				profiler.stop('write-limci-update');
				cb();
			});
		}
		
		// Victor ShareAddress 
		function insertShareAddress(cb){
			if (!objUnit.arrShareDefinition || objUnit.arrShareDefinition.length == 0)
				return cb();

			async.forEachOfSeries(objUnit.arrShareDefinition,
				function(shareDefinition, i, cb2){
					var arrDefinition = shareDefinition.arrDefinition;
					var assocSignersByPath = shareDefinition.assocSignersByPath;
								
					var shareAddress = objectHash.getChash160(arrDefinition);
					conn.query("SELECT shared_address FROM shared_addresses WHERE shared_address=? \n\
							UNION \n\
							SELECT shared_address FROM shared_address_signing_paths WHERE shared_address=? ",
							[shareAddress, shareAddress], 
						function(rows){
							if (rows.length > 0)
								return cb2();
							conn.addQuery(arrQueries, 
								"INSERT "+db.getIgnore()+" INTO shared_addresses (shared_address, definition) VALUES (?,?)", 
								[shareAddress, JSON.stringify(arrDefinition)]);
							
							for (var signing_path in assocSignersByPath){
								var signerInfo = assocSignersByPath[signing_path];
								conn.addQuery(arrQueries, 
									"INSERT "+db.getIgnore()+" INTO shared_address_signing_paths \n\
									(shared_address, address, signing_path, member_signing_path, device_address) VALUES (?,?,?,?,?)", 
									[shareAddress, signerInfo.address, signing_path, signerInfo.member_signing_path, signerInfo.device_address]);
							}
							// deposit add insert supernode table
							if(deposit.isDepositDefinition(arrDefinition)){
								if (objUnit.authors.length !== 1)
									throw Error("The number of the author of the first unit to pay for the deposit address must be 1");
						
								var pathCount = 0;
								var arrSigningAddress = [];
								for (var signingPath in assocSignersByPath){
									pathCount++;
									arrSigningAddress.push(assocSignersByPath[signingPath].address);
								}
								if (pathCount !== 2)
									throw Error("deposit definition signing paths error");
						
								conn.addQuery(arrQueries, 
									'INSERT OR IGNORE INTO supernode (address, deposit_address, safe_address) VALUES (?, ?, ?)', 
										[objUnit.authors[0].address, shareAddress, arrSigningAddress[1]]);
							}
							cb2();
						}				
					);
				},
				cb
			);	
		}		
		
		// without this locking, we get frequent deadlocks from mysql
		mutex.lock(["write"], function(unlock){
			console.log("got lock to write "+objUnit.unit);
			addInlinePaymentQueries(function(){
				insertShareAddress(function(){   // Victor ShareAddress 
					console.log("Victor ShareAddress "+objUnit.unit);
					async.series(arrQueries, function(){
						profiler.stop('write-raw');
						profiler.start();
						var arrOps = [];
						if (objUnit.parent_units){
							if (!conf.bLight){
								//arrOps.push(updateBestParent);
								arrOps.push(updateLevel);
								arrOps.push(updateWitnessedLevel);
								arrOps.push(updateLimci);
								if(objUnit.pow_type === constants.POW_TYPE_TRUSTME){
									arrOps.push(function(cb){
										console.log("updating MC after adding "+objUnit.unit);
										main_chain.updateUnitsStable(conn, objUnit.unit, objUnit.hp, cb);
									});
								}
							}
							if (preCommitCallback)
								arrOps.push(function(cb){
									console.log("executing pre-commit callback");
									preCommitCallback(conn, cb);
								});
						}
						async.series(arrOps, function(err){
							profiler.start();
							conn.query(err ? "ROLLBACK" : "COMMIT", function(){
								conn.release();
								console.log((err ? (err+", therefore rolled back unit ") : "committed unit ")+objUnit.unit);
								profiler.stop('write-commit');
								profiler.increment();
								unlock();
								if (!err)
									eventBus.emit('saved_unit-'+objUnit.unit, objJoint);
								if (onDone)
									onDone(err);
								count_writes++;
								if (conf.storage === 'sqlite')
									updateSqliteStats();
							});
						});
					});
				});
			});
		});
	});
}

function readCountOfAnalyzedUnits(handleCount){
	if (count_units_in_prev_analyze)
		return handleCount(count_units_in_prev_analyze);
	db.query("SELECT * FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'", function(rows){
		if (rows.length === 0)
			return handleCount(0);
		db.query("SELECT stat FROM sqlite_stat1 WHERE tbl='units' AND idx='sqlite_autoindex_units_1'", function(rows){
			if (rows.length !== 1){
				console.log('no stat for sqlite_autoindex_units_1');
				return handleCount(0);
			}
			handleCount(parseInt(rows[0].stat.split(' ')[0]));
		});
	});
}

// update stats for query planner
function updateSqliteStats(){
	if (count_writes % 100 !== 0)
		return;
	db.query("SELECT MAX(rowid) AS count_units FROM units", function(rows){
		var count_units = rows[0].count_units;
		if (count_units > 500000) // the db is too big, anaylze will lock db for long time,skip it from now on.
			return;
		readCountOfAnalyzedUnits(function(count_analyzed_units){
			console.log('count analyzed units: '+count_analyzed_units);
			if (count_units < 2*count_analyzed_units)
				return;
			count_units_in_prev_analyze = count_units;
			console.log("will update sqlite stats");
			db.query("ANALYZE", function(){
				db.query("ANALYZE sqlite_master", function(){
					console.log("sqlite stats updated");
				});
			});
		});
	});
}

exports.saveJoint = saveJoint;

