// SPDX-License-Identifier: AGPL-3.0-only
import {checkSerial,readCtrlBuild} from './ctrl-ota.mjs';
import {RELEASE} from './release.mjs';
const u16=b=>b[0]|b[1]<<8;
export async function readRegister(client,index,length=2) {
  const f=await client.request(1,index,Uint8Array.of(length),0x20,4,index,5000);
  if(!(f instanceof Uint8Array)||f.length!==7+length||f[0]!==0x5a||f[1]!==0xa5||f[2]!==length||f[3]!==0x20||f[4]!==0x3e||f[5]!==4||f[6]!==index)throw Error('Invalid controller reply. Reconnect.');
  return f.slice(7);
}
export async function inspectDevice(client) {
  return client.serialOperation(async()=>{
    if(!client.ready)throw Error('Connect to the scooter first.');
    const sn=new TextDecoder().decode(await readRegister(client,0x10,14)).replace(/\0+$/,'');
    await checkSerial(sn,RELEASE);
    const ctrl=u16(await readRegister(client,0x1a));
    if(ctrl!==0x131)throw Error('This build supports CTRL 1.3.1 only. Other versions are untested.');
    const ble=u16(await readRegister(client,0x68));
    if(ble!==0x21c)throw Error('BLE 2.1.12 is required. Other dashboard versions are untested.');
    const battery=u16(await readRegister(client,0xb4));
    if(battery>100)throw Error('The controller reported an invalid battery level.');
    const fault=u16(await readRegister(client,0x1b));
    if(fault)throw Error(`Resolve controller error ${fault} first.`);
    const speed=u16(await readRegister(client,0xb5));
    const locked=Boolean(u16(await readRegister(client,0xb2))&2);
    return {compatible:true,ctrl,ble,battery,speed,locked}; // No personal identity exported.
  });
}
export async function verifyBuild(client) {
  const device=await inspectDevice(client);
  const marker=await client.serialOperation(()=>readCtrlBuild(client,5000));
  return {...device,marker,installed:marker===RELEASE.expected_build_marker};
}
export async function unlockDevice(client) {
  const device=await inspectDevice(client);
  if(device.speed!==0)throw Error('Stop the scooter before unlocking.');
  return client.serialOperation(async()=>{
    if(u16(await readRegister(client,0xb5))!==0)throw Error('The scooter started moving.');
    const f=await client.request(2,0x71,Uint8Array.of(1,0),0x20,5,null,5000);
    if(!(f instanceof Uint8Array)||f.length!==7||f[2]!==0||f[3]!==0x20||f[4]!==0x3e||f[5]!==5||f[6]!==0)throw Error('Unlocking was not confirmed.');
    for(let i=0;i<10;i++){
      await new Promise(r=>setTimeout(r,150));
      if(!(u16(await readRegister(client,0xb2))&2))return;
    }
    throw Error('The controller is still locked. Use the official app to unlock it.');
  });
}
