/*jslint node: true */
"use strict";

/**
 *	@boss	XING
 */

const _ref		= require( 'ref' );
const _ffi		= require( 'ffi' );
const _fs		= require( 'fs' );
const _crypto		= require( 'crypto' );
const _blakejs		= require( 'blakejs' );
const _async		= require( 'async' );

const _constants	= require( './constants.js' );
const _round		= require( './round.js' );



/**
 * 	@global
 *	@variables
 */
let _objEquihashLibrary		= null;
let _objDifficultyAdjust	= null;


/**
 * 	@author		XING
 * 	@datetime	2018/8/6 4:53 PM
 *
 * 	////////////////////////////////////////////////////////////
 *	@description
 *
 * 	Assume that this is the round N, the inputs of the round N+1 are:
 * 	1, unique coin-base units sorted by address from round (N-1)
 *	   arrCoinBaseList
 *	   [
 *		'address0'	: 20% of total amount,
 *		'address1'	: amount of coins,
 *		'address2'	: amount of coins,
 *		'address3'	: amount of coins,
 *		'address4'	: amount of coins,
 *		'address5'	: amount of coins,
 *		'address6'	: amount of coins,
 *		'address7'	: amount of coins,
 *		'address8'	: amount of coins,
 *	   ]
 *	   Note: the address0 came from TrustNote Foundation.
 *	2, ball address of the first TrustME unit from round (N)
 *	3, difficulty value of round (N)
 *	4, public seed of round (N)
 *	5, author address of current SuperNode.
 *
 *
 *	////////////////////////////////////////////////////////////
 *	@examples
 *
 * 	let bCallStartCalculation = startCalculation( oConn, function( err )
 * 	{
 * 		if ( err )
 * 		{
 * 			console.log( `failed to start calculation, `, err );
 * 			return;
 * 		}
 *
 * 		console.log( `start calculation successfully.` );
 * 	});
 *
 *	let nCallStartCalculation = startCalculationWithInput
 *	({
 *		 previousCoinBaseList	: {
 *			 '4T57ZFLZOMUAMZTXO63XLK5YDQRF5DP2': 10000,
 *			 '2SATGZDFDXNNJRVZ52O4J6VYTTMO2EZR': 10000,
 *		 },
 *		 currentFirstTrustMEBall	: 'rjywtuZ8A70vgIsZ7L4lBR3gz62Nl3vZr2t7I4lzsMU=',
 *		 currentDifficulty	: '000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
 *		 currentPubSeed		: 'public key',
 *		 superNodeAuthor		: 'xing.supernode.trustnote.org',
 *	}, function( err )
 *	{
 * 		if ( err )
 * 		{
 * 			console.log( `failed to start calculation, `, err );
 * 			return;
 * 		}
 *
 * 		console.log( `start calculation successfully.` );
 * 	});
 *
 *
 *	let bIsValidEquihash = isValidEquihash
 *	(
 *		{
 *			previousCoinBaseList	: {
 *				'4T57ZFLZOMUAMZTXO63XLK5YDQRF5DP2': 10000,
 *				'2SATGZDFDXNNJRVZ52O4J6VYTTMO2EZR': 10000,
 *			},
 *			currentFirstTrustMEBall	: 'rjywtuZ8A70vgIsZ7L4lBR3gz62Nl3vZr2t7I4lzsMU=',
 *			currentDifficulty	: '000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
 *			currentPubSeed		: 'public key',
 *			superNodeAuthor		: 'xing.supernode.trustnote.org',
 *		},
 *		'00000001c570c4764aadb3f09895619f549000b8b51a789e7f58ea7500007097',
 *		'xxxxxxxxxxxx'
 *	);
 *	console.log( bIsValidEquihash );
 *
 */


/**
 *	start calculation
 *
 *	@param	{handle}	oConn
 *	@param	{function}	oConn.query
 *	@param	{function}	pfnCallback( err )
 *	@return {boolean}
 *
 * 	@description
 * 	start successfully	pfnCallback( null );
 * 	failed to start		pfnCallback( error );
 */
