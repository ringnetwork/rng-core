/*jslint node: true */
"use strict";
var db = require('../db/db.js');
var constants = require("../config/constants.js");
var conf = require("../config/conf.js");
var storage = require("../db/storage.js");
var main_chain = require("../mc/main_chain.js");

function pickTrustParentUnits(conn, onDone){
	// trustme unit's parent must include the last trustme unit
	var parentUnits = [];
	conn.query(
		"SELECT \n\
			unit, version, alt, ball, main_chain_index \n\
		FROM units \n\
		LEFT JOIN balls USING(unit)  \n\
		LEFT JOIN archived_joints USING(unit) \n\
		WHERE is_on_main_chain=1 AND is_stable=1 AND +sequence='good' AND pow_type=? AND archived_joints.unit IS NULL \n\
		ORDER BY main_chain_index DESC LIMIT 1", 
		[constants.POW_TYPE_TRUSTME], 
		function(rowsTrustMe){
			if (rowsTrustMe.some(function(row){ return (row.version !== constants.version || row.alt !== constants.alt); }))
				throw Error('wrong network');
			if(rowsTrustMe.length === 0){  // if there is no trustme unit，then select genesis unit as parent
				conn.query("SELECT ball FROM balls WHERE unit=?", [constants.GENESIS_UNIT], function(rowsBalls){
					if (rowsBalls.length !== 1)
						throw Error('error genesis unit without ball');
					return onDone(null, [constants.GENESIS_UNIT], rowsBalls[0].ball, constants.GENESIS_UNIT, 0);  
				});
			}
			else if(rowsTrustMe.length !== 1){  
				throw Error('error trustme unit');
			}
			else {
				parentUnits.push(rowsTrustMe[0].unit);
				conn.query(
					"SELECT \n\
						unit, version, alt \n\
					FROM units "+(conf.storage === 'sqlite' ? "INDEXED BY byFree" : "")+" \n\
					LEFT JOIN archived_joints USING(unit) \n\
					WHERE +sequence='good' AND is_free=1 AND archived_joints.unit IS NULL ORDER BY unit LIMIT ?", 
					// exclude potential parents that were archived and then received again
					[ constants.MAX_PARENTS_PER_UNIT-1], 
					function(rows){
						if (rows.some(function(row){ return (row.version !== constants.version || row.alt !== constants.alt); }))
							throw Error('wrong network');
							//if(witnesses.indexOf(address) === -1)
						if (rows.length > 0){
							for (var j=0; j<rows.length; j++){
								if(parentUnits.indexOf(rows[j].unit) === -1)
									parentUnits.push(rows[j].unit);
							}
						}
						
						onDone(null, parentUnits, rowsTrustMe[0].ball, rowsTrustMe[0].unit, rowsTrustMe[0].main_chain_index);
					}
				);
			}
		}
	);
}

function pickParentUnitsAndLastBall(conn, onDone){
	pickTrustParentUnits(conn, function(err, arrParentUnits, last_trust_ball, last_trust_ball_unit, last_trust_ball_mci){
		if (err)
			return onDone(err);
		arrParentUnits = arrParentUnits.sort();
		onDone(null, arrParentUnits, last_trust_ball, last_trust_ball_unit, last_trust_ball_mci);	
	});
}


