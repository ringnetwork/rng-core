/*jslint node: true */
"use strict";

var constants = require('../config/constants.js');
var conf = require('../config/conf.js');
var db = require('../db/db.js');
var _ = require('lodash');
// var mutex = require('../base/mutex.js');
//var async = require('async');
var validationUtils = require('../validation/validation_utils.js');
var validation = require('../validation/validation.js');
var objectHash = require('../base/object_hash.js');
var eventBus = require('../base/event_bus.js');
var network = require('../p2p/network.js');
var composer = require('../unit/composer.js');
var round = require('../pow/round.js');
var supernode = require('../wallet/supernode.js');
var gossiper = require('../p2p/gossiper.js');

// Initialization:
var h_p           = 0;   // mci
var p_p           = 0;   // current phase number
var step_p        = 0;   // 1:propose,2:prevote,3:precommit
var lockedValue_p = null;
var lockedPhase_p = -1;
var validValue_p  = null;
var validPhase_p  = -1;
var address_p     = "";
// temp mci and phase number, used in timeout function
var h_propose_timeout   = -1;
var p_propose_timeout   = -1; 
var h_prevote_timeout   = -1;
var p_prevote_timeout   = -1; 
var h_precommit_timeout = -1;
var p_precommit_timeout = -1; 
// var p_phase_timeout = -1; 
var timeout_propose;
var timeout_prevote;
var timeout_precommit;
var waitingProposer = "";

var last_prevote_gossip = {};
var last_precommit_gossip = {};

var assocByzantinePhase = {};

var maxGossipHp = 1;
var maxGossipPp = 0;
var bByzantineUnderWay = false;

var last_round_index = 0;
var last_main_chain_index = 0;
// var bTrustMeUnderWay = false;

// init function begin

/**
 * init byzantine, executes at startup
 */
function initByzantine(){
    try{
        if(!conf.IF_BYZANTINE)
            return;
        if(bByzantineUnderWay)
            return;
    
        db.query(
            "SELECT main_chain_index FROM units \n\
            WHERE is_on_main_chain=1 AND is_stable=1 AND +sequence='good' AND pow_type=? \n\
            ORDER BY main_chain_index DESC LIMIT 1", 
            [constants.POW_TYPE_TRUSTME], 
            function(rows){
                var hp = 1;     // just after genesis or catchup from fresh start
                if (rows.length === 0){  
                    db.query(
                        "SELECT main_chain_index FROM units \n\
                        WHERE unit=?", 
                        [constants.GENESIS_UNIT],
                        function(rowGenesis){
                            if(rowGenesis.length === 0){
                                setTimeout(function(){
                                    initByzantine();
                                }, 3000);
                            }
                            else{
                                startPhase(hp, 0);
                            }
                        }
                    );
                }
                else if (rows.length === 1){  
                    hp = rows[0].main_chain_index + 1;
                        
                    if(maxGossipHp === hp) {
                        startPhase(hp, maxGossipPp);
                    }
                    else {
                        setTimeout(function(){
                            initByzantine();
                        }, 3000);
                    }
                }
            }
        );  
    }
    catch(err) {
        console.log("bylllloggerror,initByzantine:" + err);
    }
}

eventBus.on('headless_wallet_ready', () =>
{
    try{
        if(!conf.IF_BYZANTINE)
            return;
        db.query("SELECT address FROM my_addresses", [], 
            function(rowsAddress){
                if (rowsAddress.length === 0)
                    throw Error("no addresses");
                if (rowsAddress.length > 1)
                    throw Error("more than 1 address");
                address_p = rowsAddress[0].address;
                
                initByzantine();
            }
        );
    }
    catch(err) {
        console.log("bylllloggerror,headless_wallet_ready:" + err);
    }
});

// init function end

// public function begin

/**
 * Get proposer witnesses and round index by hp and phase
 * 
 * @param	{obj}	    conn      if conn is null, use db query, otherwise use conn.
 * @param   {Integer}   hp
 * @param   {Integer}   phase
 * @param   {function}	callback( err, proposer, roundIndex, witnesses ) callback function
 *                      
 */
function getCoordinators(conn, hp, phase, cb){
    try{
        hp = parseInt(hp);
        phase = parseInt(phase);
        var pIndex = Math.abs(hp-phase+999)%constants.TOTAL_COORDINATORS;
        if (assocByzantinePhase[hp] && assocByzantinePhase[hp].roundIndex && assocByzantinePhase[hp].witnesses){
            return cb(null, assocByzantinePhase[hp].witnesses[pIndex], assocByzantinePhase[hp].roundIndex, assocByzantinePhase[hp].witnesses);
        }
        if(!validationUtils.isPositiveInteger(hp))
            return cb("param hp is not a positive integer:" + hp);
        if(!validationUtils.isNonnegativeInteger(phase))
            return cb("param phase is not a positive integer:" + phase);
        var conn = conn || db;
        round.getRoundIndexByNewMci(conn, hp, function(roundIndex){
            if(roundIndex === -1)
                return cb("have not get the last mci yet ");
            round.getWitnessesByRoundIndex(conn, roundIndex, function(witnesses){
                cb(null, witnesses[pIndex], roundIndex, witnesses);
            });        
        });
    }
    catch(err) {
        console.log("bylllloggerror,getCoordinators:" + err);
    }
}
function getGossiperCoordinators(conn, hp, phase, cb){
    try{
        hp = parseInt(hp);
        phase = parseInt(phase);
        var pIndex = Math.abs(hp-phase+999)%constants.TOTAL_COORDINATORS;
        if (assocByzantinePhase[hp] && assocByzantinePhase[hp].roundIndex && assocByzantinePhase[hp].witnesses){
            return cb(null, assocByzantinePhase[hp].witnesses[pIndex], assocByzantinePhase[hp].roundIndex, assocByzantinePhase[hp].witnesses);
        }
        if(!validationUtils.isPositiveInteger(hp))
            return cb("param hp is not a positive integer:" + hp);
        if(!validationUtils.isNonnegativeInteger(phase))
            return cb("param phase is not a positive integer:" + phase);
        var conn = conn || db;
        round.getRoundIndexByNewMci(conn, hp, function(roundIndex){
            if(roundIndex === -1)   // This is the difference from above getCoordinators
                return cb(null, null, roundIndex, null);
            round.getWitnessesByRoundIndex(conn, roundIndex, function(witnesses){
                cb(null, witnesses[pIndex], roundIndex, witnesses);
            });        
        });
    }
    catch(err) {
        console.log("bylllloggerror,getGossiperCoordinators:" + err);
    }
}

