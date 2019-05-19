/*jslint node: true */
"use strict";

var constants = require('../config/constants.js');
// var conf = require('../config/conf.js');
var db = require('../db/db.js');

var validationUtils = require("../validation/validation_utils.js");
var objectHash = require('../base/object_hash.js');
var round = require('../pow/round.js');
var async = require('async');

var constants = require('../config/constants.js');


/**
 * Returns max round index of a reward period.
 */
function getRewardPeriod(roundIndex){
    if(!validationUtils.isPositiveInteger(roundIndex))
        return 0;
    if(roundIndex <= constants.DEPOSIT_REWARD_PERIOD)
        return 1;
    return Math.ceil(roundIndex/constants.DEPOSIT_REWARD_PERIOD);
}


/**
 * Returns max round index of a reward period.
 */
function getMaxRoundOfReward(rewardPeriod){
    if(!validationUtils.isPositiveInteger(rewardPeriod))
        return 0;
    return constants.DEPOSIT_REWARD_PERIOD*rewardPeriod;
}

/**
 * Returns total reward by period.
 */
function getTotalRewardByPeriod(conn, rewardPeriod, cb){
    var conn = conn || db;
    if(!validationUtils.isPositiveInteger(rewardPeriod))
        return cb("param rewardPeriod is not a positive number");
    // if(rewardPeriod === 1)
    //     return cb(null, 0);
    let maxRound = getMaxRoundOfReward(rewardPeriod);
    let minRound = 0;
    if(rewardPeriod > 1)
        minRound = getMaxRoundOfReward(rewardPeriod-1);
    conn.query("SELECT SUM(AMOUNT) AS TotalReward FROM outputs JOIN units USING(unit) \n\
        WHERE is_stable=1 AND sequence='good' AND pow_type=? \n\
        AND round_index>? AND round_index<=? AND address=?", 
        [constants.POW_TYPE_COIN_BASE, minRound, maxRound, constants.FOUNDATION_ADDRESS], 
        function(rows) {
            if (rows.length !== 1 )
                return cb("getTotalRewardByPeriod sql error");
            cb(null, Math.floor(rows[0].TotalReward*constants.DEPOSIT_REWARD_PERCENT));
        }
    );
}

/**
 * Returns total coin age by period.
 */
function getCoinRewardRatio(conn, rewardPeriod, callback){
    var conn = conn || db;
    if(!validationUtils.isPositiveInteger(rewardPeriod))
        return callback("param rewardPeriod is not a positive number");
    // if(rewardPeriod === 1)
    //     return callback(null, []);
    let maxRound = getMaxRoundOfReward(rewardPeriod);
    conn.query("SELECT outputs.address,supernode.safe_address,amount,main_chain_index FROM outputs \n\
        JOIN supernode ON outputs.address=supernode.deposit_address \n\
        JOIN units USING(unit) WHERE is_spent=0 AND is_stable=1 AND sequence='good'", 
        function(rowsDeposit) {
            if(rowsDeposit.length===0)
                return callback(null, []);
            var totalCoinAgeResult = [];
            var totalCoin = 0;
            console.log("yyyyyyyyyyyyy1:" + JSON.stringify(rowsDeposit));
            async.eachSeries(
                rowsDeposit, 
                function(row, cb){
                    round.getRoundIndexByMci(conn, row.main_chain_index, function(round_index){
                        if(round_index === 0 )
                            return cb();
                        if(maxRound - round_index < constants.DEPOSIT_REWARD_PERIOD)
                            return cb();
                        var coinAge = Math.floor((maxRound - round_index)/constants.DEPOSIT_REWARD_PERIOD);
                        var coinReward = coinAge * Math.floor(row.amount/1000000)
                        totalCoin += coinReward;
                        totalCoinAgeResult.push({"address":row.safe_address, "coinAge": coinAge, 
                            "coinAmount": row.amount, "coinReward": coinReward});
                        cb();
                    });
                    
                }, 
                function(){
                    for(var i=0; i<totalCoinAgeResult.length; i++){
                        if(totalCoin === 0)
                            totalCoinAgeResult[i].CoinRewardRatio = 0;
                        else
                            totalCoinAgeResult[i].CoinRewardRatio = Math.floor(totalCoinAgeResult[i].coinReward*10000/totalCoin)/10000;
                    }
                    console.log("yyyyyyyyyyyyy2:" + totalCoin + "————" + JSON.stringify(totalCoinAgeResult));
                    callback(null, totalCoinAgeResult);
                }
            );
        }
    );
}


exports.getRewardPeriod = getRewardPeriod;
exports.getMaxRoundOfReward = getMaxRoundOfReward;
exports.getTotalRewardByPeriod = getTotalRewardByPeriod;
exports.getCoinRewardRatio = getCoinRewardRatio;
