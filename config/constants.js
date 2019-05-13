/*jslint node: true */
"use strict";

// pow modi 
//exports.COUNT_WITNESSES		= 12;
exports.COUNT_WITNESSES		= 10;
exports.COUNT_POW_WITNESSES = 10;
exports.TOTAL_WHITEBYTES	= 5e14;
exports.TOTAL_WHITEBYTES_AND_MINE = 10e14;
exports.MAJORITY_OF_WITNESSES	= (exports.COUNT_WITNESSES % 2 === 0) ? (exports.COUNT_WITNESSES / 2 + 1) : Math.ceil(exports.COUNT_WITNESSES / 2);
exports.COUNT_MC_BALLS_FOR_PAID_WITNESSING = 100;

// byzantine
exports.TOTAL_COORDINATORS = 10;
exports.TOTAL_BYZANTINE = (exports.TOTAL_COORDINATORS - 1) / 3;
exports.BYZANTINE_GST = 10000;
exports.BYZANTINE_DELTA = 1000;
exports.BYZANTINE_PHASE_TIMEOUT = 20000;
exports.TRUSTME_INTERVAL = 15000;
exports.TRUSTME_TIMESTAMP_TOLERANT = 3600000;
exports.BYZANTINE_PROPOSE   = 1;
exports.BYZANTINE_PREVOTE   = 2;
exports.BYZANTINE_PRECOMMIT = 3;
exports.MAX_BYZANTINE_IN_CACHE = 2;
exports.MAX_BYZANTINE_PHASE_IN_CACHE = 20;


exports.version = '1.0';
exports.alt = '1';

exports.GENESIS_UNIT = 'JTNCRYvYrAAGWRktuaZOBrnx7jpNd8wm1QMI14eMKKw=';

exports.BLACKBYTES_ASSET = '9qQId3BlWRQHvVy+STWyLKFb3lUd0xfQhX6mPVEHC2c=';
// Pow add
exports.FOUNDATION_ADDRESS = "A3TEKUPJMRKNKJBO2NOKLGKONMFWLR7P";
//exports.FOUNDATION_DEVICE_ADDRESS = "0IGDSBSHTBTLAYRAI65YI2VDDHSP5JO4R"
exports.FOUNDATION_DEVICE_ADDRESS = "0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
//exports.FOUNDATION_SAFE_ADDRESS = "BURNEDRNG2222222222222222L3HXT4Y";
exports.FOUNDATION_SAFE_ADDRESS = "A3TEKUPJMRKNKJBO2NOKLGKONMFWLR7P";

exports.HASH_LENGTH = 44;
exports.PUBKEY_LENGTH = 44;
exports.SIG_LENGTH = 88;

// anti-spam limits
exports.MAX_AUTHORS_PER_UNIT = 16;
exports.MAX_PARENTS_PER_UNIT = 16;
exports.MAX_MESSAGES_PER_UNIT = 128;
exports.MAX_SPEND_PROOFS_PER_MESSAGE = 128;
exports.MAX_INPUTS_PER_PAYMENT_MESSAGE = 128;
exports.MAX_OUTPUTS_PER_PAYMENT_MESSAGE = 128;
exports.MAX_CHOICES_PER_POLL = 128;
exports.MAX_DENOMINATIONS_PER_ASSET_DEFINITION = 64;
exports.MAX_ATTESTORS_PER_ASSET = 64;
exports.MAX_DATA_FEED_NAME_LENGTH = 64;
exports.MAX_DATA_FEED_VALUE_LENGTH = 64;
exports.MAX_AUTHENTIFIER_LENGTH = 4096;
exports.MAX_CAP = 9e15;
exports.MAX_COMPLEXITY = 100;

exports.ROUND_TOTAL_YEAR = 210240;
exports.ROUND_TOTAL_ALL = 4204800;
exports.ROUND_COINBASE = [217590000,
						176740000,
						156490000,
						143550000,
						134260000,
						127110000,
						121370000,
						116600000,
						112550000,
						109050000,
						105980000,
						103250000,
						100800000,
						98580000,
						96560000,
						94710000,
						93000000,
						91420000,
						89950000,
						88580000,
						0];

//exports.MIN_INTERVAL_WL_OF_TRUSTME = 5;
exports.FOUNDATION_RATIO = 0.4;
/**
 *	pow_type
 */
exports.POW_TYPE_POW_EQUHASH = 1;
exports.POW_TYPE_TRUSTME	 = 2;
exports.POW_TYPE_COIN_BASE	 = 3;

exports.COUNT_ROUNDS_FOR_DIFFICULTY_SWITCH = 1;
exports.COUNT_CYCLES_FOR_DIFFICULTY_DURATION = 17;

// SUPERNODE can only spend deposit balance after such rounds: 21*576
// exports.COUNT_ROUNDS_FOR_SUPERNODE_SPEND_DEPOSIT = 12096;
exports.COUNT_ROUNDS_FOR_SUPERNODE_SPEND_DEPOSIT = 5;

// FOUNDATION safe address can take over bad supernode deposit after such rounds;  
exports.COUNT_ROUNDS_FOR_FOUNDATION_SPEND_DEPOSIT = 5;

// average time consumimg per each round
exports.DURATION_PER_ROUND = 150;

// calculate payload commission coefficient
exports.PAYLOAD_COEFFICIENT = {
	"payment":1000,
	"pow_equihash":5000,
	"address_definition_change":1000,
	"poll":1000,
	"vote":1000,
	"asset":1000,
	"asset_attestors":1000,
	"data_feed":1000,
	"profile":1000,
	"attestation":1000,
	"data":1000,
	"definition_template":1000,
	"text":1000
};


// deposit reward 
// the reward is calculated on how many rounds
// exports.DEPOSIT_REWARD_ROUND = 576;   
exports.DEPOSIT_REWARD_PERIOD = 5;
// how many deposit addresses get rewards
//exports.DEPOSIT_REWARD_RESTRICTION = 1000;
exports.DEPOSIT_REWARD_RESTRICTION = 5;

exports.DEPOSIT_REWARD_PERCENT = 0.75;