// Function StartRound(round):
//     round p ← round
//     step p ← propose    
//     if proposer(hp,roundp)=p then
//         if validValuep != nil then
//             proposal ← validValuep
//         else
//             proposal ← getValue()
//         broadcast <PROPOSAL,hp,roundp,proposal,validRoundp>
//     else
//         schedule OnTimeoutPropose(hp,roundp) to be executed after timeoutPropose(roundp)
function startPhase(hp, phase){
    if(!conf.IF_BYZANTINE)
        return;
    hp = parseInt(hp);
    phase = parseInt(phase);
    if(!validationUtils.isValidAddress(address_p)){
        // console.log("byllllogg startPhase address_p not known yet");
		setTimeout(function(){
			startPhase(hp, phase);
		}, 1000);
		return;    
    }
    // console.log("byllllogg startPhase, h_p:" + h_p + ", p_p:" + p_p + ", hp:" + hp + ", phase:" + phase);
    if(h_p > hp)
        return;
    else if(h_p === hp && p_p >= phase)
        return;
  
    if(last_main_chain_index > 0 && hp < last_main_chain_index)
        return;

    waitingProposer = "";
    getCoordinators(null, hp, phase, function(err, proposer, roundIndex, witnesses){
        try{
            if(err){
                // console.log("byllllogg get coordinators err:" + err);
                return;
            }
            if(witnesses.length !== constants.TOTAL_COORDINATORS){
                // console.log("byllllogg coordinators count err:" + witnesses.length );
                return;
            }
            if(witnesses.indexOf(address_p) === -1){
                // console.log("byllllogg i am not the coordinators of round:" + roundIndex);
                return;
            }
            if(!validationUtils.isValidAddress(proposer))
                throw Error("startPhase proposer address is not a valid address");

            h_p = hp;
            p_p = phase;
            step_p = constants.BYZANTINE_PROPOSE;   // propose
            h_propose_timeout   = -1;
            p_propose_timeout   = -1; 
            clearTimeout(timeout_propose);
            h_prevote_timeout   = -1;
            p_prevote_timeout   = -1; 
            clearTimeout(timeout_prevote);
            h_precommit_timeout = -1;
            p_precommit_timeout = -1; 
            clearTimeout(timeout_precommit);
            // p_phase_timeout = Date.now();
            bByzantineUnderWay = true;
            if(phase === 0){
                //reset params
                lockedValue_p = null;
                lockedPhase_p = -1;
                validValue_p  = null;
                validPhase_p  = -1;
            }
            if(!assocByzantinePhase[hp] || typeof assocByzantinePhase[hp] === 'undefined' || Object.keys(assocByzantinePhase[hp]).length === 0){
                assocByzantinePhase[hp] = {};
                assocByzantinePhase[hp].roundIndex = roundIndex;
                assocByzantinePhase[hp].witnesses = witnesses;
                assocByzantinePhase[hp].phase = {};
                assocByzantinePhase[hp].decision = {};    
            }       
            // if assocByzantinePhase[hp] is not null but roundIndex or witness is null
            assocByzantinePhase[hp].roundIndex = roundIndex;
            assocByzantinePhase[hp].witnesses = witnesses;  
            if(proposer === address_p){    // i am proposer
                // if(typeof assocByzantinePhase[hp] !== 'undefined' &&
                //     Object.keys(assocByzantinePhase[hp]).length > 0 &&
                //     typeof assocByzantinePhase[hp].phase[phase] !== 'undefined' &&
                //     Object.keys(assocByzantinePhase[hp].phase[phase]).length > 0 &&
                //     typeof assocByzantinePhase[hp].phase[phase].proposal !== 'undefined' &&
                //     Object.keys(assocByzantinePhase[hp].phase[phase].proposal).length > 0 &&
                //     assocByzantinePhase[hp].phase[phase].proposal.address === address_p){
                //     var proposal = assocByzantinePhase[hp].phase[phase].proposal;
                //     validation.validateProposalJoint(proposal, {
                //         ifInvalid: function(err){
                //             console.log("byllllogg BYZANTINE_PROPOSE startPhase11 ifInvalid:" + hp + phase + err );
                //             pushByzantineProposal(hp, phase, proposal, validPhase_p, 0, function(err){
                //                 if(err)
                //                     throw Error("push valid byzantine proposal error:" + err);
                //                 broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                //                 pushByzantinePrevote(hp, phase, null, address_p, 0);
                //                 broadcastPrevote(hp, phase, null);
                //                 assocByzantinePhase[hp].decision = {};
                //                 handleTempGossipMessage(hp, phase);
                //                 handleByzantine();
                //             });
                //         },
                //         ifNeedWaiting: function(err){
                //             console.log("byllllogg BYZANTINE_PROPOSE startPhase11 ifInvalid:" + hp + phase + err );
                //             pushByzantineProposal(hp, phase, proposal, validPhase_p, -1, function(err){
                //                 if(err)
                //                     throw Error("push valid byzantine proposal error:" + err);
                //                 broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                //                 pushByzantinePrevote(hp, phase, null, address_p, 0);
                //                 broadcastPrevote(hp, phase, null);
                //                 assocByzantinePhase[hp].decision = {};
                //                 handleTempGossipMessage(hp, phase);
                //                 handleByzantine();
                //             });
                //         },
                //         ifOk: function(){
                //             console.log("byllllogg BYZANTINE_PROPOSE startPhase11 ifOk:" +hp + phase  );
                //             pushByzantineProposal(hp, phase, proposal, validPhase_p, 1, function(err){
                //                 if(err)
                //                     throw Error("push valid byzantine proposal error:" + err);
                //                 broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                //                 pushByzantinePrevote(hp, phase, assocByzantinePhase[hp].phase[phase].proposal.idv, address_p, 1);
                //                 broadcastPrevote(hp, phase, assocByzantinePhase[hp].phase[phase].proposal.idv);
                //                 assocByzantinePhase[hp].decision = {};
                //                 handleTempGossipMessage(hp, phase);
                //                 handleByzantine();
                //             });
                //         }
                //     }); 
                    
                // }
                // else if(validValue_p !== null){
                if(validValue_p !== null){
                    composer.composeProposalJointByProposal(validValue_p, proposer, phase, supernode.signerProposal, 
                        function(err, objJoint){
                            if(err)
                                throw Error("startPhase compose proposal joint err" + err);
                            var proposal = convertJointToProposal(objJoint, validPhase_p, 1);
                            validation.validateProposalJoint(proposal, {
                                ifInvalid: function(err){
                                    // console.log("byllllogg BYZANTINE_PROPOSE startPhase ifInvalid:" + hp + phase + err );
                                    try{
                                        pushByzantineProposal(hp, phase, proposal, validPhase_p, 0, function(err){
                                            if(err)
                                                throw Error("push valid byzantine proposal error:" + err);
                                            broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                                            pushByzantinePrevote(hp, phase, null, address_p, 0);
                                            broadcastPrevote(hp, phase, null);
                                            assocByzantinePhase[hp].decision = {};
                                            handleTempGossipMessage(hp, phase);
                                            handleByzantine();
                                        });
                                    }
                                    catch(err) {
                                        console.log("bylllloggerror,startPhase validValue validateProposalJoint.ifInvalid:" + err);
                                    }
                                },
                                ifNeedWaiting: function(err){
                                    // console.log("byllllogg BYZANTINE_PROPOSE startPhase ifInvalid:" + hp + phase + err );
                                    pushByzantineProposal(hp, phase, proposal, validPhase_p, -1, function(err){
                                        try{
                                            if(err)
                                                throw Error("push valid byzantine proposal error:" + err);
                                            broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                                            pushByzantinePrevote(hp, phase, null, address_p, 0);
                                            broadcastPrevote(hp, phase, null);
                                            assocByzantinePhase[hp].decision = {};
                                            handleTempGossipMessage(hp, phase);
                                            handleByzantine();
                                        }
                                        catch(err) {
                                            console.log("bylllloggerror,startPhase validValue validateProposalJoint.ifNeedWaiting:" + err);
                                        }
                                    });
                                },
                                ifOk: function(){
                                    // console.log("byllllogg BYZANTINE_PROPOSE startPhase ifOk:" +hp + phase  );
                                    pushByzantineProposal(hp, phase, proposal, validPhase_p, 1, function(err){
                                        try{
                                            if(err)
                                                throw Error("push valid byzantine proposal error:" + err);
                                            broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                                            pushByzantinePrevote(hp, phase, assocByzantinePhase[hp].phase[phase].proposal.idv, address_p, 1);
                                            broadcastPrevote(hp, phase, assocByzantinePhase[hp].phase[phase].proposal.idv);
                                            assocByzantinePhase[hp].decision = {};
                                            handleTempGossipMessage(hp, phase);
                                            handleByzantine();
                                        }
                                        catch(err) {
                                            console.log("bylllloggerror,startPhase validValue validateProposalJoint.ifOk:" + err);
                                        }
                                    });
                                }
                            });                        
                        }
                    ); 
                }
                else{
                    composer.composeProposalJoint(proposer, roundIndex, hp, phase, supernode.signerProposal, 
                        function(err, objJoint){
                            if(err)
                                throw Error("startPhase compose proposal joint err" + err);
                            var proposal = convertJointToProposal(objJoint, validPhase_p, 1);
                            validation.validateProposalJoint(proposal, {
                                ifInvalid: function(err){
                                    try{
                                        // console.log("byllllogg BYZANTINE_PROPOSE startPhase ifInvalid:" + hp + phase + err );
                                        pushByzantineProposal(hp, phase, proposal, validPhase_p, 0, function(err){
                                            if(err)
                                                throw Error("push valid byzantine proposal error:" + err);
                                            broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                                            pushByzantinePrevote(hp, phase, null, address_p, 0);
                                            broadcastPrevote(hp, phase, null);
                                            assocByzantinePhase[hp].decision = {};
                                            handleTempGossipMessage(hp, phase);
                                            handleByzantine();
                                        });
                                    }
                                    catch(err) {
                                        console.log("bylllloggerror,startPhase validateProposalJoint.ifInvalid:" + err);
                                    }
                                },
                                ifNeedWaiting: function(err){
                                    try{
                                        // console.log("byllllogg BYZANTINE_PROPOSE startPhase ifInvalid:" + hp + phase + err );
                                        pushByzantineProposal(hp, phase, proposal, validPhase_p, -1, function(err){
                                            if(err)
                                                throw Error("push valid byzantine proposal error:" + err);
                                            broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                                            pushByzantinePrevote(hp, phase, null, address_p, 0);
                                            broadcastPrevote(hp, phase, null);
                                            assocByzantinePhase[hp].decision = {};
                                            handleTempGossipMessage(hp, phase);
                                            handleByzantine();
                                        });
                                    }
                                    catch(err) {
                                        console.log("bylllloggerror,startPhase validateProposalJoint.ifNeedWaiting:" + err);
                                    }
                                },
                                ifOk: function(){
                                    try{
                                        // console.log("byllllogg BYZANTINE_PROPOSE startPhase ifOk:" +hp + phase  );
                                        pushByzantineProposal(hp, phase, proposal, validPhase_p, 1, function(err){
                                            if(err)
                                                throw Error("push new byzantine proposal error:" + err);
                                            // console.log("byllllogg BYZANTINE_PROPOSE startPhase before broadcast:" +hp + phase  );
                                            broadcastProposal(hp, phase, assocByzantinePhase[hp].phase[phase].proposal, validPhase_p);
                                            pushByzantinePrevote(hp, phase, assocByzantinePhase[hp].phase[phase].proposal.idv, address_p, 1);
                                            broadcastPrevote(hp, phase, assocByzantinePhase[hp].phase[phase].proposal.idv);
                                            assocByzantinePhase[hp].decision = {};
                                            handleTempGossipMessage(hp, phase);
                                            handleByzantine();
                                        });
                                    }
                                    catch(err) {
                                        console.log("bylllloggerror,startPhase validateProposalJoint.ifOk:" + err);
                                    }
                                }
                            });                        
                        }
                    ); 
                }            
            }
            else{
                assocByzantinePhase[hp].decision = {};
                h_propose_timeout = hp;
                p_propose_timeout = phase;
                var timeout = getTimeout(phase);
                // console.log("byllllogg timeout setTimeout OnTimeoutPropose hp:" + hp + " --- phase:" + phase + " --- step_p:" + step_p + " --- timeout:" + timeout);
                clearTimeout(timeout_propose);
                timeout_propose = setTimeout(OnTimeoutPropose, timeout);
                handleByzantine();
            }
        }
        catch(err) {
            console.log("bylllloggerror,startPhase:" + err);
        }
    });
}

