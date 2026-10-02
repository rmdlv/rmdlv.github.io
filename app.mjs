// SPDX-License-Identifier: AGPL-3.0-only
import {NinebotClient} from './lib/ble-client.mjs';
import {flashCtrl,validatePackage} from './lib/ctrl-ota.mjs';
import {RELEASE,OTA_URL} from './lib/release.mjs';
import {inspectDevice,verifyBuild,unlockDevice} from './lib/device.mjs';
import {BrowserBonds} from './lib/bonds.mjs';

const $=id=>document.getElementById(id);
let client=null,device=null,firmware=null,busy=false,flashing=false,cancel=false,report=null,wake=null;
const supported=Boolean(window.isSecureContext&&navigator.bluetooth&&crypto.subtle);
let storage=null;try{storage=window.localStorage;}catch{}
const bonds=storage?new BrowserBonds(storage,()=>$('remember').checked):null;
function status(message,kind='idle'){$('status').textContent=message;$('status-dot').dataset.kind=kind;}
function controls(){
  const ready=Boolean(client?.ready);
  $('connect').disabled=!supported||busy;
  $('connect').textContent=ready?'Disconnect Bluetooth':'Connect via Bluetooth';
  $('re-pair').disabled=!supported||busy;
  $('forget').disabled=busy||!bonds;
  $('remember').disabled=busy||!bonds;
  $('consent').disabled=busy;
  $('flash').disabled=busy||!ready||!device?.compatible||!firmware||!$('consent').checked||device.battery<50||device.speed!==0;
  $('verify').disabled=busy||!ready||!device?.compatible;
  $('unlock').hidden=!ready||!device?.locked;
  $('unlock').disabled=busy;
  $('cancel').hidden=!flashing;
  $('cancel').disabled=Boolean(report?.commit_attempted)||cancel;
}
function showDevice(value){
  device=value;$('device').hidden=!value;
  if(value)$('battery').textContent=value.battery+'%';
  controls();
}
async function loadFirmware(){
  const response=await fetch(OTA_URL,{cache:'no-cache',credentials:'omit'});
  if(!response.ok)throw Error('OTA file not found. Check that all site files have been published.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  await validatePackage(bytes,RELEASE);firmware=bytes;controls();
}
function onState({phase,message}){
  if(phase==='button')status(message,'busy');
  else if(phase==='connecting'||phase==='handshake')status(message,'busy');
  else if(phase==='disconnected'){
    showDevice(null);
    if(!flashing&&!busy)status('Bluetooth disconnected. Reconnect to continue.');
  }
  controls();
}
async function connect(forcePairing=false){
  if(busy)return;
  if(client?.ready&&!forcePairing){client.disconnect();showDevice(null);controls();return;}
  client?.disconnect();busy=true;report=null;showDevice(null);controls();
  status('Select your E2 Plus II in the Bluetooth dialog.','busy');
  client=new NinebotClient(onState,()=>{},()=>{},bonds);
  try{
    // No await before this call: the chooser keeps the user's click activation.
    await client.connect({forcePairing});
    status('Reading model, versions and device status…','busy');
    const value=await inspectDevice(client);showDevice(value);
    if(value.battery<50)status(`Compatible version. Battery is at ${value.battery}%. Charge to at least 50%, then reconnect.`,'error');
    else if(value.speed!==0)status('The wheel is moving. Stop it, then reconnect.','error');
    else status('Model and versions match. Read the warning and confirm you are ready.','success');
    if(bonds&&$('remember').checked&&!client.bondSaved)status('Connected, but the browser could not save the key. The dashboard button will be needed next time.');
  }catch(error){
    client.disconnect();showDevice(null);
    status(error.name==='NotFoundError'?'Device selection cancelled.':error.message,'error');
  }finally{busy=false;controls();}
}
function progress(r){
  report=r;
  const percent=r.total_blocks?Math.floor(100*(r.acked_blocks||0)/r.total_blocks):0;
  $('progress-wrap').hidden=false;$('progress').value=percent;$('percent').textContent=percent+'%';
  const text={preflight:'Preflight checks',locking:'Locking scooter',begin:'Preparing flash memory',sending:`Sending: ${r.acked_blocks||0} / ${r.total_blocks||424} blocks`,committing:'Applying — keep the scooter powered on',accepted:'File accepted — restarting',accepted_restart_unverified:'Waiting for controller',accepted_controller_responds:'Checking installed build',accepted_build_unverified:'Checking build ID',accepted_build_verified:'Installation verified',accepted_build_mismatch:'Build mismatch',failed_before_commit:'Transfer incomplete',commit_outcome_uncertain:'Update outcome unknown',stopped_before_commit:'Transfer cancelled'};
  $('progress-label').textContent=text[r.status]||'Checking result';
  status($('progress-label').textContent,'busy');controls();
}
async function install(){
  if($('flash').disabled||busy)return;
  busy=true;flashing=true;cancel=false;report=null;controls();
  try{
    // Best effort, no dependency on Wake Lock support. Never delay Bluetooth
    // waiting for a permission dialog; unsupported browsers simply continue.
    try{wake=await navigator.wakeLock?.request('screen');}catch{}
    const result=await flashCtrl(client,firmware,RELEASE,{onProgress:progress,stopped:()=>cancel});
    if(result.after&&device)showDevice({...device,locked:result.after.locked});
    if(result.status==='accepted_build_verified'){
      status('Ride33 S4 installed. The build ID matches and CTRL reports no error. Unlock the scooter, then check throttle release and braking before riding.','success');
    }else{
      status(result.status==='accepted_build_mismatch'?'The controller reports a different build. Ride33 S4 installation is not confirmed. Reconnect and select Verify installed build.':'The file was accepted, but the build could not be verified after restart. Reconnect and select Verify installed build.','error');
      client.disconnect();showDevice(null);
    }
  }catch(error){
    const message=report?.commit_attempted?
      'Update outcome unknown. Reconnect and verify the installed build before attempting another update.':
      cancel?'Transfer cancelled before applying. Reconnect to check status and unlock the scooter.':
      'Transfer incomplete. '+error.message+' Reconnect before trying again. If replies have become slow, use the power button to restart the stationary scooter.';
    // Quarantine the old session: OTA ACK has no sequence number. No retry on
    // the same session after timeout, no stale ACK can advance a new upload.
    client.disconnect();showDevice(null);status(message,'error');
  }finally{
    try{await wake?.release();}catch{}wake=null;busy=false;flashing=false;$('consent').checked=false;controls();
  }
}
async function verify(){
  if(busy||!client?.ready)return;busy=true;controls();status('Checking build ID and controller status…','busy');
  try{
    const result=await verifyBuild(client);showDevice(result);
    status(result.installed?'Ride33 S4 verified. CTRL reports no error. Check throttle release and braking before riding.':'CTRL reports a different build. Ride33 S4 is not confirmed.',result.installed?'success':'error');
  }catch(error){
    status('Build not confirmed: '+error.message,'error');client.disconnect();showDevice(null);
  }finally{busy=false;controls();}
}
async function unlock(){
  if(busy||!client?.ready)return;busy=true;controls();status('Unlocking scooter…','busy');
  try{await unlockDevice(client);showDevice({...device,locked:false});status('Scooter unlocked. Check throttle release and braking before riding.','success');}
  catch(error){status(error.message,'error');client.disconnect();showDevice(null);}
  finally{busy=false;controls();}
}
$('connect').addEventListener('click',()=>connect());
$('re-pair').addEventListener('click',()=>connect(true));
$('flash').addEventListener('click',install);
$('verify').addEventListener('click',verify);
$('unlock').addEventListener('click',unlock);
$('consent').addEventListener('change',controls);
$('cancel').addEventListener('click',()=>{cancel=true;controls();status('Transfer will stop after the current reply. The firmware will not be applied.','busy');});
$('forget').addEventListener('click',()=>{
  try{client?.disconnect();bonds?.forgetAll();showDevice(null);status('Saved keys for this site have been removed. Pressing the dashboard button will be required for new pairing.');}
  catch{status('The browser could not remove saved keys. Clear this site data in browser settings.','error');}
});
window.addEventListener('beforeunload',event=>{if(flashing){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{if(!flashing)client?.disconnect();});
if(!supported){
  $('support-message').hidden=false;
  $('support-message').textContent=window.isSecureContext?'Web Bluetooth is unavailable. Open this HTTPS page in Chrome or Edge on a supported computer or Android device.':'Bluetooth requires HTTPS or localhost. Open the published HTTPS page.';
  status('This browser does not support Bluetooth connections.','error');
}else status('No scooter connected.');
controls();
loadFirmware().catch(error=>{status(error.message,'error');controls();});
