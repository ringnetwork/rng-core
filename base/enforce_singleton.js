/*jslint node: true */
"use strict";

if (global._bRingNetworkCoreLoaded)
	throw Error("Looks like you are loading multiple copies of rng-core, which is not supported.\nRunnung 'npm dedupe' might help.");

global._bRingNetworkCoreLoaded = true;