/**
 *  byzantine gossip message event
 */
eventBus.on('byzantine_gossip', function(sPeerUrl, sKey, gossipMessage ) {
    try {
        if(!conf.IF_BYZANTINE)
            return;
        console.log("byllllogg " + h_p + "-" + p_p + " gossip sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl 
            + " --- gossipMessage:" + JSON.stringify(gossipMessage));
        if(maxGossipHp < gossipMessage.h) { // update max gossip h
            maxGossipHp = gossipMessage.h;
            maxGossipPp = gossipMessage.p;
        }
        if(gossipMessage.h < h_p){
            return;
        }
        if(last_main_chain_index > 0 && gossipMessage.h < last_main_chain_index)
            return;
        if(!validationUtils.isValidAddress(address_p)){
            return;    
        }
    
        getGossiperCoordinators(null, gossipMessage.h, gossipMessage.p, function(err, proposer, roundIndex, witnesses){
            try{
                if(err){
                    return;
                } 
                if(witnesses.length !== constants.TOTAL_COORDINATORS){
                    return;
                }
                if(witnesses.indexOf(address_p) === -1){
                    return;
                }
                if(!assocByzantinePhase[gossipMessage.h] || typeof assocByzantinePhase[gossipMessage.h] === 'undefined' 
                || Object.keys(assocByzantinePhase[gossipMessage.h]).length === 0){
                    assocByzantinePhase[gossipMessage.h] = {};
                    assocByzantinePhase[gossipMessage.h].roundIndex = roundIndex;  // maybe roundIndex is -1, but when startphase, it will be right
                    assocByzantinePhase[gossipMessage.h].witnesses = witnesses; // maybe witnesses is null, but when startphase, it will be right
                    assocByzantinePhase[gossipMessage.h].phase = {};
                    assocByzantinePhase[gossipMessage.h].decision = {};    
                }       
                if(!assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p] || 
                    typeof assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p] === 'undefined' || 
                    Object.keys(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p]).length === 0){
                    assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p] = {"proposal":{}, "received_addresses":[],
                        "prevote_approved":[], "prevote_opposed":[], "prevote_temp_gossip":{},
                        "precommit_approved":[], "precommit_opposed":[], "precommit_temp_gossip":{}};    
                } 
                if(roundIndex === -1){    // catuping or round is behind, push to temp gossip
                    if(gossipMessage.type === constants.BYZANTINE_PREVOTE){
                        assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].prevote_temp_gossip[sKey+gossipMessage.address] = gossipMessage; 
                        pushReceivedAddresses(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].received_addresses, gossipMessage.address);
                        return;
                    }
                    else if(gossipMessage.type === constants.BYZANTINE_PRECOMMIT){
                        assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].precommit_temp_gossip[sKey+gossipMessage.address] = gossipMessage;
                        pushReceivedAddresses(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].received_addresses, gossipMessage.address);
                        return;         
                    }
                    return;
                }
            
                handleGossipMessage(sKey, gossipMessage, function(err){
                    if(err){
                        return;
                    }
                    if(bByzantineUnderWay)
                        handleByzantine();
                });    
            }
            catch(err) {
                console.log("bylllloggerror,byzantine_gossip getGossiperCoordinators:" + err);
            }    
        });
    }
    catch(err) {
        console.log("bylllloggerror,byzantine_gossip:" + err);
    }
});
eventBus.on('mci_became_stable', function(mci){
    try {
        if(!conf.IF_BYZANTINE)
            return;
        //reset params
        lockedValue_p = null;
        lockedPhase_p = -1;
        validValue_p  = null;
        validPhase_p  = -1;
        waitingProposer = "";
        // start new h_p
        //  console.log("byllllogg startPhase mci_became_stable:" + h_p + ":" + p_p);
        startPhase(mci+1, 0);
    }
    catch(err) {
        console.log("bylllloggerror,mci_became_stable:" + err);
    }
});

// Function OnTimeoutPropose(height, round) :
//     if height=hp ∧ round=roundp ∧ stepp=propose then
//         broadcast <PREVOTE,hp,roundp,nil>
//         stepp ← prevote
function OnTimeoutPropose(){
    try{
        // console.log("byllllogg timeout broadcastPrevote OnTimeoutPropose1:" + h_p + ":" + p_p + ":" + h_propose_timeout + ":" + p_propose_timeout + ":" + step_p);
        if(h_propose_timeout === h_p && p_propose_timeout === p_p && step_p === constants.BYZANTINE_PROPOSE){
            if(assocByzantinePhase[h_propose_timeout] && 
                typeof assocByzantinePhase[h_propose_timeout] !== 'undefined' && 
                Object.keys(assocByzantinePhase[h_propose_timeout]).length > 0){
                pushByzantinePrevote(h_propose_timeout, p_propose_timeout, null, address_p, 0);
                // console.log("byllllogg timeout broadcastPrevote OnTimeoutPropose2:" + h_p + ":" + p_p + ":" + h_propose_timeout + ":" + p_propose_timeout + ": null");
                broadcastPrevote(h_propose_timeout, p_propose_timeout, null);
                step_p = constants.BYZANTINE_PREVOTE;
            }
        }
        h_propose_timeout = -1;
        p_propose_timeout = -1;
        
        handleByzantine();
        
        // if proposer down
        // if(!assocByzantinePhase[h_p].phase[p_p].proposal || 
        //     typeof assocByzantinePhase[h_p].phase[p_p].proposal === 'undefined' || 
        //     Object.keys(assocByzantinePhase[h_p].phase[p_p].proposal).length === 0 ||
        //     !assocByzantinePhase[h_p].phase[p_p].proposal.idv ||
        //     typeof assocByzantinePhase[h_p].phase[p_p].proposal.idv === 'undefined'){
        //         console.log("byllllogg timeout startPhase OnTimeoutPropose:" + h_p + ":" + p_p + ":" + h_precommit_timeout + ":" + p_precommit_timeout);
        //     h_prevote_timeout   = -1;
        //     p_prevote_timeout   = -1;
        //     h_precommit_timeout = -1;
        //     p_precommit_timeout = -1; 
        //     startPhase(h_p, p_p+1);        
        // }
    }
    catch(err) {
        console.log("bylllloggerror,OnTimeoutPropose:" + err);
    }
}
// Function OnTimeoutPrevote(height, round) :
//     if height=hp ∧ round=roundp ∧ stepp=prevote then 
//         broadcast <PRECOMMIT,hp,roundp,nil>
//         stepp ← precommit
function OnTimeoutPrevote(){
    try{
        if(h_prevote_timeout === h_p && p_prevote_timeout === p_p && step_p === constants.BYZANTINE_PREVOTE){
            // console.log("byllllogg broadcastPrecommit timeout OnTimeoutPrevote:" + h_p + ":" + p_p + ":" + h_prevote_timeout + ":" + p_prevote_timeout + ": null");
            if(assocByzantinePhase[h_prevote_timeout] && 
                typeof assocByzantinePhase[h_prevote_timeout] !== 'undefined' && 
                Object.keys(assocByzantinePhase[h_prevote_timeout]).length > 0){
                pushByzantinePrecommit(h_prevote_timeout, p_prevote_timeout, null, address_p, null, 0);
                broadcastPrecommit(h_prevote_timeout, p_prevote_timeout, null, null);
                step_p = constants.BYZANTINE_PRECOMMIT;
            }
        }
        h_prevote_timeout   = -1;
        p_prevote_timeout   = -1;

        handleByzantine();

        // if proposer down
        // if(!assocByzantinePhase[h_p].phase[p_p].proposal || 
        //     typeof assocByzantinePhase[h_p].phase[p_p].proposal === 'undefined' || 
        //     Object.keys(assocByzantinePhase[h_p].phase[p_p].proposal).length === 0 ||
        //     !assocByzantinePhase[h_p].phase[p_p].proposal.idv ||
        //     typeof assocByzantinePhase[h_p].phase[p_p].proposal.idv === 'undefined'){
        //     console.log("byllllogg timeout startPhase OnTimeoutPrevote:" + h_p + ":" + p_p + ":" + h_precommit_timeout + ":" + p_precommit_timeout);
        //     h_propose_timeout = -1;
        //     p_propose_timeout = -1; 
        //     h_precommit_timeout = -1;
        //     p_precommit_timeout = -1; 
        //     startPhase(h_p, p_p+1);        
        // }
    }
    catch(err) {
        console.log("bylllloggerror,OnTimeoutPrevote:" + err);
    }
}
// Function OnTimeoutPrecommit(height, round) :
//     if height=hp ∧ round=roundp then
//         StartRound(roundp+1)
function OnTimeoutPrecommit(){
    try{
        // console.log("byllllogg timeout startPhase OnTimeoutPrecommit 1:" + h_p + ":" + p_p + ":" + h_precommit_timeout + ":" + p_precommit_timeout);
        if(h_precommit_timeout === h_p && p_precommit_timeout === p_p){
            // console.log("byllllogg timeout startPhase OnTimeoutPrecommit 2:" + h_p + ":" + p_p + ":" + h_precommit_timeout + ":" + p_precommit_timeout);
            startPhase(h_precommit_timeout, p_precommit_timeout+1);
        }
        h_precommit_timeout = -1;
        p_precommit_timeout = -1; 
    }
    catch(err) {
        console.log("bylllloggerror,OnTimeoutPrecommit:" + err);
    }
}
// public function end

