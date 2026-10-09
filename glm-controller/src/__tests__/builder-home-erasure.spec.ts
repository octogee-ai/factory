import { FieldValue } from "firebase-admin/firestore";
import { expect, it, vi } from "vitest";
import { eraseBuilderHomeMigrationStorage } from "../lib/builder-home-erasure.js";
function fixture(){
 const source={runtime:"cluster",layout:"flat",disk:{id:"100"},claim:{name:"old",uid:"claim",volumeName:"old-pv"}};
 const target={runtime:"gce-vm",layout:"portable",disk:{id:"200"}};
 const owner:any={provisioning:{homeStorage:{...target,retained:[source]},homeMigration:{phase:"complete",source,target:target.disk,copy:{targetFilesystem:"btrfs"}}}};
 const update=async(patch:any)=>{for(const [key,value] of Object.entries(patch))owner.provisioning[key.split('.')[1]]=value;};
 const ref={get:async()=>({data:()=>owner}),update};
 const db:any={collection:()=>({doc:()=>ref}),runTransaction:async(work:any)=>work({get:ref.get,update:(_:any,patch:any)=>update(patch)})};
 const deps={db,copy:{abort:vi.fn(async()=>true),sweep:vi.fn(async()=>true)},removeStoppedHome:vi.fn(async()=>true)};
 return {owner,source,target,deps,run:()=>eraseBuilderHomeMigrationStorage(deps,"owner")};
}
it("keeps all disk identities until asynchronous erasure completes and preserves original claim identity",async()=>{
 const h=fixture();h.deps.removeStoppedHome.mockResolvedValueOnce(false);
 expect(await h.run()).toBe(false);expect(h.owner.provisioning.homeErasure).toHaveLength(2);
 expect(h.deps.removeStoppedHome).toHaveBeenLastCalledWith("owner",h.source);
 expect(await h.run()).toBe(false);expect(h.owner.provisioning.homeErasure).toHaveLength(1);
 expect(await h.run()).toBe(false);expect(h.owner.provisioning.homeErasure).toEqual([]);
 expect(await h.run()).toBe(true);expect(h.deps.copy.abort).not.toHaveBeenCalled();
 expect(h.owner.provisioning.homeStorage).toEqual(FieldValue.delete());
});
it("cleans unadopted helpers before touching tracked homes and retains the queue on failure",async()=>{
 const h=fixture();h.owner.provisioning.homeMigration.phase="copying";h.deps.copy.abort.mockResolvedValueOnce(false);
 expect(await h.run()).toBe(false);expect(h.deps.removeStoppedHome).not.toHaveBeenCalled();
 h.deps.removeStoppedHome.mockRejectedValueOnce(new Error("disk ownership changed"));
 await expect(h.run()).rejects.toThrow(/ownership/);
 expect(h.owner.provisioning.homeErasure[0]).toEqual(h.source);
});
