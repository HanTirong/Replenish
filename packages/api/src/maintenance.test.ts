import {randomUUID} from "node:crypto";
import type {AddressInfo} from "node:net";
import {describe,expect,it,vi} from "vitest";
import {SqliteDatabase} from "./db";
import {HouseholdApp} from "./service";
import {createApiServer} from "./http";

describe("maintenance reorder authorization",()=>{
  it("fails closed without configuration and rejects absent, wrong or URL/body credentials without creating orders",async()=>{
    const token=randomUUID(), charge=vi.fn(async()=>({paymentId:"simulated"}));
    for(const configured of [undefined,token]){
      const db=new SqliteDatabase(":memory:");
      const app=new HouseholdApp({db,env:{},payments:{charge,query:async()=>"not_found"}});
      const server=createApiServer(app,{maintenanceToken:configured});
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try{
        const calls:RequestInit[]=[{}, {headers:{authorization:`Bearer ${randomUUID()}`}},
          {headers:{"content-type":"application/json","x-forwarded-for":"127.0.0.1"},body:JSON.stringify({token})}];
        if(!configured)calls.push({headers:{authorization:`Bearer ${token}`}});
        for(const init of calls){
          const response=await fetch(`${origin}/v1/demo/reorder-now?token=${encodeURIComponent(token)}`,{method:"POST",...init});
          expect(response.status).toBe(403);
          expect(await response.text()).not.toContain(token);
          expect(db.get<{count:number}>("SELECT COUNT(*) AS count FROM orders")?.count).toBe(0);
        }
        if(configured){
          const response=await fetch(`${origin}/v1/demo/reorder-now`,{method:"POST",headers:{authorization:`Bearer ${token}`}});
          expect(response.status).toBe(200);
          expect(db.get<{count:number}>("SELECT COUNT(*) AS count FROM orders")?.count).toBe(1);
        }
        expect(charge).not.toHaveBeenCalled();
      }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
    }
  });
});

describe("maintenance reset authorization",()=>{
  it.each([false,true])("rejects unauthorized reset (full=%s) without changing data or the vault",async(full)=>{
    const token=randomUUID();
    for(const configured of [undefined,"short",token]){
      const db=new SqliteDatabase(":memory:"), clear=vi.fn();
      const charge=vi.fn(async()=>({paymentId:"simulated"}));
      const app=new HouseholdApp({db,env:{},payments:{charge,query:async()=>"not_found"},vault:{hasPaymentToken:()=>true,clear}});
      app.pause();
      const before=db.all("SELECT * FROM activities"), reset=vi.spyOn(app,"resetDemo");
      const server=createApiServer(app,{maintenanceToken:configured});
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try{
        const calls:RequestInit[]=[{}, {headers:{authorization:`Bearer ${randomUUID()}`}},
          {headers:{"content-type":"application/json","x-forwarded-for":"127.0.0.1"},body:JSON.stringify({token})}];
        if(configured!==token)calls.push({headers:{authorization:`Bearer ${token}`}});
        for(const init of calls){
          const response=await fetch(`${origin}/v1/demo/reset?full=${full?"1":"0"}&token=${encodeURIComponent(token)}`,{method:"POST",...init});
          expect(response.status).toBe(403);
          expect(await response.text()).not.toContain(token);
          expect(app.home().autopilot).toBe("paused");
          expect(db.all("SELECT * FROM activities")).toEqual(before);
          expect(reset).not.toHaveBeenCalled();
          expect(clear).not.toHaveBeenCalled();
        }
        if(configured===token){
          const response=await fetch(`${origin}/v1/demo/reset${full?"?full=1":""}`,{method:"POST",headers:{authorization:`Bearer ${token}`}});
          expect(response.status).toBe(200);
          expect(reset).toHaveBeenCalledExactlyOnceWith(full);
          expect(app.home().autopilot).toBe("active");
          expect(clear).toHaveBeenCalledTimes(full?1:0);
        }
        expect(charge).not.toHaveBeenCalled();
      }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
    }
  });
});