// private function begin 
function handleGossipMessage(sKey, gossipMessage, callback){
    try{
        // push the gossip message into local db
        switch(gossipMessage.type){
            case constants.BYZANTINE_PROPOSE: 
                // if I already  have a proposal for the current gossip, ignore it.
                if(typeof assocByzantinePhase[gossipMessage.h] === 'undefined' ||
                        Object.keys(assocByzantinePhase[gossipMessage.h]).length === 0 ||
                        typeof assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p] === 'undefined' ||
                        Object.keys(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p]).length === 0 ||
                        typeof assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].proposal === 'undefined' ||
                        Object.keys(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].proposal).length === 0 ){
                    validation.validateProposalJoint(gossipMessage.v, {
                        ifInvalid: function(err){
                            try{
                                // console.log("byllllogg BYZANTINE_PROPOSE gossip ifInvalid:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address + err);
                                pushByzantineProposal(gossipMessage.h, gossipMessage.p, gossipMessage.v, gossipMessage.vp, 0, function(err){
                                    // console.log("byllllogg push new byzantine proposal from Invalid gossip:" + err);
                                    handleTempGossipMessage(gossipMessage.h, gossipMessage.p);
                                    return callback();
                                });
                            }
                            catch(err) {
                                console.log("bylllloggerror,handleGossipMessage BYZANTINE_PROPOSE ifInvalid:" + err);
                            }
                        },
                        ifNeedWaiting: function(err){
                            try{
                                // console.log("byllllogg BYZANTINE_PROPOSE gossip ifNeedWaiting:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address + err);
                                pushByzantineProposal(gossipMessage.h, gossipMessage.p, gossipMessage.v, gossipMessage.vp, -1, function(err){
                                    // console.log("byllllogg push new byzantine proposal from NeedWaiting gossip:" + err);
                                    handleTempGossipMessage(gossipMessage.h, gossipMessage.p);
                                    return callback();
                                });
                            }
                            catch(err) {
                                console.log("bylllloggerror,handleGossipMessage BYZANTINE_PROPOSE ifNeedWaiting:" + err);
                            }
                        },
                        ifOk: function(){
                            try{
                                // console.log("byllllogg BYZANTINE_PROPOSE gossip ifOk:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                                // if its a new proposal, reset params.
                                if(gossipMessage.vp === -1){
                                    lockedValue_p = null;
                                    lockedPhase_p = -1;
                                    validValue_p  = null;
                                    validPhase_p  = -1;
                                }
                                pushByzantineProposal(gossipMessage.h, gossipMessage.p, gossipMessage.v, gossipMessage.vp, 1,  function(err){
                                    // console.log("byllllogg push new byzantine proposal from ok gossip:" + err);
                                    handleTempGossipMessage(gossipMessage.h, gossipMessage.p);
                                    return callback();
                                });      
                            }
                            catch(err) {
                                console.log("bylllloggerror,handleGossipMessage BYZANTINE_PROPOSE ifOk:" + err);
                            }                
                        }
                    }); 
                }
                break;
            case constants.BYZANTINE_PREVOTE: 
                // console.log("byllllogg BYZANTINE_PREVOTE gossip sKey 1:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                // if gossipMessage.idv is null, then don't need proposal
                if(gossipMessage.idv !== null && (!assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].proposal.idv 
                    || typeof assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].proposal.idv === 'undefined')){
                    // The gossip message cannot be handled for the time being
                    // console.log("byllllogg BYZANTINE_PREVOTE gossip sKey 2:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                    assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].prevote_temp_gossip[sKey+gossipMessage.address] = gossipMessage; 
                    console.log("bylllloggB-BYZANTINE_PREVOTE1-" + h_p + "-" + p_p + " --- step_p:" 
                    + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    + " --- gossipMessage:"+ JSON.stringify(gossipMessage)
                    + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
                    pushReceivedAddresses(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].received_addresses, gossipMessage.address);
                }                    
                else {
                    // console.log("byllllogg BYZANTINE_PREVOTE gossip sKey 3:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                    pushByzantinePrevote(gossipMessage.h, gossipMessage.p, gossipMessage.idv, gossipMessage.address, gossipMessage.idv === null ? 0 : 1);
                    console.log("bylllloggB-BYZANTINE_PREVOTE2-" + h_p + "-" + p_p + " --- step_p:" 
                    + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    + " --- gossipMessage:"+ JSON.stringify(gossipMessage)
                    + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
                }     
                return callback();           
                break;
            case constants.BYZANTINE_PRECOMMIT:
                // console.log("byllllogg BYZANTINE_PRECOMMIT gossip sKey 1:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                if(gossipMessage.idv !==null && (!assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].proposal.idv 
                    || typeof assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].proposal.idv === 'undefined')){
                    // The gossip message cannot be handled for the time being
                    // console.log("byllllogg BYZANTINE_PRECOMMIT gossip sKey 2:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                    assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].precommit_temp_gossip[sKey+gossipMessage.address] = gossipMessage;
                    console.log("bylllloggB-BYZANTINE_PRECOMMIT1-" + h_p + "-" + p_p + " --- step_p:" 
                    + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    + " --- gossipMessage:"+ JSON.stringify(gossipMessage)
                    + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
                    pushReceivedAddresses(assocByzantinePhase[gossipMessage.h].phase[gossipMessage.p].received_addresses, gossipMessage.address);
                }                    
                else {
                    // console.log("byllllogg BYZANTINE_PRECOMMIT gossip sKey 3:" +gossipMessage.h + gossipMessage.p  + "-address:" + gossipMessage.address);
                    pushByzantinePrecommit(gossipMessage.h, gossipMessage.p, gossipMessage.idv, gossipMessage.address, gossipMessage.idv === null ? null : gossipMessage.sig, gossipMessage.idv === null ? 0 : 1);
                    console.log("bylllloggB-BYZANTINE_PRECOMMIT2-" + h_p + "-" + p_p + " --- step_p:" 
                    + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    + " --- gossipMessage:"+ JSON.stringify(gossipMessage)
                    + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
                }
                return callback();
                break;
            default: 
                return callback();
        }
    }
    catch(err) {
        console.log("bylllloggerror,handleGossipMessage:" + err);
    }
}

