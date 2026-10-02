// SPDX-License-Identifier: AGPL-3.0-only
// Handshake sequence: scooterhacking/NinebotCrypto README, steps 5–11.
// No radio activity at module load, no automatic reconnection.
import {NinebotCrypto, FrameBuffer, join, hex, unhex} from './ble-crypto.mjs';
export const UART = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const text = new TextEncoder();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class NinebotClient {
  constructor(onState = () => {}, onLog = () => {}, onTrace = () => {}, bondStore = null) {
    this.onState = onState; this.onLog = onLog; this.ready = false;
    this.onTrace = onTrace;
    this.bondStore = bondStore;
    this.pending = null; this.queue = Promise.resolve(); this.cancelled = false;
    this.writesInFlight = 0;
    this.trace = []; this.traceSequence = 0; this.started = performance.now();
    this.record('client_created', {revision:'2026.10.02.24'});
  }
  record() {} // Privacy: no raw frames, pairing keys or device identifiers in logs.
  state(phase, message) { this.phase = phase; this.record('state',{message}); this.onState({phase, message}); }
  async connect({forcePairing = false} = {}) {
    if (!navigator.bluetooth) throw Error('Open this address in Chrome or Edge: this browser does not provide Web Bluetooth.');
    this.cancelled = false;
    // requestDevice must execute synchronously from the user's click handler.
    this.device = await navigator.bluetooth.requestDevice({filters: [{services: [UART]}, {namePrefix: 'Ninebot'}, {namePrefix: 'N2'}], optionalServices: [UART]});
    this.record('device_selected',{name:this.device.name});
    if (this.cancelled) throw Error('Connection cancelled');
    this.state('connecting', 'Connecting to the selected scooter…');
    this.device.addEventListener('gattserverdisconnected', () => this.closed());
    const server = await this.device.gatt.connect();
    if (this.cancelled) { this.device.gatt.disconnect(); throw Error('Connection cancelled'); }
    const service = await server.getPrimaryService(UART);
    this.writer = await service.getCharacteristic(TX);
    this.reader = await service.getCharacteristic(RX);
    this.record('gatt_ready',{service:UART,tx:TX,rx:RX,write:this.writer.properties.write,writeWithoutResponse:this.writer.properties.writeWithoutResponse});
    this.name = this.device.name || '';
    if (!this.name) throw Error('The device did not provide a name for authentication');
    this.tx = new NinebotCrypto(); this.rx = new NinebotCrypto(); this.bootstrap = new NinebotCrypto();
    // Fixed upstream sequence (BetterNinebotCrypto.swift / issue #13):
    // PRE_COMM uses 0; the first SET_PWD MUST use 1, not 2.
    this.iteration = -1;
    await Promise.all([this.tx.setKey(text.encode(this.name)), this.rx.setKey(text.encode(this.name)), this.bootstrap.setKey(text.encode(this.name))]);
    this.record('key_phase',{key1_hex:hex(text.encode(this.name)),key2_hex:null,mode:'bootstrap'});
    this.frames = new FrameBuffer(); this.incoming = Promise.resolve();
    this.reader.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      this.record('rx_chunk',{hex:hex(bytes),length:bytes.length});
      const frames = this.frames.feed(bytes);
      for (const wire of frames) this.incoming = this.incoming.then(() => this.receive(wire)).catch(error => { this.record('rx_error',{message:error.message,wire_hex:hex(wire)}); this.onLog('Packet error: ' + error.message); this.rejectPending(error); });
    });
    await this.reader.startNotifications();
    this.state('handshake', 'Authentication: reading connection parameters…');
    const init = await this.request(0x5b, 0, new Uint8Array(), 0x21, 0x5b);
    if (init.length !== 37) throw Error('Unsupported authentication reply');
    const auth = init.slice(7, 23);
    const serial = init.slice(23, 37);
    this.serial = new TextDecoder().decode(serial).replace(/\0+$/, '');
    this.tx.auth = auth; this.rx.auth = auth;
    const identity={name:this.name,serial:this.serial};
    const bond=forcePairing?null:await this.bondStore?.load(identity);
    if(bond && (bond.serial!==this.serial || bond.name!==this.name || !/^[a-f0-9]{32}$/.test(bond.app_key)))throw Error('The saved key does not match this device');
    this.record('bond_lookup',{found:Boolean(bond),pre_comm_status:init[6],force_pairing:forcePairing});
    const appKey = bond ? unhex(bond.app_key) : crypto.getRandomValues(new Uint8Array(16));
    if(bond && init[6]!==1)throw Error('The dashboard did not retain the pairing. Select Pair again; the dashboard button will be required.');
    if(!bond){
    await Promise.all([this.tx.setKey(text.encode(this.name), auth), this.rx.setKey(text.encode(this.name), auth)]);
    this.record('key_phase',{mode:'set_pwd',key1_hex:hex(text.encode(this.name)),key2_hex:hex(auth),auth_hex:hex(auth),serial_hex:hex(serial)});
    this.state('button', 'Press the dashboard button once. Waiting up to 45 seconds for confirmation.');
    this.buttonConfirmed = false;
    const deadline = Date.now() + 45000;
    while (!this.buttonConfirmed && Date.now() < deadline) {
      this.checkConnected();
      try {
        const reply = await this.request(0x5c, 0, appKey, 0x21, 0x5c, 1, 1300);
        this.record('set_pwd_reply',{status:reply[6]});
        this.buttonConfirmed = reply[6] === 1;
      } catch (e) { if (e.code !== 'TIMEOUT') throw e; }
      if (!this.buttonConfirmed) await delay(200);
    }
    if (!this.buttonConfirmed) throw Error('The scooter did not confirm the button press. Reconnect manually to try again.');
    }
    await Promise.all([this.tx.setKey(appKey, auth), this.rx.setKey(appKey, auth)]);
    this.record('key_phase',{mode:'auth',key1_hex:hex(appKey),key2_hex:hex(auth),auth_hex:hex(auth)});
    this.state('handshake', bond ? 'Restoring pairing with the saved key. No button press is needed…' : 'Confirming session…');
    let accepted = false;
    let lastAuthStatus = null, authTimeouts = 0;
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      this.record('auth_attempt',{attempt:attempt+1});
      try { lastAuthStatus = (await this.request(0x5d, 0, serial, 0x21, 0x5d))[6]; accepted = lastAuthStatus === 1; this.record('auth_reply',{status:lastAuthStatus}); }
      catch (e) { if (e.code !== 'TIMEOUT') { if(bond)throw Error('Saved key not accepted: '+e.message+'. Select Pair again to replace it.'); throw e; } authTimeouts++; }
    }
    if (!accepted) throw Error((lastAuthStatus === null ? `No AUTH (0x5D) reply: ${authTimeouts} timeouts. This is not an explicit rejection by the scooter.` : `AUTH (0x5D): scooter returned status ${lastAuthStatus}; expected 1. Timeouts: ${authTimeouts}.`) + (bond ? ' The saved key has been retained. Use Pair again to create a new pairing.' : ''));
    this.bondRestored=Boolean(bond);this.bondSaved=false;
    if(this.bondStore){
      try{await this.bondStore.save({...identity,app_key:hex(appKey)});this.bondSaved=true;this.record('bond_saved',{restored:this.bondRestored});}
      catch(e){this.record('bond_save_error',{message:e.message});this.onLog('Connected, but the key was not saved: '+e.message);}
    }
    this.ready = true;
    this.state('ready', 'Connected. '+(bond?'Pairing restored without a button press. ':this.bondSaved?'Pairing key saved. ':'')+(this.bondStore&&!this.bondSaved?'Could not save the key.':'Device is ready.'));
  }
  checkConnected() {
    if (this.cancelled || !this.device?.gatt.connected) throw Error('Bluetooth disconnected');
  }
  async receive(wire) {
    this.record('rx_frame',{hex:hex(wire),length:wire.length,wire_counter:wire.at(-2)*256+wire.at(-1)});
    let plain;
    try { plain = await this.rx.decrypt(wire); }
    catch (error) {
      if (this.phase !== 'ready' && wire.at(-1) === 0 && wire.at(-2) === 0) {
        const old = await this.bootstrap.decrypt(wire); // Validate delayed pre-auth notification, then ignore it.
        this.record('rx_bootstrap_delayed',{plaintext_hex:hex(old)});
        this.onLog('Ignored a delayed pre-authentication message'); return;
      }
      throw error;
    }
    this.onLog(`← cmd ${plain[5].toString(16)} · index ${plain[6]} · ${plain[2]} bytes`);
    this.record('rx_plain',{hex:hex(plain),source:plain[3],target:plain[4],cmd:plain[5],index:plain[6],payload_hex:hex(plain.slice(7))});
    if (this.rx.counter > 0) this.iteration = this.rx.counter > this.iteration ? this.rx.counter : this.iteration + 1;
    // The power-button ACK is an asynchronous event, not necessarily the reply
    // to the currently pending request. Preserve it even between retries.
    if (this.phase === 'button' && plain[3] === 0x21 && plain[4] === 0x3e && plain[5] === 0x5c && plain[6] === 1) {
      this.buttonConfirmed = true;
      this.record('button_confirmed',{asynchronous:!this.pending});
      this.onLog('Button press confirmed. SET_PWD retries stopped.');
    }
    const p = this.pending;
    if (p && plain[3] === p.source && plain[4] === p.destination && plain[5] === p.cmd && (p.index === null || plain[6] === p.index)) {
      // A late FEED and STOP share cmd/index. The bench must additionally
      // verify stopped state before that packet can settle a STOP request.
      if (p.replyFilter && !p.replyFilter(plain)) {
        this.record('reply_filtered',{cmd:plain[5],index:plain[6]});
        return;
      }
      this.record('reply_matched',{cmd:plain[5],index:plain[6]});
      clearTimeout(p.timer); this.pending = null; p.resolve(plain);
    } else this.record('reply_unmatched',{cmd:plain[5],index:plain[6],waiting_for:p ? {cmd:p.cmd,index:p.index,source:p.source} : null});
  }
  async request(cmd, index, data, target, replyCmd, replyIndex = null, timeout = 3000, source = 0x3e, replyFilter = null) {
    this.checkConnected();
    if (![0x3d,0x3e].includes(source)) throw Error('Unknown application address');
    if (this.pending) throw Error('The previous command is still pending');
    const plain = join([0x5a, 0xa5, data.length, source, target, cmd, index], data);
    const wire = await this.tx.encryptAt(plain, ++this.iteration);
    this.record('tx_frame',{cmd,index,target,plaintext_hex:hex(plain),wire_hex:hex(wire),length:wire.length,timeout_ms:timeout});
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending?.timer === timer) this.pending = null; this.record('timeout',{cmd:replyCmd,index:replyIndex,timeout_ms:timeout}); const e = Error('The scooter did not reply to the command'); e.code = 'TIMEOUT'; reject(e); }, timeout);
      this.pending = {resolve, reject, timer, source: target, destination:source, cmd: replyCmd, index: replyIndex, replyFilter, writeCompleted:false};
    });
    const pending = this.pending;
    // Attach a rejection handler before awaiting GATT writes.
    answer.catch(() => {});
    try {
      this.onLog(`→ cmd ${cmd.toString(16)} · index ${index} · ${data.length} bytes · SN ${this.iteration}`);
      await this.writeFrame(wire);
      pending.writeCompleted = true;
    } catch (error) { this.rejectPending(error); }
    return answer;
  }
  serialOperation(operation) {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  async writeFrame(wire) {
    this.checkConnected();
    // A single GATT write per protocol frame. Newer Ninebot firmware can drop
    // manually split 27/29-byte AUTH/SET_PWD frames. ATT handles the negotiated MTU.
    const mode=this.writer.properties.write?'with_response':'without_response';
    this.record('tx_chunk',{offset:0,hex:hex(wire),length:wire.length,mode});
    this.writesInFlight++;
    try {
      if (this.writer.properties.write) await this.writer.writeValueWithResponse(wire);
      else await this.writer.writeValueWithoutResponse(wire);
      this.record('tx_chunk_written',{offset:0,length:wire.length});
    } finally { this.writesInFlight--; }
  }
  rejectPending(error) { this.record('request_error',{name:error.name,message:error.message,code:error.code || null}); const p = this.pending; if (p) { this.pending = null; clearTimeout(p.timer); p.reject(error); } }
  closed() { if (!this.ready && this.phase === 'disconnected') return; this.ready = false; this.rejectPending(Error('Bluetooth disconnected')); this.state('disconnected', 'Disconnected. Automatic reconnection is disabled.'); }
  disconnect(reason = 'explicit_disconnect') { this.record('disconnect_requested',{reason,writes_in_flight:this.writesInFlight}); this.cancelled = true; this.device?.gatt?.disconnect(); this.closed(); }
}

