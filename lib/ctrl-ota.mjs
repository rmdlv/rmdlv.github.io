// E2 Plus II CTRL-only IAP. No radio access or mutation at module load.
import {join,hex} from './ble-crypto.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const u16 = b => b[0] | b[1]<<8;
// Public release: explicit, narrow compatibility policy. The default remains
// bound to the single serial hash used by the local research console.
export const PUBLIC_E2_POLICY = 'e2plus2-n2sr-ctrl131-ble21c';
export async function checkSerial(sn,plan) {
  if(!/^N2SR[A-Z0-9]{10}$/.test(sn))throw Error('Only E2 Plus II scooters with an N2SR serial number are supported');
  if(plan.serial_policy===PUBLIC_E2_POLICY&&!plan.device_serial_sha256)return;
  if(await digest(new TextEncoder().encode(sn))!==plan.device_serial_sha256)throw Error('This package is bound to a different scooter');
}
// Temporary user-requested exception for this exact Start0 package only.
// A new build/hash or any rollback retains the default 50% threshold.
export function minimumOtaBattery(plan) {
  return plan?.id==='response2-start0' &&
    plan.sha256==='51b0cd63ed86a5305c7e98a4dfaa263166e987a040b3e07ca602822d098093f2' ? null : 50;
}
export async function digest(bytes) {return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
export function lengthBytes(n) {return Uint8Array.of(n&255,n>>>8&255,n>>>16&255,n>>>24&255);}
export function finishChecksum(bytes) {let sum=0;for(const b of bytes)sum=(sum+b)>>>0;return lengthBytes(~sum>>>0);}
export function dataBlocks(bytes) {
  const out=[];
  for(let i=0;i<bytes.length;i+=128){const data=new Uint8Array(128);data.set(bytes.slice(i,i+128));out.push({index:out.length&255,data});}
  return out;
}
export async function readCtrlBuild(client,timeout=3000) {
  client.ctrlBuild=null;
  const reply=await client.request(0x7e,0xa5,new TextEncoder().encode('ID?1'),0x20,0x7e,0xa5,timeout);
  if(!(reply instanceof Uint8Array)||reply.length!==23||reply[2]!==16||reply[3]!==0x20||reply[4]!==0x3e||reply[5]!==0x7e||reply[6]!==0xa5)throw Error('Invalid CTRL build ID reply');
  const marker=new TextDecoder().decode(reply.slice(7));
  if(!/^[A-Za-z0-9.!-]{16}$/.test(marker))throw Error('Invalid CTRL build ID format');
  client.ctrlBuild=marker;client.record('ctrl_build',{marker});return marker;
}
export async function validatePackage(bytes,plan) {
  if(!(bytes instanceof Uint8Array)||!plan||plan.model!=='536'||plan.part!=='ctrl'||plan.version!==305||
     !Number.isInteger(plan.bytes)||bytes.length!==plan.bytes||bytes.length===0||bytes.length>0xd780||bytes.length%8||
     !/^[a-f0-9]{64}$/.test(plan.sha256)||
     !(plan.serial_policy===PUBLIC_E2_POLICY&&!plan.device_serial_sha256||
       !plan.serial_policy&&/^[a-f0-9]{64}$/.test(plan.device_serial_sha256||'')))throw Error('Invalid CTRL package manifest');
  if(await digest(bytes)!==plan.sha256)throw Error('OTA package SHA-256 mismatch');
  if(plan.expected_build_marker&&!/^[A-Za-z0-9.!-]{16}$/.test(plan.expected_build_marker))throw Error('Invalid build ID in the manifest');
}
function replyData(frame,index,length) {
  if(!(frame instanceof Uint8Array)||frame.length!==7+length||frame[2]!==length||frame[3]!==0x20||frame[4]!==0x3e||frame[5]!==4||frame[6]!==index)throw Error('Invalid preflight read reply');
  return frame.slice(7);
}
function ack(frame) {
  if(!(frame instanceof Uint8Array)||frame.length!==7||frame[2]!==0||frame[3]!==0x20||frame[4]!==0x3e||frame[5]!==0x0b)throw Error('Invalid update acknowledgement');
  if(frame[6]!==0){const e=Error(frame[6]===4?'OTA is not allowed in the current state (code 4): the stock lock must be enabled':`Controller rejected OTA: code ${frame[6]}`);e.code='OTA_REJECTED';throw e;}
}

export async function flashCtrl(client,bytes,plan,{onProgress=()=>{},stopped=()=>false,wait=pause}={}) {
  await validatePackage(bytes,plan); // Must succeed before even a read request.
  if(!client?.ready)throw Error('Connect to the scooter first');
  if(client.otaActive)throw Error('An update is already in progress');
  client.otaActive=true;
  client.ctrlBuild=null;
  const report={format:'ninebot-ctrl-ota-v1',started_at:new Date().toISOString(),id:plan.id,sha256:plan.sha256,
    bytes:bytes.length,status:'preflight',rows:[],preflight:{},commit_attempted:false,finish_ack:false,reset_sent:false};
  client.otaReports??=[];client.otaReports.push(report);
  const notify=()=>onProgress(report);
  const check=()=>{if(stopped()){const e=Error('Transfer stopped before applying; no automatic restart');e.code='STOPPED';throw e;}if(!client.ready)throw Error('Bluetooth disconnected');};
  try {
    return await client.serialOperation(async()=>{
      async function read(index,length,padded=false){check();const data=padded?new Uint8Array(128):new Uint8Array(1);data[0]=length;return replyData(await client.request(1,index,data,0x20,4,index,5000),index,length);}
      async function command(cmd,index,data,timeout=5000){check();const row={cmd,index,at:new Date().toISOString()};report.rows.push(row);
        // No retry: ACK has no packet sequence. A late ACK must never advance a
        // different packet after a timeout; abort this transaction instead.
        try {const frame=await client.request(cmd,index,data,0x20,0x0b,null,timeout);row.reply_index=frame[6];ack(frame);row.ok=true;}
        catch(e){row.error=e.message;throw e;}}
      notify();
      const serial=await read(0x10,14);
      const sn=new TextDecoder().decode(serial).replace(/\0+$/,'');
      await checkSerial(sn,plan);
      report.preflight.device_match=true;
      const version=u16(await read(0x1a,2));if(version!==0x131)throw Error('CTRL 1.3.1 is required');report.preflight.ctrl_version=version;
      const ble=u16(await read(0x68,2));if(ble!==0x21c)throw Error('The tested BLE 2.1.12 dashboard is required');report.preflight.ble_version=ble;
      const battery=u16(await read(0xb4,2));
      const minimum=minimumOtaBattery(plan);
      Object.assign(report.preflight,{battery,battery_minimum:minimum,battery_threshold_waived:minimum===null});
      if(battery>100)throw Error(`Invalid battery level: ${battery}%`);
      if(minimum!==null&&battery<minimum)throw Error(`This OTA package requires at least ${minimum}% battery; reported level is ${battery}%`);
      const fault=u16(await read(0x1b,2));if(fault)throw Error(`Resolve controller error ${fault} first`);
      const firstSpeed=u16(await read(0xb5,2));await wait(250);const secondSpeed=u16(await read(0xb5,2));
      if(firstSpeed!==0||secondSpeed!==0)throw Error('The scooter must be stationary before flashing');
      report.preflight.speed_zero_twice=true;
      // Read-only 141-byte encrypted frame: exercise the same GATT/frame size
      // as the OTA data before CMD07 erases the staging area.
      if(u16(await read(0x1a,2,true))!==0x131)throw Error('Large-frame transfer check failed');
      report.preflight.large_frame_read=true;
      if(u16(await read(0xb5,2))!==0)throw Error('Speed changed before flashing');
      // App_Main sets flag 0. A normally running CTRL rejects CMD07..0A with
      // code 4 unless the stock lock flag 2 is set. Use the normal writable
      // lock register, then verify its public status; never bypass this gate.
      let state=u16(await read(0xb2,2));
      report.preflight.was_locked=Boolean(state&2);
      if(!(state&2)){
        report.status='locking';notify();check();report.preflight.lock_requested=true;
        const reply=await client.request(2,0x70,Uint8Array.of(1,0),0x20,5,null,5000);
        if(!(reply instanceof Uint8Array)||reply.length!==7||reply[2]!==0||reply[3]!==0x20||reply[4]!==0x3e||reply[5]!==5||reply[6]!==0)throw Error('Controller did not confirm the lock request; firmware transfer has not started');
        for(let attempt=0;attempt<10&&!(state&2);attempt++){await wait(150);state=u16(await read(0xb2,2));}
        if(!(state&2))throw Error('The stock lock did not engage; firmware transfer has not started');
      }
      report.preflight.lock_confirmed=true;
      if(u16(await read(0xb5,2))!==0)throw Error('Speed changed after locking');
      report.status='begin';notify();await command(7,0,lengthBytes(bytes.length),15000);
      const blocks=dataBlocks(bytes);report.total_blocks=blocks.length;report.acked_blocks=0;report.status='sending';
      for(const block of blocks){await command(8,block.index,block.data);report.acked_blocks++;notify();}
      check();report.status='committing';report.commit_attempted=true;notify();await command(9,0,finishChecksum(bytes),15000);
      report.finish_ack=true;report.status='accepted';notify();
      // After successful commit, complete reset even if the user now requests
      // cancellation: it cannot undo a committed image. CMD0A has no reply.
      await wait(150);
      const wire=await client.tx.encryptAt(join([0x5a,0xa5,0,0x3e,0x20,10,0],[]),++client.iteration);
      client.record('ota_reset',{wire_hex:hex(wire)});
      try {await client.writeFrame(wire);report.reset_sent=true;}
      catch(e){report.reset_error=e.message;}
      report.status='accepted_restart_unverified';notify();
      await wait(2500);
      if(client.ready){try {
        const v=replyData(await client.request(1,0x1a,Uint8Array.of(2),0x20,4,0x1a,5000),0x1a,2);
        const err=replyData(await client.request(1,0x1b,Uint8Array.of(2),0x20,4,0x1b,5000),0x1b,2);
        report.after={ctrl_version:u16(v),error:u16(err)};
        if(u16(v)===0x131&&u16(err)===0)report.status='accepted_controller_responds';
        const state=replyData(await client.request(1,0xb2,Uint8Array.of(2),0x20,4,0xb2,5000),0xb2,2);
        report.after.locked=Boolean(u16(state)&2);
        if(plan.expected_build_marker){
          report.status='accepted_build_unverified';
          report.after.build_marker=await readCtrlBuild(client);
          report.after.build_matches=report.after.build_marker===plan.expected_build_marker;
          report.status=report.after.build_matches&&u16(v)===0x131&&u16(err)===0?'accepted_build_verified':'accepted_build_mismatch';
        }
      }catch(e){report.after_error=e.message;}}
      report.note='ACK and post-restart register response are not a full Flash readback or proof of dynamic performance.';
      report.finished_at=new Date().toISOString();notify();return report;
    });
  } catch(e) {
    report.status=report.commit_attempted?'commit_outcome_uncertain':e.code==='STOPPED'?'stopped_before_commit':'failed_before_commit';
    report.error=e.message;report.finished_at=new Date().toISOString();notify();throw e;
  } finally {client.otaActive=false;}
}