function handleTempGossipMessage(temp_h, temp_p){
    try{
        // handle temp gossip messages
        Object.keys(assocByzantinePhase[temp_h].phase[temp_p].prevote_temp_gossip).forEach(function(tempKey){    
            var tempMessage = assocByzantinePhase[temp_h].phase[temp_p].prevote_temp_gossip[tempKey];   
            if (tempMessage.type === constants.BYZANTINE_PREVOTE){
                if(assocByzantinePhase[tempMessage.h].phase[tempMessage.p].proposal.idv 
                    && typeof assocByzantinePhase[tempMessage.h].phase[tempMessage.p].proposal.idv !== 'undefined'){
                    pushByzantinePrevoteTemp(tempMessage.h, tempMessage.p, tempMessage.idv, tempMessage.address, tempMessage.idv === null ? 0 : 1);
                    delete assocByzantinePhase[temp_h].phase[temp_p].prevote_temp_gossip[tempKey]; 
                }       
            }
        }); 
        Object.keys(assocByzantinePhase[temp_h].phase[temp_p].precommit_temp_gossip).forEach(function(tempKey){    
            var tempMessage = assocByzantinePhase[temp_h].phase[temp_p].precommit_temp_gossip[tempKey];   
            if (tempMessage.type === constants.BYZANTINE_PRECOMMIT){
                if(assocByzantinePhase[tempMessage.h].phase[tempMessage.p].proposal.idv 
                    && typeof assocByzantinePhase[tempMessage.h].phase[tempMessage.p].proposal.idv !== 'undefined'){
                    pushByzantinePrecommitTemp(tempMessage.h, tempMessage.p, tempMessage.idv, tempMessage.address, tempMessage.idv === null ? null : tempMessage.sig, tempMessage.idv === null ? 0 : 1);
                    delete assocByzantinePhase[temp_h].phase[temp_p].precommit_temp_gossip[tempKey]; 
                }
            }
        }); 
    }
    catch(err) {
        console.log("bylllloggerror,handleTempGossipMessage:" + err);
    }   
}

function handleByzantine(){
    try{
        if(typeof assocByzantinePhase[h_p] !== 'undefined' && 
            typeof assocByzantinePhase[h_p].phase !== 'undefined' &&
            typeof assocByzantinePhase[h_p].phase[p_p] !== 'undefined' &&
            Object.keys(assocByzantinePhase[h_p].phase[p_p]).length > 0){
            // upon <PROPOSAL,hp,roundp,v,−1> from proposer(hp ,roundp) while stepp = propose do
            //     if valid(v) ∧ (lockedRoundp = −1 ∨ lockedValuep = v) then
            //         broadcast <PREVOTE,hp,roundp,id(v)>
            //     else
            //         broadcast <PREVOTE,hp,roundp,nil>
            //     stepp ← prevote
            if(assocByzantinePhase[h_p].phase[p_p].proposal && assocByzantinePhase[h_p].phase[p_p].proposal.vp === -1 && step_p === constants.BYZANTINE_PROPOSE){
                if(assocByzantinePhase[h_p].phase[p_p].proposal.isValid === 1 
                    && (lockedPhase_p === -1 || compareIfValueEqual(lockedValue_p, assocByzantinePhase[h_p].phase[p_p].proposal))){
                    pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 1);
                    // console.log("byllllogg broadcastPrevote 1:" + h_p + ":" + p_p + ":" + assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                    broadcastPrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                }
                else {
                    pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 0);
                    // console.log("byllllogg broadcastPrevote 2:" + h_p + ":" + p_p + ": null");
                    broadcastPrevote(h_p, p_p, null);
                }
                step_p = constants.BYZANTINE_PREVOTE;
            }
            // upon <PROPOSAL,hp,roundp,v,vr> from proposer(hp ,roundp) AND 2f + 1 <PREVOTE,hp ,vr, id(v)> while stepp = propose ∧ (vr ≥ 0 ∧ vr < roundp ) do
            //     if valid(v) ∧ (lockedRoundp ≤ vr ∨ lockedValuep = v) then
            //         broadcast <PREVOTE,hp,roundp,id(v)>
            //     else
            //         broadcast <PREVOTE,hp,roundp,nil>
            //     stepp ← prevote  
            if(assocByzantinePhase[h_p].phase[p_p].proposal.vp >= 0  && assocByzantinePhase[h_p].phase[p_p].proposal.vp < p_p
                && PrevoteBiggerThan2f1(h_p, assocByzantinePhase[h_p].phase[p_p].proposal.vp, 1)
                && step_p === constants.BYZANTINE_PROPOSE ){
                if(assocByzantinePhase[h_p].phase[p_p].proposal.isValid === 1 
                    && (lockedPhase_p <= assocByzantinePhase[h_p].phase[p_p].proposal.vp || compareIfValueEqual(lockedValue_p, assocByzantinePhase[h_p].phase[p_p].proposal))){
                    pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 1);
                    // console.log("byllllogg broadcastPrevote 3:" + h_p + ":" + p_p + ":" + assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                    broadcastPrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                }
                else {
                    pushByzantinePrevote(h_p, p_p, null, address_p, 0);
                    // console.log("byllllogg broadcastPrevote 4:" + h_p + ":" + p_p + ": null");
                    broadcastPrevote(h_p, p_p, null);
                }
                step_p = constants.BYZANTINE_PREVOTE;
            }
            // upon 2f + 1 <PREVOTE,hp,roundp,∗> while stepp = prevote for the first time do
            //     schedule OnTimeoutPrevote(hp,roundp) to be executed after timeoutPrevote(roundp)
            //console.log("byllllogg timeout setTimeout OnTimeoutPrevote:" + PrevoteBiggerThan2f1(h_p, p_p, 2) + ":" +step_p+ ":" +h_prevote_timeout+ ":" +p_prevote_timeout);
            if(PrevoteBiggerThan2f1(h_p, p_p, 2) && step_p === constants.BYZANTINE_PREVOTE){
                if(h_prevote_timeout === -1 && p_prevote_timeout === -1){
                    h_prevote_timeout = h_p;
                    p_prevote_timeout = p_p;
                    var timeout = getTimeout(p_p);
                    // console.log("byllllogg timeout setTimeout OnTimeoutPrevote h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" + step_p + " --- timeout:" + timeout);
                    clearTimeout(timeout_prevote);
                    timeout_prevote = setTimeout(OnTimeoutPrevote, timeout);
                }
            }
            // upon <PROPOSAL,hp,roundp,v,∗> from proposer(hp,roundp) AND 2f+1 <PREVOTE,hp,roundp,id(v)> while valid(v) ∧ stepp ≥ prevote for the first time do ？？？？？？？
            //     if stepp = prevote then
            //         lockedValuep ← v
            //         lockedRoundp ← roundp
            //         broadcast <PRECOMMIT,hp,roundp,id(v)>
            //         stepp ← precommit
            //     validValuep ← v
            //     validRoundp ← roundp
            if(PrevoteBiggerThan2f1(h_p, p_p, 1)
                && assocByzantinePhase[h_p].phase[p_p].proposal.isValid === 1 
                && (step_p === constants.BYZANTINE_PREVOTE || step_p === constants.BYZANTINE_PRECOMMIT)){
                if(step_p === constants.BYZANTINE_PREVOTE){
                    lockedValue_p = _.cloneDeep(assocByzantinePhase[h_p].phase[p_p].proposal);
                    lockedPhase_p = p_p;
                    // console.log("byllllogg broadcastPrecommit PrevoteBiggerThan2f1:" + h_p + ":" + p_p + ":" +assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                    pushByzantinePrecommit(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, assocByzantinePhase[h_p].phase[p_p].proposal.sig, 1);
                    broadcastPrecommit(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.sig, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                    step_p = constants.BYZANTINE_PRECOMMIT;
                }
                validValue_p = _.cloneDeep(assocByzantinePhase[h_p].phase[p_p].proposal);
                validPhase_p = p_p;
            }
            // upon 2f+1 <PREVOTE,hp,roundp,nil> while stepp=prevote do
            //     broadcast <PRECOMMIT,hp,roundp,nil>
            //     step p ← precommit
            if(PrevoteBiggerThan2f1(h_p, p_p, 0) && step_p === constants.BYZANTINE_PREVOTE){
                // console.log("byllllogg broadcastPrecommit PrevoteBiggerThan2f1:" + h_p + ":" + p_p + ": null");
                pushByzantinePrecommit(h_p, p_p, null, address_p, null, 0);
                broadcastPrecommit(h_p, p_p, null, null);
                step_p = constants.BYZANTINE_PRECOMMIT;
            }
            // upon 2f + 1 <PRECOMMIT,hp,roundp ,∗> for the first time do
            //     schedule OnTimeoutPrecommit(hp,roundp) to be executed after timeoutPrecommit(roundp)
            if(PrecommitBiggerThan2f1(h_p, p_p, 2)){
                if(h_precommit_timeout === -1 && p_precommit_timeout === -1){
                    h_precommit_timeout = h_p;
                    p_precommit_timeout = p_p;
                    var timeout = getTimeout(p_p);
                    // console.log("byllllogg timeout setTimeout OnTimeoutPrecommit h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" + step_p + " --- timeout:" + timeout);
                    clearTimeout(timeout_precommit);
                    timeout_precommit = setTimeout(OnTimeoutPrecommit, timeout);
                }
            }
        
            // upon <PROPOSAL,hp,r,v,∗> from proposer(hp,r) AND 2f+1 <PRECOMMIT,hp,r,id(v)> while decisionp[hp]=nil do
            //     if valid(v) then
            //         decisionp[hp]=v
            //         hp ← hp+1
            //         reset lockedRoundp,lockedValuep,validRoundp and validValuep to initial values and empty message log
            //         StartRound(0)
            // function onDecisionError(phase){
            //     console.log("byllllog startPhase onDecisionError:" + h_p + ":" + p_p);
            //     startPhase(h_p, phase++);          
            // }
            // function onDecisionDone(){
            //     console.log("byllllogg onDecisionDone" + " --- h_p:" + h_p + " --- p_p:" + p_p);
            // }

            // console.log("byllllogl " + h_p + "-" + p_p + " --- step_p:" 
            // + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p);

            if(assocByzantinePhase[h_p].decision === null || Object.keys(assocByzantinePhase[h_p].decision).length === 0){
                Object.keys(assocByzantinePhase[h_p].phase).forEach(function(current_p){
                    current_p = parseInt(current_p);
                    if(current_p === p_p && current_p === assocByzantinePhase[h_p].phase[current_p].proposal.phase && 
                        assocByzantinePhase[h_p].phase[current_p].proposal.isValid === 1 && PrecommitBiggerThan2f1(h_p, current_p, 1)){
                        if(assocByzantinePhase[h_p].phase[current_p].proposal.address === address_p){
                            assocByzantinePhase[h_p].decision = assocByzantinePhase[h_p].phase[current_p].proposal;
                            // compose new trustme unit
                            return decisionTrustMe(assocByzantinePhase[h_p].phase[current_p].proposal, assocByzantinePhase[h_p].phase[current_p].precommit_approved);
                            // test code
                            // if(address_p === "4T7YVRUWMVAJIBSWCP35C7OGCX33SAYO" && h_p === 15 && current_p === 3)
                            // {
                            //     console.log("byllllogg must shutdown for test");
                            // }
                            // else{
                            //     return decisionTrustMe(assocByzantinePhase[h_p].phase[current_p].proposal, assocByzantinePhase[h_p].phase[current_p].precommit_approved);
                            // }
                        }
                        else{  // not proposer, wait forever
                            // h_prevote_timeout = h_p;
                            // p_prevote_timeout = p_p;
                            clearTimeout(timeout_propose);
                            clearTimeout(timeout_prevote);
                            clearTimeout(timeout_precommit);
                            waitingProposer = assocByzantinePhase[h_p].phase[current_p].proposal.address;  // set waitingProposer
                            // timeout_p = setTimeout(OnTimeoutPrecommit, 300000);
                        }
                    }
                    // upon f+1 <∗,hp,round,∗,∗> with round>roundp do
                    //     StartRound(round)
                    if(current_p > p_p){
                        if(assocByzantinePhase[h_p].phase[current_p].received_addresses &&
                            assocByzantinePhase[h_p].phase[current_p].received_addresses.length > 0){
                            // console.log("byllllogg byzantine startPhase received_addresses:" + JSON.stringify(assocByzantinePhase[h_p].phase[current_p].received_addresses)+"---waitingProposer:"+waitingProposer);
                            if(assocByzantinePhase[h_p].phase[current_p].received_addresses.length >= constants.TOTAL_BYZANTINE + 1){
                                // console.log("byllllogg byzantine startPhase received_addresses" + h_p + ":" + p_p);
                                startPhase(h_p, current_p);
                            }
                            else if (waitingProposer !== "" && assocByzantinePhase[h_p].phase[current_p].received_addresses.indexOf(waitingProposer) !== -1){
                                // console.log("byllllogg byzantine startPhase waitingProposer" + h_p + ":" + p_p);
                                // reset validValue_p and validPhase_p, the previous Byzantine was abolished
                                validValue_p  = null;
                                validPhase_p  = -1;
                                startPhase(h_p, current_p);
                            }
                        }                
                    }
                });
            }
        }    
    }
    catch(err) {
        console.log("bylllloggerror,handleByzantine:" + err);
    } 
}

