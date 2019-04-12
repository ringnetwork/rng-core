/**
 * 	set process env
 */
process.env.ENV_UNIT_TEST	= true;


const _network		= require( '../../p2p/network.js' );
const _catchup		= require( '../../catchup/catchup.js' );
const _event_bus	= require( '../../base/event_bus.js' );

//const _peer		= 'ws://dev.mainchain.pow.ringnetwork.org:9191';
const _peer		= 'ws://127.0.0.1:9191';



/**
 * 	start here
 */
_network.connectToPeer( _peer, function( err, ws )
{
	console.log( `will request catchup from ${ ws.peer }` );
	_network.requestCatchup_Dev( ws, { last_stable_mci: 0, last_known_mci: 0 } );
});



_event_bus.on( 'updated_last_round_index_from_peers', ( nLastRoundIndexFromPeers ) =>
{
	console.log( `================================================================================` );
	console.log( `================================================================================` );
	console.log( `RECEIVED updated_last_round_index_from_peers with value: ${ nLastRoundIndexFromPeers }` );
	console.log( `================================================================================` );
	console.log( `================================================================================` );
});

setInterval( () =>
{
	console.log( `### catchup getLastRoundIndexFromPeers : ${ _catchup.getLastRoundIndexFromPeers() }.` );

}, 1000 );
