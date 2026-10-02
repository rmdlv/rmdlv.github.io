// SPDX-License-Identifier: AGPL-3.0-only
// Browser-local only. No credentials, keys or identity are sent over HTTP.
import {digest} from './ctrl-ota.mjs';
const PREFIX='e2plus-flasher.bond.v1.';
const key=async identity=>PREFIX+await digest(new TextEncoder().encode(JSON.stringify([identity.name,identity.serial])));
export class BrowserBonds {
  constructor(storage,enabled=()=>true){this.storage=storage;this.enabled=enabled;}
  async load(identity){
    if(!this.enabled())return null;
    try {const raw=this.storage.getItem(await key(identity));return raw?JSON.parse(raw):null;}
    catch{return null;}
  }
  async save(bond){if(this.enabled())this.storage.setItem(await key(bond),JSON.stringify(bond));else throw Error('Key storage is disabled');}
  forgetAll(){
    for(let i=this.storage.length-1;i>=0;i--){const k=this.storage.key(i);if(k?.startsWith(PREFIX))this.storage.removeItem(k);}
  }
}