function composeProposalMessage(hp, pp, proposal, vpp){
    return {"type": constants.BYZANTINE_PROPOSE,
            "address": address_p,
            "h": hp,
            "p": pp,
            "v": proposal,
            "vp": vpp};
}
function composePrevoteMessage(hp, pp, idv){
    return {"type": constants.BYZANTINE_PREVOTE,
            "address": address_p,
            "h": hp,
            "p": pp,
            "idv": idv};
}
function composePrecommitMessage(hp, pp, sig, idv){
    return {"type": constants.BYZANTINE_PRECOMMIT,
            "address": address_p,
            "h": hp,
            "p": pp,
            "sig":sig,
            "idv": idv};
}
function broadcastProposal(h, p, value, vp){
    // console.log("byllllogg bylllloggbyllllogg in broadcastProposal:" + h + ":" + p + ":" + JSON.stringify(value) + ":" + vp);
    gossiper.gossiperBroadcast("proposal", composeProposalMessage(h, p, value, vp), function(err){
        if(err)
            return console.log("byllllogg broadcastProposal err:" + err);
    });
}
function broadcastPrevote(h, p, idv){
    // console.log("byllllogg bylllloggbyllllogg in broadcastPrevote:" + h + ":" + p + ":" + JSON.stringify(idv));
    last_prevote_gossip = composePrevoteMessage(h, p, idv);
    gossiper.gossiperBroadcast("prevote", last_prevote_gossip, function(err){
        if(err)
            console.log("byllllogg broadcastPrevote err:" + err);
    });
}
function broadcastPrecommit(h, p, sig, idv){
    // console.log("byllllogg bylllloggbyllllogg in broadcastPrecommit:" + h + ":" + p + ":" + JSON.stringify(idv));
    last_precommit_gossip = composePrecommitMessage(h, p, sig, idv);
    gossiper.gossiperBroadcast("precommit", last_precommit_gossip, function(err){
        if(err)
            console.log("byllllogg broadcastPrecommit err:" + err);
    });
    // test code
    // if(h === 15 && (p === 0 || p === 1 || p === 2)){
    //     last_precommit_gossip = composePrecommitMessage(h, p, null, null);
    //     gossiper.gossiperBroadcast("precommit", last_precommit_gossip, function(err){
    //         if(err)
    //             console.log("byllllogg broadcastPrecommit err:" + err);
    //     });
    // }
    // else{
    //     last_precommit_gossip = composePrecommitMessage(h, p, sig, idv);
    //     gossiper.gossiperBroadcast("precommit", last_precommit_gossip, function(err){
    //         if(err)
    //             console.log("byllllogg broadcastPrecommit err:" + err);
    //     });
    // }
}
function getTimeout(p){
    return constants.BYZANTINE_GST + constants.BYZANTINE_DELTA*p;
}
function convertJointToProposal(joint, vp, isValid){
    return {
        "address":joint.proposer[0].address,
        "unit":joint.unit,
        "idv":objectHash.getProposalUnitHash(joint.unit),
        "sig":{},
        "vp":vp,
        "isValid":isValid,
        "proposer":joint.proposer,
        "phase":joint.phase,
        "last_ball_mci":joint.last_ball_mci
    };
}
function pushByzantineProposal(h, p, tempProposal, vp, isValid, onDone) {
    var proposal = _.cloneDeep(tempProposal);
    if(proposal === null || typeof proposal === 'undefined'
        || proposal.unit === null || typeof proposal.unit === 'undefined'){
        //return onDone("proposal or unit can not be null");
        throw Error("proposal or unit can not be null");
    }
    
    composer.composeCoordinatorSig(address_p, proposal.unit, supernode.signerProposal, function(err, objAuthor){
        try{
            if(err)
                //return onDone(err);
                throw Error(err);
            proposal.sig = objAuthor;
            proposal.vp = vp;
            proposal.isValid = isValid;        
            // mutex.lock( [ "assocByzantinePhase["+h+"].phase["+p+"]" ], function( unlock ){
                if(!assocByzantinePhase[h].phase[p] || 
                    typeof assocByzantinePhase[h].phase[p] === 'undefined' || 
                    Object.keys(assocByzantinePhase[h].phase[p]).length === 0){
                    // console.log("bylllloggP-pushByzantineProposal-" + h_p + "-" + p_p + " --- step_p:" 
                    //     + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    //     + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase[h]));
                    assocByzantinePhase[h].phase[p] = {"proposal":proposal, "received_addresses":[],
                        "prevote_approved":[], "prevote_opposed":[], "prevote_temp_gossip":{},
                        "precommit_approved":[], "precommit_opposed":[], "precommit_temp_gossip":{}}; 
                    
                }      
                else {
                    assocByzantinePhase[h].phase[p].proposal = proposal;            
                }
                pushReceivedAddresses(assocByzantinePhase[h].phase[p].received_addresses, proposal.address);
                // unlock();
                onDone();
            // });
        }
        catch(err) {
            console.log("bylllloggerror,pushByzantineProposal composeCoordinatorSig:" + err);
        } 
    });    
}
// isApproved: 1 approved ; 0 opposed
function pushByzantinePrevote(h, p, idv, address, isApproved) {
    try{
        if(address !== null ){
            // mutex.lock( [ "assocByzantinePhase["+h+"].phase["+p+"]" ], function( unlock ){
                if(!assocByzantinePhase[h].phase[p] || 
                    typeof assocByzantinePhase[h].phase[p] === 'undefined' || 
                    Object.keys(assocByzantinePhase[h].phase[p]).length === 0){
                    // console.log("bylllloggP-pushByzantinePrevote-" + h_p + "-" + p_p + " --- step_p:" 
                    //     + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    //     + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase[h]));
                    assocByzantinePhase[h].phase[p] =  {"proposal":{}, "received_addresses":[],
                    "prevote_approved":[], "prevote_opposed":[], "prevote_temp_gossip":{},
                    "precommit_approved":[], "precommit_opposed":[], "precommit_temp_gossip":{}};     
                }
                if(assocByzantinePhase[h].phase[p].prevote_approved.indexOf(address) === -1 && assocByzantinePhase[h].phase[p].prevote_opposed.indexOf(address) === -1){
                    // console.log("byllllogg BYZANTINE_PREVOTE:" +h + p + "-1-idv:"+idv + "-pidv:" + assocByzantinePhase[h].phase[p].proposal.idv + "-address:" 
                        // + address+"-isApproved:"+isApproved+":"+(isApproved === 1)+ (assocByzantinePhase[h].phase[p].proposal.idv === idv));
                    if(isApproved === 1 && assocByzantinePhase[h].phase[p].proposal.idv === idv && assocByzantinePhase[h].phase[p].proposal.isValid === 1){  
                        // console.log("byllllogg BYZANTINE_PREVOTE:" +h + p + "-2-idv:"+idv + "-address:" + address+"-isApproved:"+isApproved);
                        assocByzantinePhase[h].phase[p].prevote_approved.push(address);
                    }
                    else{
                        // console.log("byllllogg BYZANTINE_PREVOTE:" +h + p + "-3-idv:"+idv + "-address:" + address+"-isApproved:"+isApproved);
                        assocByzantinePhase[h].phase[p].prevote_opposed.push(address);
                    }
                    pushReceivedAddresses(assocByzantinePhase[h].phase[p].received_addresses, address);
                }
            //     unlock();
            // });
        }   
    }
    catch(err) {
        console.log("bylllloggerror,pushByzantinePrevote:" + err);
    } 
}
// push byzantine prevote message of temp gossip, don't consider isValid, don't push received_addresses
// isApproved: 1 approved ; 0 opposed
function pushByzantinePrevoteTemp(h, p, idv, address, isApproved) {
    try{
        if(address !== null ){
            // mutex.lock( [ "assocByzantinePhase["+h+"].phase["+p+"]" ], function( unlock ){
                if(!assocByzantinePhase[h].phase[p] || 
                    typeof assocByzantinePhase[h].phase[p] === 'undefined' || 
                    Object.keys(assocByzantinePhase[h].phase[p]).length === 0){
                    // console.log("bylllloggP-pushByzantinePrevoteTemp-" + h_p + "-" + p_p + " --- step_p:" 
                    // + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                    // + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase[h]));
                    assocByzantinePhase[h].phase[p] =  {"proposal":{}, "received_addresses":[],
                    "prevote_approved":[], "prevote_opposed":[], "prevote_temp_gossip":{},
                    "precommit_approved":[], "precommit_opposed":[], "precommit_temp_gossip":{}};     
                }
                if(assocByzantinePhase[h].phase[p].prevote_approved.indexOf(address) === -1 && assocByzantinePhase[h].phase[p].prevote_opposed.indexOf(address) === -1){
                    // console.log("byllllogg BYZANTINE_PREVOTE:" +h + p + "-4-idv:"+idv + "-pidv:" + assocByzantinePhase[h].phase[p].proposal.idv + "-address:" 
                        // + address+"-isApproved:"+isApproved+":"+(isApproved === 1)+ (assocByzantinePhase[h].phase[p].proposal.idv === idv));
                    if(isApproved === 1 && assocByzantinePhase[h].phase[p].proposal.idv === idv){  
                        // console.log("byllllogg BYZANTINE_PREVOTE:" +h + p + "-5-idv:"+idv + "-address:" + address+"-isApproved:"+isApproved);
                        assocByzantinePhase[h].phase[p].prevote_approved.push(address);
                    }
                    else{
                        // console.log("byllllogg BYZANTINE_PREVOTE:" +h + p + "-6-idv:"+idv + "-address:" + address+"-isApproved:"+isApproved);
                        assocByzantinePhase[h].phase[p].prevote_opposed.push(address);
                    }
                }
            //     unlock();
            // });
        }   
    }
    catch(err) {
        console.log("bylllloggerror,pushByzantinePrevoteTemp:" + err);
    } 
}
// isApproved: 1 approved ; 0 opposed
function pushByzantinePrecommit(h, p, idv, address, sig, isApproved) {
    try{
        var ifIncluded = false;
        // mutex.lock( [ "assocByzantinePhase["+h+"].phase["+p+"]" ], function( unlock ){
            if(!assocByzantinePhase[h].phase[p] || 
                typeof assocByzantinePhase[h].phase[p] === 'undefined' || 
                Object.keys(assocByzantinePhase[h].phase[p]).length === 0){
                // console.log("bylllloggP-pushByzantinePrecommit-" + h_p + "-" + p_p + " --- step_p:" 
                //     + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                //     + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase[h]));
                assocByzantinePhase[h].phase[p] = {"proposal":{}, "received_addresses":[],
                "prevote_approved":[], "prevote_opposed":[], "prevote_temp_gossip":{},
                "precommit_approved":[], "precommit_opposed":[], "precommit_temp_gossip":{}};   
            }
            else{
                for (var j=0; j<assocByzantinePhase[h].phase[p].precommit_approved.length; j++){
                    if(sig && assocByzantinePhase[h].phase[p].precommit_approved[j] && assocByzantinePhase[h].phase[p].precommit_approved[j].address === sig.address){
                        ifIncluded = true;
                        break;
                    }
                }
            }
            if(address !== null && !ifIncluded && assocByzantinePhase[h].phase[p].precommit_opposed.indexOf(address) === -1){
                if(isApproved === 1 && sig !== null && sig.address !== null && sig.address === address 
                    && assocByzantinePhase[h].phase[p].proposal.idv === idv && assocByzantinePhase[h].phase[p].proposal.isValid === 1){
                    assocByzantinePhase[h].phase[p].precommit_approved.push(sig);
                }
                // else if (isApproved === 0){  // ???
                else {  
                    assocByzantinePhase[h].phase[p].precommit_opposed.push(address);
                }
                pushReceivedAddresses(assocByzantinePhase[h].phase[p].received_addresses, address);
            }    
            // unlock();
        // });
    }
    catch(err) {
        console.log("bylllloggerror,pushByzantinePrecommit:" + err);
    } 
}
// push byzantine precommit message of temp gossip, don't consider isValid, don't push received_addresses
// isApproved: 1 approved ; 0 opposed
function pushByzantinePrecommitTemp(h, p, idv, address, sig, isApproved) {
    try{
        var ifIncluded = false;
        // mutex.lock( [ "assocByzantinePhase["+h+"].phase["+p+"]" ], function( unlock ){
            if(!assocByzantinePhase[h].phase[p] || 
                typeof assocByzantinePhase[h].phase[p] === 'undefined' || 
                Object.keys(assocByzantinePhase[h].phase[p]).length === 0){
                // console.log("bylllloggP-pushByzantinePrecommitTemp-" + h_p + "-" + p_p + " --- step_p:" 
                //     + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
                //     + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase[h]));
                assocByzantinePhase[h].phase[p] = {"proposal":{}, "received_addresses":[],
                "prevote_approved":[], "prevote_opposed":[], "prevote_temp_gossip":{},
                "precommit_approved":[], "precommit_opposed":[], "precommit_temp_gossip":{}};   
            }
            else{
                for (var j=0; j<assocByzantinePhase[h].phase[p].precommit_approved.length; j++){
                    if(sig && assocByzantinePhase[h].phase[p].precommit_approved[j] && assocByzantinePhase[h].phase[p].precommit_approved[j].address === sig.address){
                        ifIncluded = true;
                        break;
                    }
                }
            }
            if(address !== null && !ifIncluded && assocByzantinePhase[h].phase[p].precommit_opposed.indexOf(address) === -1){
                if(isApproved === 1 && sig !== null && sig.address !== null && sig.address === address 
                    && assocByzantinePhase[h].phase[p].proposal.idv === idv){
                    assocByzantinePhase[h].phase[p].precommit_approved.push(sig);
                }
                // else if (isApproved === 0){  // ???
                else {  
                    assocByzantinePhase[h].phase[p].precommit_opposed.push(address);
                }
            }    
            // unlock();
        // });
    }
    catch(err) {
        console.log("bylllloggerror,pushByzantinePrecommitTemp:" + err);
    } 
}
function compareIfValueEqual(v1, v2){
    return objectHash.getProposalUnitHash(v1.unit) === objectHash.getProposalUnitHash(v2.unit);
}
// isApproved: 1 approved ; 0 opposed; 2 all
function PrevoteBiggerThan2f1(h, p, isApproved){
    // console.log("byllllogg timeout setTimeout OnTimeoutPrevote PrevoteBiggerThan2f1"+h+p+isApproved+":" + JSON.stringify(assocByzantinePhase[h].phase[p]));
    if(isApproved === 1)
        return assocByzantinePhase[h].phase[p].prevote_approved.length >= constants.TOTAL_BYZANTINE*2 + 1;
    else if(isApproved === 0)
        return assocByzantinePhase[h].phase[p].prevote_opposed.length >= constants.TOTAL_BYZANTINE*2 + 1;
    else if(isApproved === 2)
        return (assocByzantinePhase[h].phase[p].prevote_approved.length + assocByzantinePhase[h].phase[p].prevote_opposed.length + Object.keys(assocByzantinePhase[h].phase[p].prevote_temp_gossip).length) >= constants.TOTAL_BYZANTINE*2 + 1;    
    else 
        return false;
}
// isApproved: 1 approved ; 0 opposed; 2 all
function PrecommitBiggerThan2f1(h, p, isApproved){
    if(isApproved === 1)
        return assocByzantinePhase[h].phase[p].precommit_approved.length >= constants.TOTAL_BYZANTINE*2 + 1;
    else if(isApproved === 0)
        return assocByzantinePhase[h].phase[p].precommit_opposed.length >= constants.TOTAL_BYZANTINE*2 + 1;
    else if(isApproved === 2)
        return (assocByzantinePhase[h].phase[p].precommit_approved.length + assocByzantinePhase[h].phase[p].precommit_opposed.length + Object.keys(assocByzantinePhase[h].phase[p].precommit_temp_gossip).length) >= constants.TOTAL_BYZANTINE*2 + 1;    
    else 
        return false;
}

