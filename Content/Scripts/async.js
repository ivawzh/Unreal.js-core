//Js wrapper to enable raw function passing

//We should only use one instance to handle all lambda logic
Async.instance = Async.StaticInstance();
Async.instance.Callbacks = {};
Async.DevLog = console.log;

//Safe way of handling json parsing
Async.ParseArgs = (args)=>{
    try {
        return JSON.parse(args);
    } catch (e) {
    	if(typeof(args) === 'string'){
    		return args;
    	}
    	else{
        	return null;
    	}
    }
}

class CallbackHandler {
	constructor(lambdaId){
		this.return = ()=>{};
		this.bridges = {};
		this.lambdaId = lambdaId? lambdaId: -1;
		this.pinned = false;

		this.onMessage = (event, data)=>{};
		this.messageCallbacks = {};
		this.callbackId = 0;
		this.exports = {};	//todo potentially: support transparent export links so we could do lambda.exports.functionName();
	}

	//called per exposed GT function
	_addBridge(name, bridgeFunction){

		//Wrap the necessary js callback function, this will actually call the bridge function in OnAsyncCall
		let exposeDefinition = 
				`const ${name} = (_GTArgs, _resultCallback)=>{\n` +
				`_asyncUtil.CallbackIndex++;\n` +
				`_asyncUtil.Callbacks['${name}-'+_asyncUtil.CallbackIndex] = _resultCallback;\n` +
				//`if(_resultCallback != undefined){ _asyncUtil.Callbacks['${name}-'+_asyncUtil.CallbackIndex] = _resultCallback;}\n` + 
				`_asyncUtil.CallFunction('${name}', _GTArgs ? JSON.stringify(_GTArgs) : '', ${this.lambdaId}, _asyncUtil.CallbackIndex);\n` + 
				`}\n`;

		//store the GT bridge function with a parse and result callback wrapper. OnAsyncCall call this bridge
		this.bridges[name] = (args, callbackId)=>{
			//parse args if necessary
			args = Async.ParseArgs(args);

			//run bridge function
			const result = bridgeFunction(args);

			//Async.DevLog(`Received BT call ${name}, with ${args}`);
			//Async.DevLog(bridgeFunction.toString());

			//did the function produce a result?
			if(result != undefined){
				//callback to BT with result without expecting receipt (-1)
				Async.instance.CallScriptFunction(this.lambdaId, `_asyncUtil.Callbacks['${name}-${callbackId}']`, JSON.stringify(result), -1);
			}

			//cleanup callback
			Async.instance.RunScriptInLambda(this.lambdaId, `if (_asyncUtil.Callbacks['${name}-${callbackId}']) {delete _asyncUtil.Callbacks['${name}-${callbackId}']};`);
		}
		
		return exposeDefinition;
	}

	//lambda return callback
	_setReturn(returnCallback){
		this.return = (jsonValue)=>{
			returnCallback(jsonValue, this);
		};
	}

	//PUBLIC API: Function used to run remote thread function on GT
	call(functionName, args, callback){

		let localCallbackId = 0;
		if(callback){
			this.callbackId++;
			this.messageCallbacks[this.callbackId] = callback;
			localCallbackId = this.callbackId;
		}

		Async.instance.CallScriptFunction(this.lambdaId, 'exports.' + functionName, JSON.stringify(args), localCallbackId);
	}

	//PUBLIC API: stop the lambda and cleanup
	stop(){
		Async.instance.StopLambda(this.lambdaId);

		//todo: cleanup handler data
		delete Async.instance.Callbacks[this.lambdaId];
	}
};

Async.instance.OnLambdaComplete = (resultString, lambdaId, callbackId /*not used for completion*/) => {
	const result = Async.ParseArgs(resultString);
	const handler = Async.instance.Callbacks[lambdaId];

	if(handler != undefined){
		//first: fill the returned exports
		if(handler.pinned){
			result.exports.forEach(functionName => {
				handler.exports[functionName] = (args, callback)=>{
					handler.call(functionName, args, callback);
				}
			});
		}
		
		//call the return callback
		handler.return(result.result);

		//cleanup if not pinned
		if(!handler.pinned){
			Async.DevLog('Lambda cleaned up');
			delete Async.instance.Callbacks[lambdaId];
		}
	}
};

Async.instance.OnMessage = (message, lambdaId, callbackId) => {
	//Async.DevLog('Got message: ' + message + ' from ' + lambaId);
	const handler = Async.instance.Callbacks[lambdaId];

	if(handler != undefined){
		if(handler.messageCallbacks[callbackId] != undefined){
			handler.messageCallbacks[callbackId](message);
			delete handler.messageCallbacks[callbackId];
		}
	}
};

Async.instance.OnAsyncCall = (name, args, lambdaId, callbackId) => {
	const handler = Async.instance.Callbacks[lambdaId];

	if(handler != undefined){
		if(handler.bridges[name] != undefined){
			//Async.DevLog(`name: ${name} args:${args} id: ${lambdaId}`);
			//Async.DevLog(handler.bridges[name].toString());
			handler.bridges[name](args, callbackId);
		}
	}
};

//console.log(JSON.stringify(Async.instance))

Async.Lambda = (capture, rawFunction, callback)=>{
	let captureString = "";
	let handler = new CallbackHandler(Async.instance.NextLambdaId());

	let didFindFunctions = false;	//affects whether we want to pin the lambda after run, 
									//or if it's disposable

	if(typeof(capture) === 'function'){
		//we don't have captures, it's expecting (function, callback)
		callback = rawFunction;
		rawFunction = capture;
	}
	else{
		//find all function passes
		for(let key in capture) {
			if(typeof(capture[key]) === 'function'){
				//Async.DevLog(`found function ${key}`);
				captureString += handler._addBridge(key, capture[key]);

				//captureString += 'console.log("Global: " + JSON.stringify(globalThis));\n';
				didFindFunctions = true;	//pinning should only happen if we export?
			}
			else{
				captureString += `let ${key} = _asyncUtil.parseArgs(${JSON.stringify(capture[key])});\n`;
			}
		}

		//stringification and parsing will end up with the object value of the capture
		//captureString = "let capture = JSON.parse('"+ JSON.stringify(capture) + "');\n";
	}
	
	//function JSON stringifies any result
	const wrappedFunctionString = `\nJSON.stringify({result:(${rawFunction.toString()})(), exports:Object.getOwnPropertyNames(exports)});\n`;
	const finalScript = "var exports = {}; {\n" + 
						`_asyncUtil.parseArgs = ${Async.ParseArgs.toString()}\n` + 
						captureString + 
						wrappedFunctionString + 
						'\n}';


	//look for exported functions (rough method)
	if(finalScript.includes('exports.')){
		didFindFunctions = true;
		//Async.DevLog('found functions');
	}
	handler.pinned = didFindFunctions;
	
	//Debug log final script
	//Async.DevLog(finalScript);
	const lambdaId = Async.instance.RunScript(finalScript, 'ThreadPool', didFindFunctions);

	handler.lambdaId = lambdaId;
	handler._setReturn(callback);

	//Async.DevLog(`handler: ${JSON.stringify(handler)}`);

	//wrap the callback with a JSON.parse so the return value is in object form
	Async.instance.Callbacks[lambdaId] = handler;

	//return a bridge callback
	return handler;
};

Async.RunScript = (scriptText, executionContext) => {
	executionContext = executionContext ? executionContext : 'ThreadPool';

	Async.instance.RunScript(scriptText, executionContext);
};

console.log('async.js loaded');