function startCalculation( oConn, pfnCallback )
{
	if ( 'function' !== typeof pfnCallback )
	{
		//	arguments.callee.name
		throw new Error( `call startCalculation with invalid pfnCallback.` );
	}

	let nCurrentRoundIndex		= null;
	let nPreviousRoundIndex		= null;
	let arrPreviousCoinBaseList	= null;
	let sCurrentFirstTrustMEBall	= null;
	let sCurrentDifficultyValue	= null;
	let sCurrentPublicSeed		= null;

	_async.series
	([
		function( pfnNext )
		{
			//
			//	get round index
			//
			_round.getCurrentRoundIndex( oConn, function( nRoundIndex )
			{
				if ( 'number' === nRoundIndex && nRoundIndex > 0 )
				{
					nCurrentRoundIndex	= nRoundIndex;
					nPreviousRoundIndex	= nRoundIndex - 1;
					pfnNext();
				}
				else
				{
					pfnNext( `previous round index must be great then 0` );
				}
			});
		},
		function( pfnNext )
		{
			//
			//	round (N-1)
			//	obtain coin-base list of the previous round
			//
			getCoinBaseListFromDb( oConn, nPreviousRoundIndex, function( err, arrCoinBaseList )
			{
				if ( err )
				{
					return pfnNext( err );
				}

				arrPreviousCoinBaseList = arrCoinBaseList;
				return pfnNext();
			});
		},
		function( pfnNext )
		{
			//
			//	round (N)
			//	obtain ball address of the first TrustME unit from current round
			//
			getFirstTrustMEBallFromDb( oConn, nCurrentRoundIndex, function( err, sBall )
			{
				if ( err )
				{
					return pfnNext( err );
				}

				sCurrentFirstTrustMEBall = sBall;
				return pfnNext();
			});
		},
		function( pfnNext )
		{
			//
			//	round (N)
			//	calculate difficulty value
			//
			calculateDifficultyValue( oConn, nCurrentRoundIndex, function( err, sDifficulty )
			{
				if ( err )
				{
					return pfnNext( err );
				}

				sCurrentDifficultyValue	= sDifficulty;
				return pfnNext();
			});
		},
		function( pfnNext )
		{
			//
			//	round (N)
			//	calculate public seed
			//
			calculatePublicSeed( oConn, nCurrentRoundIndex, function( err, sSeed )
			{
				if ( err )
				{
					return pfnNext( err );
				}

				sCurrentPublicSeed = sSeed;
				return pfnNext();
			});
		},
		function( pfnNext )
		{
			//	author address of this super node
		}
	], function( err )
	{
		if ( err )
		{
			return pfnCallback( err );
		}

		let objInput	= {
			previousCoinBaseList	: arrPreviousCoinBaseList,
			currentFirstTrustMEBall	: sCurrentFirstTrustMEBall,
			currentDifficulty	: sCurrentDifficultyValue,
			currentPubSeed		: sCurrentPublicSeed,
			superNodeAuthor		: '',
		};
		startCalculationWithInputs( objInput, function( err )
		{
			if ( err )
			{
				return pfnCallback( err );
			}

			//
			//	successfully
			//
			pfnCallback( null );
		});
	});

	return true;
}


/**
 *	start calculation with inputs
 *
 * 	@param	{object}	objInput
 *	@param	{array}		objInput.previousCoinBaseList		@see description
 *	@param	{string}	objInput.currentFirstTrustMEBall
 *	@param	{string}	objInput.currentDifficulty
 *	@param	{string}	objInput.currentPubSeed
 *	@param	{string}	objInput.superNodeAuthor
 *	@param	{function}	pfnCallback( err )
 *	@return	{boolean}
 */
function startCalculationWithInputs( objInput, pfnCallback )
{
	if ( 'object' !== typeof objInput )
	{
		throw new Error( 'call startCalculation with invalid objInput' );
	}
	if ( ! Array.isArray( objInput.previousCoinBaseList ) || 0 === objInput.previousCoinBaseList.length )
	{
		throw new Error( 'call startCalculation with invalid arrCoinBaseList' );
	}
	if ( 'string' !== typeof objInput.currentFirstTrustMEBall || 44 !== objInput.currentFirstTrustMEBall.length )
	{
		throw new Error( 'call startCalculation with invalid sTrustMEBall' );
	}
	if ( 'string' !== typeof objInput.currentDifficulty || 64 !== objInput.currentDifficulty.length )
	{
		throw new Error( 'call startCalculation with invalid sDifficulty' );
	}
	if ( 'string' !== typeof objInput.currentPubSeed || 0 === objInput.currentPubSeed.length )
	{
		throw new Error( 'call startCalculation with invalid sPubSeed' );
	}
	if ( 'string' !== typeof objInput.superNodeAuthor || 0 === objInput.superNodeAuthor.length )
	{
		throw new Error( 'call startCalculation with invalid sSuperNode' );
	}
	if ( 'function' !== typeof pfnCallback )
	{
		throw new Error( `call startCalculationWithInputs with invalid pfnCallback.` );
	}

	return true;
}