function pushReceivedAddresses(arrAddresses, address){
    if (arrAddresses.indexOf(address) === -1)
        arrAddresses.push(address);
}

function decisionTrustMe(proposal, approvedCoordinators) {
    eventBus.emit( 'byzantine_success', address_p, proposal, approvedCoordinators );    
}

function doStartPhase(hp, phase){
    // console.log("byllllog startPhase onDecisionError:" + hp + ":" + phase);
    startPhase(hp, phase);          
}

// private function end

// Send the last message at fixed intervals
function gossipLastMessageAtFixedInterval(){
    if(p_phase_timeout >0 && Date.now() - p_phase_timeout > constants.BYZANTINE_PHASE_TIMEOUT){

        if(bByzantineUnderWay && last_prevote_gossip &&
            typeof last_prevote_gossip !== 'undefined' &&
            Object.keys(last_prevote_gossip).length > 0){
            if(last_prevote_gossip.type === constants.BYZANTINE_PREVOTE && h_p === last_prevote_gossip.h){
                // console.log("byllllogg gossipLastMessageAtFixedInterval broadcastPrevote" + JSON.stringify(last_prevote_gossip));
                broadcastPrevote(last_prevote_gossip.h, last_prevote_gossip.p, last_prevote_gossip.idv);
            }
        }
        if(bByzantineUnderWay && last_precommit_gossip &&
            typeof last_precommit_gossip !== 'undefined' &&
            Object.keys(last_precommit_gossip).length > 0){
            if(last_precommit_gossip.type === constants.BYZANTINE_PRECOMMIT && h_p === last_precommit_gossip.h){
                if(last_precommit_gossip.idv !== null && assocByzantinePhase[last_precommit_gossip.h].phase[last_precommit_gossip.p].proposal
                    && typeof assocByzantinePhase[last_precommit_gossip.h].phase[last_precommit_gossip.p].proposal !== 'undefined'){
                    var lastProposal = assocByzantinePhase[last_precommit_gossip.h].phase[last_precommit_gossip.p].proposal;
                    broadcastProposal(last_precommit_gossip.h, last_precommit_gossip.p, lastProposal, lastProposal.vp);
                }
                // console.log("byllllogg gossipLastMessageAtFixedInterval broadcastPrecommit" + JSON.stringify(last_precommit_gossip));
                broadcastPrecommit(last_precommit_gossip.h, last_precommit_gossip.p, last_precommit_gossip.sig, last_precommit_gossip.idv);
            }        
        }
    }
}

