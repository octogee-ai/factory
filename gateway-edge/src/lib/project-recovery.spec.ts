import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commitLocalProjectAsset } from "./project-blob-edit.js";
import type { FileTarget } from "./fileTarget.js";
import { persistBuilderProjects } from "./project-persistence.js";
import { commitAndPushWorkspace, gitStatus, resolveProjectDir } from "./workspace-git.js";
import { divertWorktreeBinaries } from "./binary-diversion.js";
import { createBrokeredProjectBlobHydrator } from "@octogee/core/project-blob-materialization";
import { writeProjectRestoreReady } from "@octogee/core/project-asset-state";
let root: string;
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();if(root)await rm(root,{recursive:true,force:true});});
function git(cwd: string,...args: string[]){return execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();}
it("restores text and the matching immutable asset after losing the working set, including an older commit",async()=>{
  root=await mkdtemp(path.join(tmpdir(),"project-recovery-"));
  const customers=path.join(root,"customers"),projects=path.join(customers,"alice/projects"),dir=path.join(projects,"demo"),remote=path.join(root,"remote.git");
  await mkdir(dir,{recursive:true});
  await writeProjectRestoreReady(dir,"alice","demo");
  git(root,"init","--bare","--initial-branch=main",remote);
  git(dir,"init","--initial-branch=main");git(dir,"config","user.name","Fixture");git(dir,"config","user.email","fixture@example.test");
  await writeFile(path.join(dir,"README.md"),"initial\n");git(dir,"add",".");git(dir,"commit","-m","initial");git(dir,"remote","add","origin",remote);git(dir,"push","-u","origin","main");
  const transport=path.join(root,"test-ssh");
  await writeFile(transport,"#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");await chmod(transport,0o755);
  git(dir,"remote","set-url","origin",`ssh://git@localhost${remote}`);vi.stubEnv("GIT_SSH",transport);
  const objects=new Map<string,Buffer>();
  const store=vi.fn(async(target:any,_name:string,body:Buffer)=>{
    const sha256=createHash("sha256").update(body).digest("hex");objects.set(sha256,Buffer.from(body));
    return {sha256,size:body.length,gcsPath:`${target.gcsPrefix}/.objects/${sha256}`};
  });
  const deps={resolveProject:resolveProjectDir,commit:commitAndPushWorkspace,githubToken:async()=>undefined,
    divert:(cwd:string,target:any)=>divertWorktreeBinaries(cwd,target,{gitStatus,storeWorkspaceBlob:store},{retainLocalFiles:true})};
  const versions=[];
  for(const n of [1,2]){
    const body=Buffer.from([0,1,2,n]);await writeFile(path.join(dir,"asset.bin"),body);await writeFile(path.join(dir,"README.md"),`revision ${n}\n`);
    expect(await persistBuilderProjects({root:customers,slug:"alice"},deps)).toEqual({projects:1});
    for (let save = 0; save < 2; save++) {
      const head = git(dir,"rev-parse","HEAD");
      const uploads = store.mock.calls.length;
      expect(await persistBuilderProjects({root:customers,slug:"alice"},deps)).toEqual({projects:1});
      expect(git(dir,"ls-files")).not.toContain("asset.bin");
      expect(git(dir,"rev-parse","HEAD")).toBe(head);
      expect(store).toHaveBeenCalledTimes(uploads);
    }
    expect(await readFile(path.join(dir,"asset.bin"))).toEqual(body);
    const sha=git(dir,"rev-parse","HEAD");
    expect(git(root,"--git-dir",remote,"rev-parse","refs/heads/main")).toBe(sha);
    expect(git(dir,"ls-files")).not.toContain("asset.bin");
    expect(git(dir,"ls-files")).toContain(".files/manifest.json");
    versions.push({sha,body,n});
  }
  expect(objects.size).toBe(2);
  const target: FileTarget = {slug:"alice",projectSlug:"demo",provider:"gitea",org:"octogee-alice",repoName:"alice-demo",gcsPrefix:"customers/alice/projects/demo",sudoUser:"ws-alice"};
  const uploaded = Buffer.from([0,7,8,9]);
  await commitLocalProjectAsset({target,dir,name:"asset.bin",contents:uploaded,upload:()=>store(target,"asset.bin",uploaded),mimeType:"application/custom",divert:deps.divert});
  expect(await readFile(path.join(dir,"asset.bin"))).toEqual(uploaded);
  expect(JSON.parse(await readFile(path.join(dir,".files/manifest.json"),"utf8"))["asset.bin"].mimeType).toBe("application/custom");
  expect(git(root,"--git-dir",remote,"rev-parse","refs/heads/main")).toBe(git(dir,"rev-parse","HEAD"));
  await commitLocalProjectAsset({target,dir,name:"asset.bin",contents:null,upload:async()=>{throw new Error("deletion must not upload");},divert:deps.divert});
  await expect(readFile(path.join(dir,"asset.bin"))).rejects.toMatchObject({code:"ENOENT"});
  await writeFile(path.join(dir,"asset.bin"),versions[1].body);
  await persistBuilderProjects({root:customers,slug:"alice"},deps);
  await rm(path.join(dir, "asset.bin"));
  await persistBuilderProjects({root:customers,slug:"alice"},deps);
  expect(JSON.parse(await readFile(path.join(dir,".files/manifest.json"),"utf8"))).toEqual({});
  const deleted = git(dir,"rev-parse","HEAD");
  const manifestRead=vi.fn(async()=>{throw new Error("committed manifest must be authoritative");});
  const hydrate=createBrokeredProjectBlobHydrator({workspaceManifestReadUrl:manifestRead,blobMaterializationReadUrl:async(input:any)=>{
    const body=objects.get(input.sha256);if(!body)throw new Error("missing immutable object");
    // eslint-disable-next-line sonarjs/hashing -- emulates the GCS transport checksum
    return {generation:"1",size:body.length,md5Hash:createHash("md5").update(body).digest("base64"),download:{url:`https://objects.test/${input.sha256}`,method:"GET",gcsPath:`customers/alice/projects/demo/.objects/${input.sha256}`,expiresAt:"later"}};
  }});
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>new Response(new Uint8Array(objects.get(new URL(url).pathname.slice(1))!),{headers:{"x-goog-generation":"1"}})));
  await rm(dir,{recursive:true});git(root,"clone",remote,dir);
  expect(git(dir,"rev-parse","HEAD")).toBe(deleted);
  expect(await hydrate({slug:"alice",project:"demo",destination:dir,maxBytes:1024})).toMatchObject({files:0,bytes:0});
  await expect(readFile(path.join(dir,"asset.bin"))).rejects.toMatchObject({code:"ENOENT"});
  for(const version of versions.reverse()){
    await rm(dir,{recursive:true});git(root,"clone",remote,dir);git(dir,"checkout","--detach",version.sha);
    expect(await hydrate({slug:"alice",project:"demo",destination:dir,maxBytes:1024})).toMatchObject({files:1,bytes:4});
    expect(await readFile(path.join(dir,"asset.bin"))).toEqual(version.body);
    expect(await readFile(path.join(dir,"README.md"),"utf8")).toBe(`revision ${version.n}\n`);
  }
  expect(manifestRead).not.toHaveBeenCalled();
});