/**
 * 	calculate public seed by round index
 *
 *	@param	{handle}	oConn
 *	@param	{function}	oConn.query
 *	@param	{number}	nRoundIndex
 * 	@param	{function}	pfnCallback( err, sSeed )
 *
 * 	@documentation
 *	https://github.com/trustnote/document/blob/master/TrustNote-TR-2018-02.md#PoW-Unit
 *
 * 	pubSeed(i)	= blake2s256
 * 		(
 * 			pubSeed(i-1) + hash( Coin-base(i-2) ) + hash( FirstStableMCUnit(i-1) )
 * 		)
 */
function calculatePublicSeed( oConn, nRoundIndex, pfnCallback )
{
	if ( ! oConn )
	{
		return pfnCallback( `call calculatePublicSeed with invalid oConn` );
	}
	if ( 'number' !== typeof nRoundIndex || nRoundIndex < 3 )
	{
		return pfnCallback( `call calculatePublicSeed with invalid nRoundIndex` );
	}

	let sPreviousPublicSeed		= null;
	let arrPrePreviousCoinBase	= null;
	let sPreviousTrustMEBall	= null;

	_async.series
	([
		function( pfnNext )
		{
			//	public seed
			getPublicSeedFromDb( oConn, nRoundIndex - 1, function( err, sSeed )
			{
				if ( err )
				{
					return pfnNext( err );
				}
				if ( 'string' !== typeof sSeed || 0 === sSeed.length )
				{
					return pfnNext( `calculatePublicSeed got invalid sSeed.` );
				}

				sPreviousPublicSeed = sSeed;
				return pfnNext();
			} );
		},
		function( pfnNext )
		{
			//	coin base
			getCoinBaseListFromDb( oConn, nRoundIndex - 2, function( err, arrCoinBaseList )
			{
				if ( err )
				{
					return pfnNext( err );
				}
				if ( ! Array.isArray( arrCoinBaseList ) )
				{
					return pfnNext( 'empty coin base list' );
				}
				if ( _constants.COUNT_WITNESSES !== arrCoinBaseList.length )
				{
					return pfnNext( 'no enough coin base units.' );
				}

				arrPrePreviousCoinBase = arrCoinBaseList;
				return pfnNext();
			} );
		},
		function( pfnNext )
		{
			//	first ball
			getFirstTrustMEBallFromDb( oConn, nRoundIndex - 1, function( err, sBall )
			{
				if ( err )
				{
					return pfnNext( err );
				}
				if ( 'string' !== typeof sBall || 0 === sBall.length )
				{
					return pfnNext( `calculatePublicSeed got invalid sBall.` );
				}

				sPreviousTrustMEBall = sBall;
				return pfnNext();
			} );
		}
	], function( err )
	{
		if ( err )
		{
			return pfnCallback( err );
		}

		//	...
		let sSource = ""
		+ sPreviousPublicSeed
		+ _crypto.createHash( 'sha512' ).update( JSON.stringify( arrPrePreviousCoinBase ), 'utf8' ).digest();
		+ _crypto.createHash( 'sha512' ).update( sPreviousTrustMEBall, 'utf8' ).digest();

		pfnCallback( null, _blakejs.blake2sHex( sSource ) );
	});
}


/**
 *	get public seed by round index
 *
 *	@param	{handle}	oConn
 *	@param	{function}	oConn.query
 *	@param	{number}	nRoundIndex
 *	@param	{function}	pfnCallback( err, arrCoinBaseList )
 */