// setInterval(gossipLastMessageAtFixedInterval, 3*1000);

function consoleLog(){
    console.log("byllllogl-" + h_p + "-" + p_p + " --- step_p:" + step_p + " --- last_main_chain_index:" + last_main_chain_index 
    + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p  + " --- waitingProposer:" + waitingProposer
    + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
}

if(conf.IF_BYZANTINE)
    setInterval(consoleLog, 10*1000);

// Send the last message end

eventBus.on('updated_last_round_index_from_peers', function (nLastRoundIndexFromPeers, nLastMainChainIndexFromPeers){
    if ( last_round_index < nLastRoundIndexFromPeers )        
    {
        last_round_index = nLastRoundIndexFromPeers;
    }
    if ( last_main_chain_index < nLastMainChainIndexFromPeers )        
    {
        last_main_chain_index = nLastMainChainIndexFromPeers;
    }
})

// cache begin

function shrinkByzantineCache(){
    try{
        // shrink assocByzantinePhase
        var arrByzantinePhases = Object.keys(assocByzantinePhase);
        var maxIndexByzantinePhases = Math.max.apply(Math, arrByzantinePhases);
        if (arrByzantinePhases.length > constants.MAX_BYZANTINE_IN_CACHE){
            arrByzantinePhases.forEach(function(byzantinePhase){ 
                if(byzantinePhase < maxIndexByzantinePhases - constants.MAX_BYZANTINE_IN_CACHE)
                    delete assocByzantinePhase[byzantinePhase];    
            });
        }
        arrByzantinePhases = Object.keys(assocByzantinePhase);
        
        arrByzantinePhases.forEach(function(byzantinePhase){ 
            if(assocByzantinePhase[byzantinePhase] &&
            typeof assocByzantinePhase[byzantinePhase] !== 'undefined' &&
            Object.keys(assocByzantinePhase[byzantinePhase]).length > 0){
                var phaseCount = Object.keys(assocByzantinePhase[byzantinePhase].phase).length;
                console.log("byllllogg222222 delete hp phase:" + phaseCount);
                if(phaseCount > constants.MAX_BYZANTINE_PHASE_IN_CACHE){
                    var arrByzantinePhasesNumber = Object.keys(assocByzantinePhase[byzantinePhase].phase);
                    var maxIndexByzantinePhasesNumber = Math.max.apply(Math, arrByzantinePhasesNumber);
                    console.log("byllllogg333333 delete hp phase:" + maxIndexByzantinePhasesNumber);
                    arrByzantinePhasesNumber.forEach(function(byzantinePhaseNumber){
                        if(byzantinePhaseNumber < maxIndexByzantinePhasesNumber - constants.MAX_BYZANTINE_PHASE_IN_CACHE){
                            console.log("byllllogg444444 ByzantinePhaseCacheLog:shrinkByzantineCache,delete hp phase:" + byzantinePhaseNumber);
                            delete assocByzantinePhase[byzantinePhase].phase[byzantinePhaseNumber];
                        }
                    });                
                }
            }
        });
    }
    catch(err) {
        console.log("bylllloggerror,shrinkByzantineCache:" + err);
    } 
}

setInterval(shrinkByzantineCache, 12*1000);

// cache end


//	@exports

exports.getCoordinators = getCoordinators;
exports.doStartPhase = doStartPhase;
