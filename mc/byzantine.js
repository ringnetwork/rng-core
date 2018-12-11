/*jslint node: true */
"use strict";

var constants = require('../config/constants.js');
//var conf = require('../config/conf.js');
var db = require('../db/db.js');
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

var MAX_BYZANTINE_IN_CACHE = 10;

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

var assocByzantinePhase = {};

var maxGossipHp = 1;
var bByzantineUnderWay = false;
var bTrustMeUnderWay = false;

// init function begin

/**
 * init byzantine, executes at startup
 */
function initByzantine(){
    if(bByzantineUnderWay)
        return;
    console.log("byzantine:initByzantine, h_p:" + h_p + ", p_p:" + p_p);
    db.query("SELECT address FROM my_addresses", [], 
        function(rowsAddress){
            if (rowsAddress.length === 0)
                throw Error("no addresses");
            if (rowsAddress.length > 1)
                throw Error("more than 1 address");
            address_p = rowsAddress[0].address;
        
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
                            startPhase(hp, 0);
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
    );
}
eventBus.on( 'headless_wallet_ready', () =>
{
    initByzantine();
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
    console.log("bylllog getCoordinators in:" + hp + ":" + phase);
    if (assocByzantinePhase[hp] && assocByzantinePhase[hp].roundIndex && assocByzantinePhase[hp].witnesses){
        var pIndex = Math.abs(hp-phase)%constants.TOTAL_COORDINATORS;
        console.log("bylllog getCoordinators assocByzantinePhase in:" + assocByzantinePhase[hp].witnesses[pIndex] + ":" + JSON.stringify(assocByzantinePhase[hp].witnesses));
        return cb(null, assocByzantinePhase[hp].witnesses[pIndex], assocByzantinePhase[hp].roundIndex, assocByzantinePhase[hp].witnesses);
    }
    if(!validationUtils.isPositiveInteger(hp))
        return cb("param hp is not a positive integer");
    if(!validationUtils.isNonnegativeInteger(phase))
        return cb("param phase is not a positive integer");
    var conn = conn || db;
    round.getRoundIndexByNewMci(conn, hp, function(roundIndex){
        console.log("bylllog getCoordinators getRoundIndexByNewMci in:" + roundIndex);
        round.getWitnessesByRoundIndex(conn, roundIndex, function(witnesses){
            console.log("bylllog getCoordinators getWitnessesByRoundIndex in:" + roundIndex + ":" + JSON.stringify(witnesses));
            if(!assocByzantinePhase[hp]){
                assocByzantinePhase[hp] = {};
                assocByzantinePhase[hp].roundIndex = roundIndex;
                assocByzantinePhase[hp].witnesses = witnesses;
                assocByzantinePhase[hp].phase = {};
                assocByzantinePhase[hp].decision = {};
            }
            var pIndex = Math.abs(hp-phase)%constants.TOTAL_COORDINATORS;
            cb(null, witnesses[pIndex], roundIndex, witnesses);
        });        
    });
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
    if(!validationUtils.isValidAddress(address_p)){
        console.log("address_p not known yet");
		setTimeout(function(){
			startPhase(hp, phase);
		}, 1000);
		return;    
    }
    console.log("bylllog bylllogbylllogbylllogbylllogbylllogbylllog startPhase, h_p:" + h_p + ", p_p:" + p_p + ", hp:" + hp + ", phase:" + phase);
    if(h_p > hp)
        return;
    else if(h_p === hp && p_p >= phase)
        return;
    h_p = hp;
    p_p = phase;
    step_p = constants.BYZANTINE_PROPOSE;   // propose
    getCoordinators(null, h_p, p_p, function(err, proposer, roundIndex, witnesses){
        if(err)
            throw Error("startPhase get proposer err" + err);
        if(witnesses.indexOf(address_p) === -1)
            return ;
        if(!validationUtils.isValidAddress(proposer))
            throw Error("startPhase proposer address is not a valid address");
        bByzantineUnderWay = true;
        if(proposer === address_p){
            if(!assocByzantinePhase[h_p].phase[p_p]){
                if(validValue_p !== null){
                    pushByzantineProposal(h_p, p_p, validValue_p, validPhase_p, 1, function(err){
                        if(err)
                            throw Error("push valid byzantine proposal error:" + err);
                        pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 1);
                        assocByzantinePhase[h_p].decision = {};
                        console.log("bylllog before broadcastProposal startPhase:" + h_p + ":" + p_p + ":" + JSON.stringify(validValue_p) + ":" + validPhase_p);
                        broadcastProposal(h_p, p_p, validValue_p, validPhase_p);
                        console.log("bylllog broadcastPrevote startPhase:" + h_p + ":" + h_p + ":"+assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                        broadcastPrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                    });
                }
                else{
                    composer.composeProposalJoint(proposer, roundIndex, h_p, p_p, supernode.signerProposal, 
                        function(err, objJoint){
                            if(err)
                                throw Error("startPhase compose proposal joint err" + err);
                            var proposal = convertJointToProposal(objJoint, validPhase_p, 1);
                            validation.validateProposalJoint(proposal, {
                                ifInvalid: function(err){
                                    throw Error("??????startPhase my proposer is Invalid:" + err +",objJoint:" + JSON.stringify(objJoint));
                                },
                                ifNeedWaiting: function(err){
                                    throw Error("??????startPhase my proposer need waiting?" + err);
                                },
                                ifOk: function(){
                                    pushByzantineProposal(h_p, p_p, proposal, validPhase_p, 1, function(err){
                                        if(err)
                                            throw Error("push new byzantine proposal error:" + err);
                                        pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 1);
                                        assocByzantinePhase[h_p].decision = {};
                                        console.log("bylllog broadcastProposal startPhase:" + h_p + ":" + p_p + ":" + JSON.stringify(objJoint) + ":" + validPhase_p);
                                        broadcastProposal(h_p, p_p, proposal, validPhase_p);
                                        console.log("bylllog broadcastPrevote startPhase:" + h_p + ":" + h_p + ":"+assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                                        broadcastPrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                                    });
                                }
                            });                        
                        }
                    ); 
                }
            }
        }
        else{
            assocByzantinePhase[h_p].decision = {};
            h_propose_timeout = h_p;
            p_propose_timeout = p_p;
            setTimeout(OnTimeoutPropose, getTimeout(p_p));
        }
    });
}

/**
 *  byzantine gossip message event
 */
eventBus.on('byzantine_gossip', function(sPeerUrl, sKey, gossipMessage ) {
    console.log("bylllog bylllogbylllogbylllogbylllog byzantine_gossip sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl 
        + " --- gossipMessage:" + JSON.stringify(gossipMessage) + " --- assocByzantinePhase:" + JSON.stringify(assocByzantinePhase) + 
        " --- h_p:" + h_p + " --- p_p:" + p_p );
    if(maxGossipHp < gossipMessage.h) { // update max gossip h
        console.log("bylllog maxGossipHp < gossipMessage.h:" + maxGossipHp + gossipMessage.h);
        maxGossipHp = gossipMessage.h;
    }
    if(!bByzantineUnderWay || gossipMessage.h < h_p){
        console.log("bylllog !bByzantineUnderWay || gossipMessage.h < h_p:" + bByzantineUnderWay + h_p);
        return;
    }
    if(!validationUtils.isValidAddress(address_p)){
        console.log("bylllog isValidAddress:" + address_p);
        return;    
    }
    getCoordinators(null, gossipMessage.h, gossipMessage.p, function(err, proposer, roundIndex, witnesses){
        console.log("bylllog byzantine_gossip getCoordinators callback:" + JSON.stringify(witnesses) + ":" + address_p);
        if(witnesses.indexOf(address_p) === -1)
            return;
        switch(gossipMessage.type){
            case constants.BYZANTINE_PROPOSE: 
                validation.validateProposalJoint(gossipMessage.v, {
                    ifInvalid: function(){
                        console.log("bylllog BYZANTINE_PROPOSE ifInvalid:" );
                        pushByzantineProposal(gossipMessage.h, gossipMessage.p, gossipMessage.v, gossipMessage.vp, 0, function(err){
                            console.log("push new byzantine proposal from Invalid gossip error:" + err);
                        });
                    },
                    ifNeedWaiting: function(){
                        console.log("bylllog BYZANTINE_PROPOSE ifNeedWaiting:" );
                        pushByzantineProposal(gossipMessage.h, gossipMessage.p, gossipMessage.v, gossipMessage.vp, -1, function(err){
                            console.log("push new byzantine proposal from NeedWaiting gossip error:" + err);
                        });
                    },
                    ifOk: function(){
                        console.log("bylllog BYZANTINE_PROPOSE ifOk:" );
                        pushByzantineProposal(gossipMessage.h, gossipMessage.p, gossipMessage.v, gossipMessage.vp, 1,  function(err){
                            console.log("push new byzantine proposal from ok gossip error:" + err);
                        });
                    }
                });            
                break;
            case constants.BYZANTINE_PREVOTE: 
                console.log("bylllog BYZANTINE_PREVOTE:" );
                pushByzantinePrevote(gossipMessage.h, gossipMessage.p, gossipMessage.idv, gossipMessage.address, gossipMessage.idv === null ? 0 : 1);
                break;
            case constants.BYZANTINE_PRECOMMIT:
                console.log("bylllog BYZANTINE_PRECOMMIT:" );
                pushByzantinePrecommit(gossipMessage.h, gossipMessage.p, gossipMessage.idv, gossipMessage.address, gossipMessage.idv === null ? null : gossipMessage.sig, gossipMessage.idv === null ? 0 : 1);
                break;
            default: 
        }
        // upon <PROPOSAL,hp,roundp,v,−1> from proposer(hp ,roundp) while stepp = propose do
        //     if valid(v) ∧ (lockedRoundp = −1 ∨ lockedValuep = v) then
        //         broadcast <PREVOTE,hp,roundp,id(v)>
        //     else
        //         broadcast <PREVOTE,hp,roundp,nil>
        //     stepp ← prevote
        console.log("bylllogaaaaaaaa sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
            + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(assocByzantinePhase[h_p].phase[p_p].proposal.vp === -1 && step_p === constants.BYZANTINE_PROPOSE){
            if(assocByzantinePhase[h_p].phase[p_p].proposal.isValid === 1 
                && (lockedPhase_p === -1 || compareIfValueEqual(lockedValue_p, assocByzantinePhase[h_p].phase[p_p].proposal))){
                pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 1);
                console.log("bylllog broadcastPrevote 1:" + h_p + ":" + p_p + ":" + assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                broadcastPrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
            }
            else {
                pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 0);
                console.log("bylllog broadcastPrevote 2:" + h_p + ":" + p_p + ": null");
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
        console.log("bylllogbbbbbbbb sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
                + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(assocByzantinePhase[h_p].phase[p_p].proposal.vp >= 0  && assocByzantinePhase[h_p].phase[p_p].proposal.vp < p_p
            && PrevoteBiggerThan2f1(h_p, assocByzantinePhase[h_p].phase[p_p].proposal.vp, 1)
            && step_p === constants.BYZANTINE_PROPOSE ){
            if(assocByzantinePhase[h_p].phase[p_p].proposal.isValid === 1 
                && (lockedPhase_p <= assocByzantinePhase[h_p].phase[p_p].proposal.vp || compareIfValueEqual(lockedValue_p, assocByzantinePhase[h_p].phase[p_p].proposal))){
                pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 1);
                console.log("bylllog broadcastPrevote 3:" + h_p + ":" + p_p + ":" + assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                broadcastPrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
            }
            else {
                pushByzantinePrevote(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.idv, address_p, 0);
                console.log("bylllog broadcastPrevote 4:" + h_p + ":" + p_p + ": null");
                broadcastPrevote(h_p, p_p, null);
            }
            step_p = constants.BYZANTINE_PREVOTE;
        }
        // upon 2f + 1 <PREVOTE,hp,roundp,∗> while stepp = prevote for the first time do
        //     schedule OnTimeoutPrevote(hp,roundp) to be executed after timeoutPrevote(roundp)
        console.log("bylllogcccccccc sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
                + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(PrevoteBiggerThan2f1(h_p, p_p, 2) && step_p === constants.BYZANTINE_PREVOTE){
            if(h_prevote_timeout === -1 && p_prevote_timeout === -1){
                h_prevote_timeout = h_p;
                p_prevote_timeout = p_p;
                setTimeout(OnTimeoutPrevote, getTimeout(p_p));
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
        console.log("bylllogdddddddd sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
                + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(PrevoteBiggerThan2f1(h_p, p_p, 1)
            && assocByzantinePhase[h_p].phase[p_p].proposal.isValid === 1 
            && (step_p === constants.BYZANTINE_PREVOTE || step_p === constants.BYZANTINE_PRECOMMIT)){
            if(step_p === constants.BYZANTINE_PREVOTE){
                lockedValue_p = assocByzantinePhase[h_p].phase[p_p].proposal;
                lockedPhase_p = p_p;
                console.log("bylllog broadcastPrecommit PrevoteBiggerThan2f1:" + h_p + ":" + p_p + ":" +assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                broadcastPrecommit(h_p, p_p, assocByzantinePhase[h_p].phase[p_p].proposal.sig, assocByzantinePhase[h_p].phase[p_p].proposal.idv);
                step_p = constants.BYZANTINE_PRECOMMIT;
            }
            validValue_p = assocByzantinePhase[h_p].phase[p_p].proposal;
            validPhase_p = p_p;
        }
        // upon 2f+1 <PREVOTE,hp,roundp,nil> while stepp=prevote do
        //     broadcast <PRECOMMIT,hp,roundp,nil>
        //     step p ← precommit
        console.log("bylllogeeeeeeee sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
                + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(PrevoteBiggerThan2f1(h_p, p_p, 0) && step_p === constants.BYZANTINE_PREVOTE){
            console.log("bylllog broadcastPrecommit PrevoteBiggerThan2f1:" + h_p + ":" + p_p + ": null");
            broadcastPrecommit(h_p, p_p, null);
            step_p = constants.BYZANTINE_PRECOMMIT;
        }
        // upon 2f + 1 <PRECOMMIT,hp,roundp ,∗> for the first time do
        //     schedule OnTimeoutPrecommit(hp,roundp) to be executed after timeoutPrecommit(roundp)
        console.log("bylllogffffffff sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
                + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(PrecommitBiggerThan2f1(h_p, p_p, 2)){
            if(h_precommit_timeout === -1 && p_precommit_timeout === -1){
                h_precommit_timeout = h_p;
                p_precommit_timeout = p_p;
                setTimeout(OnTimeoutPrecommit, getTimeout(p_p));
            }
        }

        // upon <PROPOSAL,hp,r,v,∗> from proposer(hp,r) AND 2f+1 <PRECOMMIT,hp,r,id(v)> while decisionp[hp]=nil do
        //     if valid(v) then
        //         decisionp[hp]=v
        //         hp ← hp+1
        //         reset lockedRoundp,lockedValuep,validRoundp and validValuep to initial values and empty message log
        //         StartRound(0)
        function onDecisionError(phase){
            console.log("bylllog startPhase onDecisionError:" + h_p + ":" + p_p);
            startPhase(h_p, phase++);          
        }
        function onDecisionDone(){
            // //reset params
            // lockedValue_p = null;
            // lockedPhase_p = -1;
            // validValue_p  = null;
            // validPhase_p  = -1;
            // h_propose_timeout   = -1;
            // p_propose_timeout   = -1; 
            // h_prevote_timeout   = -1;
            // p_prevote_timeout   = -1; 
            // h_precommit_timeout = -1;
            // p_precommit_timeout = -1; 
            // // start new h_p
            // startPhase(h_p+1, 0);
            console.log("bylllog onDecisionDone" + " --- h_p:" + h_p + " --- p_p:" + p_p);
        }
        console.log("byllloggggggggg sKey:" + sKey + " --- sPeerUrl:" + sPeerUrl + " --- h_p:" + h_p + " --- p_p:" + p_p + " --- step_p:" 
            + step_p + " --- lockedPhase_p:" + lockedPhase_p + " --- lockedValue_p:" + lockedValue_p + " --- assocByzantinePhase:"+ JSON.stringify(assocByzantinePhase));
        if(assocByzantinePhase[h_p].decision === null || Object.keys(assocByzantinePhase[h_p].decision).length === 0){
            Object.keys(assocByzantinePhase[h_p].phase).forEach(function(current_p){
                if(assocByzantinePhase[h_p].phase[current_p].proposal.isValid === 1 && PrecommitBiggerThan2f1(h_p, current_p, 1)){
                    assocByzantinePhase[h_p].decision = assocByzantinePhase[h_p].phase[current_p].proposal.unit;
                    if(assocByzantinePhase[h_p].phase[current_p].proposal.address === address_p){
                        // compose new trustme unit
                        return decisionTrustMe(assocByzantinePhase[h_p].phase[current_p].proposal, current_p, assocByzantinePhase[h_p].phase[current_p].precommit_approved, onDecisionError, onDecisionDone);
                    }
                    else{
                        return ;
                    }
                }
            });
        }

        // upon f+1 <∗,hp,round,∗,∗> with round>roundp do
        //     StartRound(round)
        var messagesCount = 0;
        Object.keys(assocByzantinePhase[h_p].phase).forEach(function(current_p){
            if(current_p > p_p){
                if(Object.keys(assocByzantinePhase[h_p].phase[current_p].proposal).length > 0)
                    messagesCount = messagesCount + 1;
                messagesCount = messagesCount + assocByzantinePhase[h_p].phase[current_p].prevote_approved.length;
                messagesCount = messagesCount + assocByzantinePhase[h_p].phase[current_p].prevote_opposed.length;
                messagesCount = messagesCount + assocByzantinePhase[h_p].phase[current_p].precommit_approved.length;
                messagesCount = messagesCount + assocByzantinePhase[h_p].phase[current_p].precommit_opposed.length;
                if(messagesCount >= constants.TOTAL_BYZANTINE + 1){
                    console.log("bylllog startPhase f+1 <∗,hp,round,∗,∗>:" + h_p + ":" + p_p);
                    startPhase(h_p, current_p);
                }
            }
        });
    });
});
eventBus.on('mci_became_stable', function(mci){
     //reset params
     lockedValue_p = null;
     lockedPhase_p = -1;
     validValue_p  = null;
     validPhase_p  = -1;
     h_propose_timeout   = -1;
     p_propose_timeout   = -1; 
     h_prevote_timeout   = -1;
     p_prevote_timeout   = -1; 
     h_precommit_timeout = -1;
     p_precommit_timeout = -1; 
     // start new h_p
     console.log("bylllog startPhase mci_became_stable:" + h_p + ":" + p_p);
     startPhase(mci+1, 0);
});

// Function OnTimeoutPropose(height, round) :
//     if height=hp ∧ round=roundp ∧ stepp=propose then
//         broadcast <PREVOTE,hp,roundp,nil>
//         stepp ← prevote
function OnTimeoutPropose(){
    if(h_propose_timeout === h_p && p_propose_timeout === p_p && step_p === constants.BYZANTINE_PROPOSE){
        console.log("bylllog broadcastPrevote OnTimeoutPropose:" + h_p + ":" + p_p + ": null");
        broadcastPrevote(h_p, p_p, null);
        step_p = constants.BYZANTINE_PREVOTE;
        h_propose_timeout = -1;
        p_propose_timeout = -1;
    }
}
// Function OnTimeoutPrevote(height, round) :
//     if height=hp ∧ round=roundp ∧ stepp=prevote then 
//         broadcast <PRECOMMIT,hp,roundp,nil>
//         stepp ← precommit
function OnTimeoutPrevote(){
    if(h_prevote_timeout === h_p && p_prevote_timeout === p_p && step_p === constants.BYZANTINE_PREVOTE){
        console.log("bylllog broadcastPrecommit OnTimeoutPrevote:" + h_p + ":" + p_p + ": null");
        broadcastPrecommit(h_p, p_p, null);
        step_p = constants.BYZANTINE_PRECOMMIT;
        h_prevote_timeout   = -1;
        p_prevote_timeout   = -1;
    }
}
// Function OnTimeoutPrecommit(height, round) :
//     if height=hp ∧ round=roundp then
//         StartRound(roundp+1)
function OnTimeoutPrecommit(){
    if(h_precommit_timeout === h_p && p_precommit_timeout === p_p){
        h_precommit_timeout = -1;
        p_precommit_timeout = -1; 
        h_prevote_timeout   = -1;
        p_prevote_timeout   = -1;
        h_propose_timeout = -1;
        p_propose_timeout = -1;
        console.log("bylllog startPhase OnTimeoutPrecommit:" + h_p + ":" + p_p);
        startPhase(h_p, p_p+1);
    }
}
// public function end

// private function begin 

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
    console.log("bylllog bylllogbylllog in broadcastProposal:" + h + ":" + p + ":" + JSON.stringify(value) + ":" + vp);
    gossiper.gossiperBroadcast("Proposal"+h+p, composeProposalMessage(h, p, value, vp), function(err){
        if(err)
            console.log("bylllog broadcastProposal err:" + err);
    });
}
function broadcastPrevote(h, p, idv){
    console.log("bylllog bylllogbylllog in broadcastPrevote:" + h + ":" + p + ":" + JSON.stringify(idv));
    gossiper.gossiperBroadcast("Prevote"+h+p, composePrevoteMessage(h, p, idv), function(err){
        if(err)
            console.log("bylllog broadcastPrevote err:" + err);
    });
}
function broadcastPrecommit(h, p, sig, idv){
    console.log("bylllog bylllogbylllog in broadcastPrecommit:" + h + ":" + p + ":" + JSON.stringify(idv));
    gossiper.gossiperBroadcast("Precommit"+h+p, composePrecommitMessage(h, p, sig, idv), function(err){
        if(err)
            console.log("bylllog broadcastPrecommit err:" + err);
    });
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
        "last_ball_mci":joint.last_ball_mci,
    };
}
function pushByzantineProposal(h, p, proposal, vp, isValid, onDone) {
    console.log("bylllog before pushByzantineProposal1 111:" + JSON.stringify(proposal));
    composer.composeCoordinatorSig(address_p, proposal.unit, supernode.signerProposal, function(err, objAuthor){
        if(err)
            onDone(err);
        console.log("bylllog before pushByzantineProposal1 222:" + JSON.stringify(proposal));
        proposal.sig = objAuthor;
        proposal.vp = vp;
        proposal.isValid = isValid;        
        if(assocByzantinePhase[h].phase[p] === undefined){
            assocByzantinePhase[h].phase[p] = {"proposal":proposal, "prevote_approved":[], "prevote_opposed":[], "precommit_approved":[], "precommit_opposed":[]};    
            console.log("bylllog  pushByzantineProposal1:" + JSON.stringify(assocByzantinePhase));
        }      
        else if(Object.keys(assocByzantinePhase[h].phase[p].proposal).length === 0){
            assocByzantinePhase[h].phase[p].proposal = proposal;            
            console.log("bylllog  pushByzantineProposal1:" + JSON.stringify(assocByzantinePhase));
        }
        onDone();
    });    
}
// isApproved: 1 approved ; 0 opposed
function pushByzantinePrevote(h, p, idv, address, isApproved) {
    if(address !== null ){
        if(assocByzantinePhase[h].phase[p] === undefined){
            assocByzantinePhase[h].phase[p] = {"proposal":{}, "prevote_approved":[], "prevote_opposed":[], "precommit_approved":[], "precommit_opposed":[]};    
        }
        if(assocByzantinePhase[h].phase[p].prevote_approved.indexOf(address) === -1 && assocByzantinePhase[h].phase[p].prevote_opposed.indexOf(address) === -1){
            if(isApproved === 1 && assocByzantinePhase[h].phase[p].proposal.idv === idv){  
                assocByzantinePhase[h].phase[p].prevote_approved.push(address);
            }
            else{
                assocByzantinePhase[h].phase[p].prevote_opposed.push(address);
            }
        }
    }
   
}
// isApproved: 1 approved ; 0 opposed
function pushByzantinePrecommit(h, p, idv, address, sig, isApproved) {
    var ifIncluded = false;
    if(assocByzantinePhase[h].phase[p] === undefined){
        assocByzantinePhase[h].phase[p] = {"proposal":{}, "prevote_approved":[], "prevote_opposed":[], "precommit_approved":[], "precommit_opposed":[]};    
    }
    else{
        for (var j=0; j<assocByzantinePhase[h].phase[p].precommit_approved.length; j++){
            if(assocByzantinePhase[h].phase[p].precommit_approved[j].address === sig.address){
                ifIncluded = true;
                break;
            }
        }
    }
    if(address !== null && !ifIncluded && assocByzantinePhase[h].phase[p].precommit_opposed.indexOf(address) === -1){
        if(isApproved === 1 && sig !== null && sig.address !== null && sig.address === address && assocByzantinePhase[h].phase[p].proposal.idv === idv){
            assocByzantinePhase[h].phase[p].precommit_approved.push(sig);
        }
        // else if (isApproved === 0){  // ???
        else {  
            assocByzantinePhase[h].phase[p].precommit_opposed.push(address);
        }
    }    
}
function compareIfValueEqual(v1, v2){
    return objectHash.getProposalUnitHash(v1.unit) === objectHash.getProposalUnitHash(v2.unit);
}
// isApproved: 1 approved ; 0 opposed; 2 all
function PrevoteBiggerThan2f1(h, p, isApproved){
    if(isApproved === 1)
        return assocByzantinePhase[h].phase[p].prevote_approved.length >= constants.TOTAL_BYZANTINE*2 + 1;
    else if(isApproved === 0)
        return assocByzantinePhase[h].phase[p].prevote_opposed.length >= constants.TOTAL_BYZANTINE*2 + 1;
    else if(isApproved === 2)
        return (assocByzantinePhase[h].phase[p].prevote_approved.length + assocByzantinePhase[h].phase[p].prevote_opposed.length) >= constants.TOTAL_BYZANTINE*2 + 1;    
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
        return (assocByzantinePhase[h].phase[p].precommit_approved.length + assocByzantinePhase[h].phase[p].precommit_opposed.length) >= constants.TOTAL_BYZANTINE*2 + 1;    
    else 
        return false;
}
function decisionTrustMe(proposal, phase, approvedCoordinators, onDecisionError, onDecisionDone) {
    console.log("bylllog  decisionTrustMe:" + JSON.stringify(proposal));
    bTrustMeUnderWay = true;
    function onError(){
        bTrustMeUnderWay = false;
        onDecisionError(phase);
	}
    const callbacks = composer.getSavingCallbacks({
		ifNotEnoughFunds: onError,
		ifError: onError,
		ifOk: function(objJoint){
            network.broadcastJoint(objJoint);
            bTrustMeUnderWay = false;
            onDecisionDone();
		}
	});
		
	composer.composeCoordinatorTrustMe(address_p, proposal, phase, approvedCoordinators, supernode.signer, callbacks);      
}
// private function end

// cache begin

function shrinkByzantineCache(){
    // shrink assocByzantinePhase
    var arrByzantinePhases = Object.keys(assocByzantinePhase);
	if (arrByzantinePhases.length < MAX_BYZANTINE_IN_CACHE){
        console.log("ByzantinePhaseCacheLog:shrinkByzantineCache,will not delete, assocByzantinePhase.length:" + arrByzantinePhases.length);
        return console.log('byzantine cache is small, will not shrink');
    }
    var minIndexByzantinePhases = Math.min.apply(Math, arrByzantinePhases);
    for (var offset1 = minIndexByzantinePhases; offset1 < h_p - MAX_BYZANTINE_IN_CACHE; offset1++){
        console.log("ByzantinePhaseCacheLog:shrinkByzantineCache,delete hp:" + offset1);
        delete assocByzantinePhase[offset1];
    }
}

//setInterval(shrinkByzantineCache, 100*1000);

// cache end


//	@exports

exports.getCoordinators = getCoordinators;

// test code begin

var testValue = {
    "version": "1.0",
    "alt": "1",
    "messages": [
      {
        "app": "data_feed",
        "payload_location": "inline",
        "payload_hash": "t0PkoqSbe0Tm6/3i8kv72K/hkWcruLHg+tY/DvzGR0g=",
        "payload": {
          "timestamp": 1542593986179
        }
      }
    ],
    "hp":100,
    "round_index": 100,
    "pow_type": 2,
    "parent_units": [
      "CzONNx8NbqIbjULi/Xt2rgRJws7Dg8TR7lCIIeJzSMQ="
    ],
    "last_ball": "XCcD+vZcbe025xn4VZRAwowtXBqU8JS/WIB43vYpzYA=",
    "last_ball_unit": "AxH3SWNh/9dwRpuphZVPGAzbO/Md8AJpj7Q1C6JxBM4=",
};
var testJoint = {
    "unit": testValue,
    "proposer": [
        {
          "address": "JNA6YWLKFQG7PFF6F32KTXBUAHRAFSET",
          "authentifiers": {
            "r": "Ji/pKTJjb+bgcn+UQ2mcY89eWf/KM3n0ZdmH5KCsldIYIb1IqYlsjB4rXeQwAVkGhsdqp5oPXf6TsXuP7SWq0A=="
          }
        }
       ],
    "phase": 10
};
var testIdv = objectHash.getProposalUnitHash(testValue);
var testProposal = {
    address: "JNA6YWLKFQG7PFF6F32KTXBUAHRAFSET",
    unit: testValue,
    idv: testIdv,
    validRoundP: 1,
    isValid: 1
};
var testProvote1 = {
    "D55F4JL2R3S4UHX4UXVFGOWTZPZR2YXO":{
        idv:testIdv,
        result:1
    }
};
var testProvote2 = {
    "ZW35QKXIKK47A7HW3YRIV6TU3DYDTIVR":{
        idv:testIdv,
        result:1
    }
};
var testProvote3 = {
    "YYPCNIE34QFXXCNTQ274TP3B5DVRHWSY":{
        idv:testIdv,
        result:1
    }
};
var testProcommit1 = {
    "D55F4JL2R3S4UHX4UXVFGOWTZPZR2YXO":{
        idv:testIdv,
        result:1
    }
};
var testProcommit2 = {
    "ZW35QKXIKK47A7HW3YRIV6TU3DYDTIVR":{
        idv:testIdv,
        result:1
    }
};
var testProcommit3 = {
    "YYPCNIE34QFXXCNTQ274TP3B5DVRHWSY":{
        idv:testIdv,
        result:1
    }
};

// var assocByzantinePhase = {
//     1000:{
//         0:{
//             proposal:testProposal,
//             prevote:[testProvote1, testProvote2, testProvote3],
//             precommit:[testProcommit1, testProcommit2],
//         }
//     }
// };

var hp_test=1000;
// console.log(JSON.stringify(assocByzantinePhase));
// console.log(JSON.stringify(assocByzantinePhase));
// console.log(JSON.stringify(assocByzantinePhase[hp_test]));
// console.log(JSON.stringify(assocByzantinePhase[hp_test][0].proposal));
// console.log(JSON.stringify(assocByzantinePhase[hp_test][0].prevote));
// console.log(JSON.stringify(assocByzantinePhase[hp_test][0].precommit));
// console.log(JSON.stringify(assocByzantinePhase[hp_test][0].prevote.length));
// console.log(JSON.stringify(assocByzantinePhase[hp_test][0].precommit.length));

// assocByzantinePhase[hp_test][1]={
//     proposal:testProposal,
//     prevote:[testProvote1, testProvote2],
//     precommit:[testProcommit1, testProcommit2],
// };
//console.log(JSON.stringify(assocByzantinePhase[hp_test]));


// var testObj = {
//     10: 10
// };
// testObj[2] = 20;
// testObj[30] = 3;
// testObj[5] = 5;
// testObj[12] = 12;
// console.log(testObj);
// console.log(JSON.stringify(testObj));

// var arrtestObj = Object.keys(testObj);
// console.log(arrtestObj);
// console.log(JSON.stringify(arrtestObj));

// h_p = 1;
// function addassocByzantinePhase(){
//     assocByzantinePhase[h_p] = h_p;
//     console.log("add phase : " + JSON.stringify(assocByzantinePhase));
//     h_p++;
// }
// setInterval(addassocByzantinePhase, 2*1000);


// test code end