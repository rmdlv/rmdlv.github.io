// Protocol reconstruction checked against original ARM64 encryption vectors.
export const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
export const unhex = text => Uint8Array.from(text.match(/../g) || [], x => parseInt(x, 16));
export const join = (...parts) => Uint8Array.from(parts.flatMap(x => [...x]));
const FW = unhex('97cfb802844143de56002b3b34780a5d');
const pad = value => { const out = new Uint8Array(16); out.set(value.slice(0, 16)); return out; };
const xor = (a, b) => a.map((x, i) => x ^ b[i]);
export class NinebotCrypto {
  constructor(auth = new Uint8Array(16), counter = 0) { this.auth = pad(auth); this.counter = counter; }
  async setKey(key1, key2 = null) {
    const digest = await crypto.subtle.digest('SHA-1', join(pad(key1), key2 === null ? FW : pad(key2)));
    this.key = await crypto.subtle.importKey('raw', digest.slice(0, 16), 'AES-CBC', false, ['encrypt']);
  }
  async aes(block) {
    // CBC with a zero IV has ECB as its first block; discard the PKCS#7 block.
    return new Uint8Array(await crypto.subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(16)}, this.key, block)).slice(0, 16);
  }
  nonce(counter, flags = 1) {
    const block = new Uint8Array(16); block[0] = flags;
    new DataView(block.buffer).setUint32(1, counter, false); block.set(this.auth.slice(0, 8), 5); return block;
  }
  async crypt(body, counter) {
    const out = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i += 16) {
      const block = counter ? this.nonce(counter) : FW.slice();
      if (counter) block[15] = i / 16 + 1;
      out.set(xor(body.slice(i, i + 16), await this.aes(block)), i);
    }
    return out;
  }
  async tag(plain, counter) {
    if (!counter) { const crc = ~plain.slice(3).reduce((a, b) => a + b, 0) & 65535; return Uint8Array.of(0, 0, crc & 255, crc >> 8); }
    const block = this.nonce(counter, 0x59); block[15] = plain.length - 3;
    let mac = await this.aes(block);
    mac = await this.aes(xor(mac, pad(plain.slice(0, 3))));
    for (let i = 3; i < plain.length; i += 16) mac = await this.aes(xor(mac, pad(plain.slice(i, i + 16))));
    return xor(mac, await this.aes(this.nonce(counter))).slice(0, 4);
  }
  async encrypt(plain) {
    return this.encryptAt(plain, this.counter ? this.counter + 1 : 0);
  }
  async encryptAt(plain, counter) {
    if (plain.length < 7 || plain.length !== plain[2] + 7) throw Error('Invalid command length');
    if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) throw Error('Invalid packet counter');
    this.counter = counter;
    return join(plain.slice(0, 3), await this.crypt(plain.slice(3), this.counter), await this.tag(plain, this.counter), [this.counter >> 8 & 255, this.counter & 255]);
  }
  async decrypt(wire) {
    if (wire.length < 13 || wire[0] !== 0x5a || wire[1] !== 0xa5 || wire.length !== wire[2] + 13) throw Error('Invalid Bluetooth packet');
    const low = wire.at(-2) * 256 + wire.at(-1);
    let counter = Math.floor(this.counter / 65536) * 65536 + low;
    if ((this.counter & 0x8000) && !(low & 0x8000)) counter += 65536;
    if (counter && counter <= this.counter) throw Error('Replayed Bluetooth packet');
    const plain = join(wire.slice(0, 3), await this.crypt(wire.slice(3, -6), counter));
    const tag = await this.tag(plain, counter);
    if (tag.reduce((diff, b, i) => diff | (b ^ wire[wire.length - 6 + i]), 0)) throw Error('Bluetooth packet authentication tag mismatch');
    this.counter = counter; return plain;
  }
}
export class FrameBuffer {
  constructor() { this.buffer = new Uint8Array(); }
  feed(bytes) {
    this.buffer = join(this.buffer, bytes); const frames = [];
    while (this.buffer.length >= 3) {
      if (this.buffer[0] !== 0x5a || this.buffer[1] !== 0xa5) { this.buffer = this.buffer.slice(1); continue; }
      const size = this.buffer[2] + 13;
      if (this.buffer.length < size) break;
      frames.push(this.buffer.slice(0, size)); this.buffer = this.buffer.slice(size);
    }
    return frames;
  }
}
