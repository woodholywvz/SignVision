const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  const calls = {clears: 0, circles: 0, sends: 0, closed: 0};
  const context = {clearRect(){calls.clears++},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){calls.circles++},fill(){},drawImage(){}};
  let blobCallback;
  const capture = {getContext: () => context, toBlob(callback){blobCallback = callback}};
  const overlay = {width: 640, height: 480, getContext: () => context};
  class Socket { static OPEN = 1; constructor(){this.readyState=1} send(){calls.sends++} close(){calls.closed++} }
  const sandbox = {window:{},document:{createElement:()=>capture},WebSocket:Socket,URL,
    location:{href:'http://localhost:8000/',protocol:'http:'}, performance:{now:()=>100},
    setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/tracking.js'),'utf8'),sandbox);
  const tracker = new sandbox.window.LiveTracking({videoWidth:640,videoHeight:480,readyState:2},overlay,()=>{});
  return {tracker,calls,completeBlob:()=>blobCallback({size:123})};
}

test('a late encoded frame cannot be sent after tracking stops',()=>{
  const {tracker,calls,completeBlob}=harness(); tracker.start(); tracker.send(tracker.run);
  tracker.stop(); completeBlob(); assert.equal(calls.sends,0); assert.equal(calls.closed,1);
});
test('missing hands clear previous landmarks and do not draw fake points',()=>{
  const {tracker,calls}=harness();
  tracker.draw({hands:[{points:Array.from({length:21},()=>[.5,.5,0])}],pose:[]});
  assert.equal(calls.circles,21);
  tracker.draw({hands:[],pose:[]}); assert.equal(calls.clears,2); assert.equal(calls.circles,21);
});
test('restarting tracking discards callbacks from the earlier session',()=>{
  const {tracker,calls,completeBlob}=harness(); tracker.start(); tracker.send(tracker.run);
  tracker.start(); completeBlob(); assert.equal(calls.sends,0);
});