function pickRecoverParentUnits(conn, onDone){
	// trustme unit's parent must include the last trustme unit
	var parentUnits = [];
	conn.query(
		"SELECT \n\
			unit, version, alt, ball, main_chain_index, round_index \n\
		FROM units \n\
		LEFT JOIN balls USING(unit)  \n\
		LEFT JOIN archived_joints USING(unit) \n\
		WHERE is_on_main_chain=1 AND is_stable=1 AND +sequence='good' AND pow_type=? AND archived_joints.unit IS NULL \n\
		ORDER BY main_chain_index DESC LIMIT 1", 
		[constants.POW_TYPE_TRUSTME], 
		function(rowsTrustMe){
			if (rowsTrustMe.some(function(row){ return (row.version !== constants.version || row.alt !== constants.alt); }))
				throw Error('wrong network');
			if(rowsTrustMe.length === 0){  // if there is no trustme unit，then select genesis unit as parent
				conn.query("SELECT ball FROM balls WHERE unit=?", [constants.GENESIS_UNIT], function(rowsBalls){
					if (rowsBalls.length !== 1)
						throw Error('error genesis unit without ball');
					return onDone(null, [constants.GENESIS_UNIT], rowsBalls[0].ball, constants.GENESIS_UNIT, 0, 1);  
				});
			}
			else if(rowsTrustMe.length !== 1){  
				throw Error('error trustme unit');
			}
			else {
				// validation the number of pow unit for the current round
				conn.query(
					"SELECT count(distinct address) from units left join unit_authors using(unit) \n\
					WHERE round_index=? AND pow_type=? ", 
					[rowsTrustMe[0].round_index, constants.POW_TYPE_POW_EQUHASH], 
					function(powrows){
						//if(powrows.length < 10)
						//	return onDone("the number of pow unit for the current round is too less");
						parentUnits.push(rowsTrustMe[0].unit);
						// pick all pow units as parents
						conn.query(
							"SELECT \n\
								unit, version, alt \n\
							FROM units "+(conf.storage === 'sqlite' ? "INDEXED BY byFree" : "")+" \n\
							LEFT JOIN archived_joints USING(unit) \n\
							WHERE +sequence='good' AND is_free=1 AND archived_joints.unit IS NULL and  \n\
							pow_type IN (?,?) ORDER BY pow_type,unit LIMIT ?", 
							[constants.POW_TYPE_POW_EQUHASH,constants.POW_TYPE_COIN_BASE,constants.MAX_PARENTS_PER_UNIT-1], 
							function(rows){
								if (rows.some(function(row){ return (row.version !== constants.version || row.alt !== constants.alt); }))
									throw Error('wrong network');
									//if(witnesses.indexOf(address) === -1)
								if (rows.length > 0){
									for (var j=0; j<rows.length; j++){
										if(parentUnits.indexOf(rows[j].unit) === -1)
											parentUnits.push(rows[j].unit);
									}
								}
								if(constants.MAX_PARENTS_PER_UNIT-1-rows.length > 0){
									conn.query(
										"SELECT \n\
											unit, version, alt \n\
										FROM units "+(conf.storage === 'sqlite' ? "INDEXED BY byFree" : "")+" \n\
										LEFT JOIN archived_joints USING(unit) \n\
										WHERE +sequence='good' AND is_free=1 AND archived_joints.unit IS NULL ORDER BY unit LIMIT ?", 
										// exclude potential parents that were archived and then received again
										[ constants.MAX_PARENTS_PER_UNIT-1-rows.length], 
										function(rowsFree){
											if (rowsFree.some(function(row){ return (row.version !== constants.version || row.alt !== constants.alt); }))
												throw Error('wrong network');
												//if(witnesses.indexOf(address) === -1)
											if (rowsFree.length > 0){
												for (var j=0; j<rowsFree.length; j++){
													if(parentUnits.indexOf(rowsFree[j].unit) === -1)
														parentUnits.push(rowsFree[j].unit);
												}
											}
											
											onDone(null, parentUnits, rowsTrustMe[0].ball, rowsTrustMe[0].unit, rowsTrustMe[0].main_chain_index, rowsTrustMe[0].round_index);
										});
								}
								else{
									onDone(null, parentUnits, rowsTrustMe[0].ball, rowsTrustMe[0].unit, rowsTrustMe[0].main_chain_index, rowsTrustMe[0].round_index);
								}
							}
						);
					}
				);
			}
		}
	);
}

function pickParentsAndLastBallAndPowcount(conn, onDone){
	pickRecoverParentUnits(conn, function(err, arrParentUnits, last_trust_ball, last_trust_ball_unit, last_trust_ball_mci, round_index){
		if (err)
			return onDone(err);
		arrParentUnits = arrParentUnits.sort();
		onDone(null, arrParentUnits, last_trust_ball, last_trust_ball_unit, last_trust_ball_mci, round_index);	
	});
}

exports.pickParentUnitsAndLastBall = pickParentUnitsAndLastBall;
exports.pickParentsAndLastBallAndPowcount = pickParentsAndLastBallAndPowcount;