function getPublicSeedFromDb( oConn, nRoundIndex, pfnCallback )
{
	if ( ! oConn )
	{
		return pfnCallback( `call getPublicSeedFromDb with invalid oConn` );
	}
	if ( 'number' !== typeof nRoundIndex || nRoundIndex <= 0 )
	{
		return pfnCallback( `call getPublicSeedFromDb with invalid nRoundIndex` );
	}

	oConn.query
	(
		"SELECT pow.seed AS p_seed \
		FROM pow JOIN units USING(unit) \
		WHERE units.round_index = ? AND units.is_stable=1 AND units.is_on_main_chain=1 AND units.sequence='good' AND units.pow_type=? \
		ORDER BY main_chain_index ASC \
		LIMIT 1",
		[
			nRoundIndex,
			_constants.POW_TYPE_POW_EQUHASH
		],
		function( arrRows )
		{
			if ( 0 === arrRows.length )
			{
				return pfnCallback( `no pow unit.` );
			}

			return pfnCallback( null, arrRows[ 0 ][ 'p_seed' ] );
		}
	);
}


/**
 *	calculate difficulty value
 *
 *	@param	{handle}	oConn
 *	@param	{function}	oConn.query
 *	@param	{number}	nRoundIndex
 * 	@param	{function}	pfnCallback( err, sSeed )
 */
function calculateDifficultyValue( oConn, nRoundIndex, pfnCallback )
{
	if ( ! oConn )
	{
		return pfnCallback( `call calculateDifficultyValue with invalid oConn` );
	}

	let nDifficultyValue = _objDifficultyAdjust.CalculateNextWorkRequired
	(
		100,
		100,
		100,
		Buffer.from( "0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" )
	);
	console.log( `difficulty = ${ nDifficultyValue }` );


}




/**
 *	get coin-base list by round index
 *
 *	@param	{handle}	oConn
 *	@param	{function}	oConn.query
 *	@param	{number}	nRoundIndex
 *	@param	{function}	pfnCallback( err, arrCoinBaseList )
 */
function getCoinBaseListFromDb( oConn, nRoundIndex, pfnCallback )
{
	if ( ! oConn )
	{
		return pfnCallback( `call getCoinBaseListFromDb with invalid oConn` );
	}
	if ( 'number' !== typeof nRoundIndex || nRoundIndex <= 0 )
	{
		return pfnCallback( `call getCoinBaseListFromDb with invalid nRoundIndex` );
	}

	//
	//	obtain coin-base list of the previous round
	//
	oConn.query
	(
		"SELECT DISTINCT units.address AS u_address, inputs.amount AS i_amount \
		FROM units JOIN unit_authors USING(unit) JOIN inputs USING(unit) \
		WHERE units.round_index = ? AND units.is_stable=1 AND units.is_on_main_chain=1 AND units.sequence='good' AND units.pow_type=? \
		AND 'coinbase' = inputs.type \
		ORDER BY main_chain_index ASC",
		[
			nRoundIndex,
			_constants.POW_TYPE_COIN_BASE
		],
		function( arrRows )
		{
			if ( 0 === arrRows.length )
			{
				return pfnCallback( `no coin base unit.` );
			}
			if ( arrRows.length < _constants.COUNT_WITNESSES )
			{
				return pfnCallback( `not enough coin base units.` );
			}

			return pfnCallback( null, arrRows.map( oRow =>
			{
				return { address : oRow.u_address, amount : oRow.i_amount };
			}));
		}
	);
}


/**
 *	obtain ball address of the first TrustME unit
 *
 *	@param	{handle}	oConn
 *	@param	{function}	oConn.query
 *	@param	{number}	nRoundIndex
 *	@param	{function}	pfnCallback( err, arrCoinBaseList )
 */
function getFirstTrustMEBallFromDb( oConn, nRoundIndex, pfnCallback )
{
	if ( ! oConn )
	{
		return pfnCallback( `call getFirstTrustMEBallFromDb with invalid oConn` );
	}
	if ( 'number' !== typeof nRoundIndex || nRoundIndex <= 0 )
	{
		return pfnCallback( `call getFirstTrustMEBallFromDb with invalid nRoundIndex` );
	}

	oConn.query
	(
		"SELECT ball \
		FROM balls JOIN units USING(unit) \
		WHERE units.round_index = ? AND units.is_stable=1 AND units.is_on_main_chain=1 AND units.sequence='good' AND units.pow_type=? \
		ORDER BY units.main_chain_index ASC \
		LIMIT 1",
		[
			nRoundIndex,
			_constants.POW_TYPE_TRUSTME
		],
		function( arrRows )
		{
			if ( 1 !== arrRows.length )
			{
				return pfnCallback( `Can not find a suitable ball for calculation pow.` );
			}

			//	...
			return pfnCallback( null, arrRows[ 0 ][ 'ball' ] );
		}
	);
}



