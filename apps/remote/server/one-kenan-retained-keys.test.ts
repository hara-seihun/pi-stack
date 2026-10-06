import { chmodSync, linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test as it } from "bun:test";
import { inheritedCustodyMounts } from "./one-kenan-mounts";
import { retainedCustodyKey } from "./one-kenan-retained-keys";
import type { Person } from "./persons";
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const person:Person={version:1,user:"alice",displayName:"Alice",port:19881,unlock:{cipherDir:"/fixture/cipher",mountpoint:"/fixture/private space"},environment:{}};
it("selects only exact registered gocryptfs mountpoints, decoding mountinfo escapes",()=>{
  const info=["10 1 0:1 / /fixture/private\\040space rw - fuse.gocryptfs /fixture/cipher rw",
    "11 1 0:2 / /fixture/private\\040space/subdir rw - fuse.gocryptfs /fixture/cipher rw",
    "12 1 0:3 / /fixture/other rw - fuse.gocryptfs /fixture/cipher rw",
    "13 1 0:4 / /fixture/private\\040space rw - ext4 /dev/fixture rw"].join("\n");
  expect(inheritedCustodyMounts([person],info)).toEqual(["/fixture/private space"]);
  expect(inheritedCustodyMounts([],info)).toEqual([]);
});
it("rejects unsafe retained files without reading symlinks/nonprivate material",()=>{
  const root=mkdtempSync(join(tmpdir(),"retained-fixture-"));roots.push(root);
  const keys=join(root,"keys");mkdirSync(keys,{mode:0o700});
  const path=join(keys,"alice");writeFileSync(path,"fixture-secret",{mode:0o600});
  if(process.getuid?.()===0) {
    const value=retainedCustodyKey(keys,person);expect(value?.toString()).toBe("fixture-secret");value?.fill(0);
  } else expect(retainedCustodyKey(keys,person)).toBeNull();
  chmodSync(path,0o644);expect(retainedCustodyKey(keys,person)).toBeNull();
  rmSync(path);symlinkSync(join(root,"missing"),path);expect(retainedCustodyKey(keys,person)).toBeNull();
  rmSync(path);writeFileSync(path,"secret\n",{mode:0o600});expect(retainedCustodyKey(keys,person)).toBeNull();
  writeFileSync(path,"secret");linkSync(path,join(root,"duplicate"));expect(retainedCustodyKey(keys,person)).toBeNull();
  rmSync(path);expect(retainedCustodyKey(keys,person)).toBeNull();
  expect(retainedCustodyKey(keys,{...person,user:"../escape"})).toBeNull();
});