/**
 *	verify if a hash is valid
 *
 * 	@param	{object}	objInput
 *	@param	{array}		objInput.previousCoinBaseList		@see description
 *	@param	{string}	objInput.currentFirstTrustMEBall
 *	@param	{string}	objInput.currentDifficulty
 *	@param	{string}	objInput.currentPubSeed
 *	@param	{string}	objInput.superNodeAuthor
 *	@param	{string}	sHash				'3270bcfd5d77014d85208e39d8608154c89ea10b51a1ba668bc87193340cdd67'
 *	@param	{number}	nNonce
 *	@return	{boolean}
 */
function isValidEquihash( objInput, sHash, nNonce )
{
	if ( 'object' !== typeof objInput )
	{
		throw new Error( 'call isValidEquihash with invalid objInput' );
	}
	if ( 'string' !== typeof sHash || 64 !== sHash.length )
	{
		throw new Error( 'call isValidEquihash with invalid sHash' );
	}
	if ( 'number' !== typeof nNonce )
	{
		throw new Error( 'call isValidEquihash with invalid sNonce' );
	}

	let bRet;
	let nInputLen;
	let bufInput;
	let bufHash;

	//	...
	bRet		= false;
	nInputLen	= 140;
	bufInput	= createInputBufferFromObject( objInput );
	bufHash		= Buffer.concat( [ Buffer.from( sHash, 'utf8' ) ], 32 );

	//	load library
	_loadEquihashLibraryIfNeed();

	let nCall       = _objEquihashLibrary.equihash( bufInput, nNonce, bufHash, nInputLen );

	console.log( `call equihash = ${ nCall }` );



	return true;
}


/**
 *	create an input buffer with length of 140 from Js plain object
 *	@public
 *	@param	{object}	objInput
 *	@return	{Buffer}
 */
function createInputBufferFromObject( objInput )
{
	let sInput;
	let bufSha512;
	let bufMd5;
	let bufRmd160;
	let bufSha384;

	if ( 'object' !== typeof objInput )
	{
		return null;
	}

	//	...
	sInput		= JSON.stringify( objInput );

	bufSha512	= _crypto.createHash( 'sha512' ).update( sInput, 'utf8' ).digest();
	bufMd5		= _crypto.createHash( 'md5' ).update( sInput, 'utf8' ).digest();
	bufRmd160	= _crypto.createHash( 'rmd160' ).update( sInput, 'utf8' ).digest();
	bufSha384	= _crypto.createHash( 'sha384' ).update( sInput, 'utf8' ).digest();

	return Buffer.concat( [ bufSha512, bufMd5, bufRmd160, bufSha384 ], 140 );
}




/**
 *	load libequihash.so dynamically
 *	@private
 */
function _loadEquihashLibraryIfNeed()
{
	if ( null === _objEquihashLibrary )
	{
		_objEquihashLibrary = _ffi.Library
		(
			`${ __dirname }/libs/libequihash.so`,
			{
				'equihash': [ 'int',  [ 'pointer', 'uint', 'pointer', 'int'  ] ]
			}
		);
	}

	if ( null === _objDifficultyAdjust )
	{
		_objDifficultyAdjust = _ffi.Library
		(
			`${ __dirname }/libs/libdiff_adjust.so`,
			{
				'CalculateNextWorkRequired': [ 'uint',  [ 'uint', 'uint', 'uint', 'pointer'  ] ]
			}
		);
	}
}






/**
 *	@exports
 */
module.exports.startCalculation			= startCalculation;
module.exports.calculatePublicSeed		= calculatePublicSeed;
module.exports.calculateDifficultyValue		= calculateDifficultyValue;
module.exports.startCalculationWithInputs	= startCalculationWithInputs;

module.exports.getPublicSeedFromDb		= getPublicSeedFromDb;
module.exports.getCoinBaseListFromDb		= getCoinBaseListFromDb;
module.exports.getFirstTrustMEBallFromDb	= getFirstTrustMEBallFromDb;

module.exports.isValidEquihash			= isValidEquihash;
module.exports.createInputBufferFromObject	= createInputBufferFromObject;
